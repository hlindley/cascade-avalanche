// Leaderboard store for the web rallycross (10 October 2026, leaderboard slice 1): Cloudflare Pages Functions on a D1
// database bound as DB. Each entry is the lap itself (laprec.js's awd-rallycross-lap/1 record: every tick's inputs), so
// anyone can watch it replayed by the physics. Boards are per physics version (build.json "physics"), car revision,
// preset and start (standing: lap 1 from the line; flying: any other lap), because a physics change makes old laps
// replay differently. The server checks the record's shape and limits, not the time itself: entries are marked
// "browser" (the submitting page replayed the lap and got the same time). Server-side replay checks come later.
// No personal data is kept: a nickname, a random player id from the browser, and a salted hash of the address for
// rate limits.

export const LIMITS = { bodyBytes: 512 * 1024, ticks: 30000, events: 2000, perHour: 30, list: 100 };
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS laps (id TEXT PRIMARY KEY, board TEXT NOT NULL, player TEXT NOT NULL, nickname TEXT NOT NULL,
    lap_ms INTEGER NOT NULL, lap_s REAL NOT NULL, sectors TEXT NOT NULL, config TEXT NOT NULL, device TEXT NOT NULL, build TEXT NOT NULL,
    recorded_utc TEXT NOT NULL, submitted_utc TEXT NOT NULL, ip_hash TEXT NOT NULL, checked TEXT NOT NULL, bytes INTEGER NOT NULL, lap_json TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS laps_board ON laps (board, lap_ms)',
  'CREATE INDEX IF NOT EXISTS laps_ip ON laps (ip_hash, submitted_utc)',
  'CREATE UNIQUE INDEX IF NOT EXISTS laps_once ON laps (player, recorded_utc, lap_ms)',
];
let schemaReady = false;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export const fail = (status, error) => json({ error }, status);

// The database, with the table created on first use (so deploying needs no separate migration step).
export async function database(env) {
  if (!env || !env.DB) return null;
  if (!schemaReady) { await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))); schemaReady = true; }
  return env.DB;
}

export const BOARD_RE = /^[0-9a-f]{16}\|5\.[13]\|[012]\|(standing|flying)$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const str = (v, max) => typeof v === 'string' && v.length <= max;

export function cleanNickname(v) {
  if (typeof v !== 'string') return null;
  const n = v.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N} _.'-]{2,20}$/u.test(n) ? n : null;
}

// Checks a submitted lap record and returns { lap (only the known fields), board } or { error }.
export function checkLap(l) {
  if (!l || typeof l !== 'object') return { error: 'no lap' };
  if (l.format !== 'awd-rallycross-lap/1') return { error: 'not an awd-rallycross-lap/1 record' };
  if (l.clean !== true) return { error: 'only counted laps can be submitted' };
  if (l.exactInputs !== true) return { error: 'the lap was not driven with recorded inputs' };
  if (!str(l.physics, 16) || !/^[0-9a-f]{16}$/.test(l.physics)) return { error: 'the lap has no physics version (recorded by an older build): drive a new one' };
  if (!['5.1', '5.3'].includes(l.revision) || !int(l.preset, 0, 2)) return { error: 'unknown car' };
  if (!num(l.lapS, 10, 600)) return { error: 'lap time out of range' };
  if (!Array.isArray(l.sectors) || l.sectors.length < 1 || l.sectors.length > 8 || !l.sectors.every(v => num(v, .5, 600))) return { error: 'bad sector times' };
  if (Math.abs(l.sectors.reduce((a, b) => a + b, 0) - l.lapS) > .01) return { error: 'sector times do not add up to the lap time' };
  if (!int(l.lapNumber, 1, 500) || !str(l.utc, 40) || Number.isNaN(Date.parse(l.utc)) || !str(l.config, 120)) return { error: 'bad lap fields' };
  const r = l.run;
  if (!r || !['start', 'track'].includes(r.kind) || !Array.isArray(r.start) || r.start.length !== 7 || !r.start.every(v => num(v, -1e5, 1e5))) return { error: 'bad run start' };
  if (r.setup != null && (!Array.isArray(r.setup) || r.setup.length !== 4 || !r.setup.every(v => num(v, -1, 1e5)))) return { error: 'bad setup' };
  if (!int(r.ticks, 1, LIMITS.ticks)) return { error: `runs longer than ${LIMITS.ticks / 6000} minutes can't be submitted yet: restart and drive a shorter run` };
  if (!int(r.lapStartTick, 0, r.ticks)) return { error: 'bad lap start' };
  const inp = l.inputs;
  if (!inp || inp.ticks !== r.ticks || !str(inp.data, LIMITS.bodyBytes) || !B64_RE.test(inp.data) || inp.data.length !== 4 * Math.ceil(r.ticks * 8 / 3)) return { error: 'inputs do not match the run' };
  if (!Array.isArray(l.events) || l.events.length > LIMITS.events) return { error: 'bad events' };
  for (const e of l.events) if (!Array.isArray(e) || e.length !== 3 || !int(e[0], 0, r.ticks) || !/^(shift|automatic|reverse|setup:[0-3])$/.test(e[1]) || !num(e[2], -1e5, 1e5)) return { error: 'bad event' };
  const t = l.trace && typeof l.trace === 'object' && str(l.trace.data, 200000) && B64_RE.test(l.trace.data) && int(l.trace.everyTicks, 1, 1000) && int(l.trace.fromTick, 0, r.ticks)
    ? { everyTicks: l.trace.everyTicks, fromTick: l.trace.fromTick, encoding: 'base64 float32le (x, z, speed)', data: l.trace.data } : null;
  const lap = {
    format: l.format, utc: l.utc, build: str(l.build, 40) ? l.build : '', physics: l.physics, course: str(l.course, 80) ? l.course : '',
    device: ['Keyboard', 'Gamepad', 'Touch', 'test'].includes(l.device) ? l.device : 'unknown', standingStartMode: l.standingStartMode === true,
    revision: l.revision, preset: l.preset, config: l.config, lapS: l.lapS, sectors: l.sectors, clean: true, lapNumber: l.lapNumber, exactInputs: true,
    run: { kind: r.kind, utc: str(r.utc, 40) ? r.utc : l.utc, automaticAtStart: r.automaticAtStart !== false, start: r.start, setup: r.setup || [-1, -1, -1, -1], ticks: r.ticks, lapStartTick: r.lapStartTick },
    events: l.events, inputs: { encoding: 'base64 int16le x4 per tick (steer, throttle, brake, handbrake) / 2000', ticks: inp.ticks, data: inp.data }, trace: t,
  };
  const category = r.kind === 'start' && l.lapNumber === 1 && r.lapStartTick === 0 ? 'standing' : 'flying';
  return { lap, board: `${l.physics}|${l.revision}|${l.preset}|${category}` };
}

export async function addressHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local', salt = (env && env.LEADERBOARD_SALT) || 'awd-rallycross-leaderboard';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + ip));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(9)); return [...b].map(v => v.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

export function entryOf(row, rank) {
  return { id: row.id, rank, nickname: row.nickname, lapS: row.lap_s, sectors: JSON.parse(row.sectors), config: row.config, device: row.device,
    recorded: row.recorded_utc, submitted: row.submitted_utc, checked: row.checked, player: row.player.slice(0, 8) };
}
