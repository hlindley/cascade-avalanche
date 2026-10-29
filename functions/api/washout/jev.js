// POST /api/washout/jev: the Washout prompt box's relay to Jev, TypeSafe's System One API, as a Cloudflare Pages Function.
// The key is the project's TYPESAFE_API_KEY secret (Settings > Variables and Secrets); JEV_MODEL may name another model.
// web/washout/jev-relay.mjs runs the same code on a computer; web/washout/deploy-cloudflare.sh puts this file in place.

// Only what the prompt box sends goes through: the player's words as the state and short choice or yes/no questions.
// Anything else is refused, so the relay is no general door to the key.
export function checkJevRequest(body) {
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  if (!body || typeof body !== 'object' || !body.state || !str(body.state.request, 300) || !body.state.request.trim()) return 'state.request must be 1-300 characters';
  if (Object.keys(body.state).length !== 1) return 'state may only hold request';
  const qs = body.questions;
  if (!qs || typeof qs !== 'object' || !Object.keys(qs).length || Object.keys(qs).length > 40) return 'questions must hold 1-40 questions';
  for (const [id, q] of Object.entries(qs)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id) || !q || !str(q.instructions, 400)) return `question ${id}: bad id or instructions`;
    if (q.type === 'noul') { if (Object.keys(q).length !== 2) return `question ${id}: unexpected fields`; continue; }
    if (q.type !== 'choice' || Object.keys(q).length !== 3 || !q.criteria || typeof q.criteria !== 'object') return `question ${id}: only choice and noul`;
    const cs = Object.entries(q.criteria);
    if (cs.length < 2 || cs.length > 10 || !cs.every(([k, d]) => /^[a-z_]{1,24}$/.test(k) && str(d, 300))) return `question ${id}: bad criteria`;
  }
  return null;
}

// Per address, at most 12 requests a minute. On Cloudflare this counts per isolate, so it is a brake, not a guarantee;
// the spending limit in TypeSafe's console is the real cap.
const recent = new Map();
export function allowed(ip, now = Date.now()) {
  const times = (recent.get(ip) || []).filter(t => now - t < 60000);
  if (times.length >= 12) return false;
  times.push(now); recent.set(ip, times);
  if (recent.size > 5000) recent.clear();
  return true;
}

// One relayed request: the page's raw body in, { status, json } out (json is what the page gets back).
export async function relayJev(raw, { key, model = 'jev-latest', api = 'https://api.typesafe.ai/v1/systemone', ip = '' }) {
  if (!key) return { status: 503, json: { error: 'no_key', message: 'The relay has no TYPESAFE_API_KEY.' } };
  if (!allowed(ip)) return { status: 429, json: { error: 'rate_limited', message: 'Too many requests; wait a minute.' } };
  if (raw.length > 65536) return { status: 413, json: { error: 'too_large' } };
  let body; try { body = JSON.parse(raw); } catch { return { status: 400, json: { error: 'bad_json' } }; }
  const bad = checkJevRequest(body);
  if (bad) return { status: 400, json: { error: 'bad_request', message: bad } };
  try {
    const r = await fetch(api, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state: body.state, questions: body.questions }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error(`jev ${r.status}: ${text.slice(0, 300)}`);
      return { status: r.status === 429 || r.status === 529 ? 429 : 502, json: { error: r.status === 429 || r.status === 529 ? 'rate_limited' : 'upstream', status: r.status } };
    }
    const out = JSON.parse(text);
    console.log(`jev ${out.model}: "${body.state.request}" (${out.usage ? `${out.usage.input_tokens} in, ${out.usage.output_tokens} out` : 'no usage'})`);
    return { status: 200, json: { model: out.model, answers: out.answers } };
  } catch (e) { console.error('jev:', e.message); return { status: 502, json: { error: 'unreachable' } }; }
}

export async function onRequestPost({ request, env }) {
  const { status, json } = await relayJev(await request.text(), {
    key: env.TYPESAFE_API_KEY, model: env.JEV_MODEL || undefined, api: env.TYPESAFE_API_URL || undefined,
    ip: request.headers.get('cf-connecting-ip') || '',
  });
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
