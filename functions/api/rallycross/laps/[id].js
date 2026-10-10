// GET /api/rallycross/laps/ID -> { entry, lap }: one leaderboard entry and its recorded lap, to replay.
import { json, fail, database, entryOf } from '../_leaderboard.js';

export async function onRequestGet({ params, env }) {
  const db = await database(env); if (!db) return fail(503, 'no leaderboard database is bound to this site');
  const id = String(params.id || ''); if (!/^[0-9a-z]{6,20}$/.test(id)) return fail(400, 'bad id');
  const row = await db.prepare('SELECT * FROM laps WHERE id = ?1').bind(id).first();
  if (!row) return fail(404, 'no such lap');
  return json({ entry: { ...entryOf(row, null), board: row.board }, lap: JSON.parse(row.lap_json) });
}
