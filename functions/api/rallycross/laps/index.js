// GET  /api/rallycross/laps?board=PHYSICS|REVISION|PRESET|standing|flying[&limit=50]
//      -> { board, players, entries: [{ id, rank, nickname, lapS, sectors, config, device, recorded, submitted, checked, player }] }
//      each player's best lap on that board, fastest first.
// POST /api/rallycross/laps  { nickname, player (32 hex, random per browser), lap (awd-rallycross-lap/1) }
//      -> { id, board, rank, best } (rank and best: this player's place and whether this lap is their best on the board)
import { LIMITS, BOARD_RE, json, fail, database, checkLap, cleanNickname, addressHash, newId, entryOf } from '../_leaderboard.js';

const BEST = `SELECT id, player, nickname, lap_s, lap_ms, sectors, config, device, recorded_utc, submitted_utc, checked FROM (
  SELECT id, player, nickname, lap_s, lap_ms, sectors, config, device, recorded_utc, submitted_utc, checked,
    ROW_NUMBER() OVER (PARTITION BY player ORDER BY lap_ms, submitted_utc) AS n FROM laps WHERE board = ?1)
  WHERE n = 1 ORDER BY lap_ms, submitted_utc LIMIT ?2`;

export async function onRequestGet({ request, env }) {
  const db = await database(env); if (!db) return fail(503, 'no leaderboard database is bound to this site');
  const url = new URL(request.url), board = url.searchParams.get('board') || '';
  if (!BOARD_RE.test(board)) return fail(400, 'bad board');
  const limit = Math.max(1, Math.min(LIMITS.list, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const [rows, count] = await db.batch([db.prepare(BEST).bind(board, limit), db.prepare('SELECT COUNT(DISTINCT player) AS players FROM laps WHERE board = ?1').bind(board)]);
  return json({ board, players: count.results[0].players, entries: rows.results.map((r, i) => entryOf(r, i + 1)) });
}

export async function onRequestPost({ request, env }) {
  const db = await database(env); if (!db) return fail(503, 'no leaderboard database is bound to this site');
  if (!/^application\/json\b/.test(request.headers.get('Content-Type') || '')) return fail(415, 'send JSON');
  if (+(request.headers.get('Content-Length') || 0) > LIMITS.bodyBytes) return fail(413, 'lap too large');
  const text = await request.text(); if (text.length > LIMITS.bodyBytes) return fail(413, 'lap too large');
  let body; try { body = JSON.parse(text); } catch { return fail(400, 'not JSON'); }
  const nickname = cleanNickname(body && body.nickname); if (!nickname) return fail(400, 'nickname: 2-20 letters, digits, spaces or _ . \' -');
  const player = body.player; if (typeof player !== 'string' || !/^[0-9a-f]{32}$/.test(player)) return fail(400, 'bad player id');
  const checked = checkLap(body.lap); if (checked.error) return fail(400, checked.error);
  const ip = await addressHash(request, env), since = new Date(Date.now() - 3600e3).toISOString();
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM laps WHERE ip_hash = ?1 AND submitted_utc > ?2').bind(ip, since).first();
  if (recent.n >= (+env.LEADERBOARD_PER_HOUR || LIMITS.perHour)) return fail(429, 'too many laps from here in the last hour; try again later');
  const { lap, board } = checked, lapJson = JSON.stringify(lap), id = newId(), lapMs = Math.round(lap.lapS * 1000), now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO laps (id, board, player, nickname, lap_ms, lap_s, sectors, config, device, build, recorded_utc, submitted_utc, ip_hash, checked, bytes, lap_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'browser', ?14, ?15)`)
      .bind(id, board, player, nickname, lapMs, lap.lapS, JSON.stringify(lap.sectors), lap.config, lap.device, lap.build, lap.utc, now, ip, lapJson.length, lapJson).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return fail(409, 'this lap is already on the board');
    throw e;
  }
  // A player's newer laps keep their nickname in step.
  await db.prepare('UPDATE laps SET nickname = ?1 WHERE player = ?2').bind(nickname, player).run();
  const mine = await db.prepare('SELECT MIN(lap_ms) AS best FROM laps WHERE board = ?1 AND player = ?2').bind(board, player).first();
  const ahead = await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT player, MIN(lap_ms) AS best FROM laps WHERE board = ?1 GROUP BY player) WHERE best < ?2`).bind(board, mine.best).first();
  return json({ id, board, rank: ahead.n + 1, best: mine.best === lapMs }, 201);
}
