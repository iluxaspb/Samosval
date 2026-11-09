import {fail, map} from './tabel-access.mjs';
import {serviceActor} from './service-command.mjs';

export const AUTHORITY_PROVIDERS = ['ubuntu', 'firebase'];
const WS = () => process.env.WORKSPACE_ID || 'main_workspace';

// The generation is the single source of truth for "who may write now".
// A switch is a monotonic increment, so a phone that cached generation N can
// never be mistaken for a phone that is current after the switch to N+1.
function view(row) {
  return {
    provider: row.provider,
    generation: Number(row.generation),
    reason: row.reason || '',
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    updatedBy: row.updated_by || null
  };
}

export async function readAuthority(client, ws = WS()) {
  const row = (await client.query(
    'SELECT provider,generation,reason,updated_at,updated_by FROM server_authority WHERE workspace_id=$1', [ws]
  )).rows[0];
  if (!row) throw fail('authority-missing', 503);
  return view(row);
}

// Enforced on every authenticated application write. Reads stay open so a
// phone can always show what it already has, even while it may not write.
export async function assertWriteAuthority(pool, req) {
  const authority = await readAuthority(pool);
  if (authority.provider !== 'ubuntu') throw fail('not-authoritative', 409);
  const sent = req.headers['x-samosval-generation'];
  if (sent === undefined) return authority;
  if (!/^\d+$/.test(String(sent))) throw fail('invalid-authority-generation', 400);
  // 0 means "this phone has not read the session yet". The provider check above
  // is the real lock; the generation only catches a phone that lags after a
  // switch it has already seen.
  if (Number(sent) === 0) return authority;
  if (Number(sent) !== authority.generation) throw fail('authority-generation-mismatch', 409);
  return authority;
}

export async function readAuthorityState(pool, uid, ws = WS()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await serviceActor(client, uid, null, {admin: false, lock: false});
    const authority = await readAuthority(client, ws);
    const phones = (await client.query(
      "SELECT count(*)::int AS seen, max(last_seen) AS last FROM server_presence WHERE workspace_id=$1 AND actor_type='phone' AND last_seen > now() - interval '5 minutes'", [ws]
    )).rows[0];
    const events = (await client.query(
      'SELECT generation,provider,previous_provider,reason,uid,created_at FROM server_authority_events WHERE workspace_id=$1 ORDER BY generation DESC LIMIT 20', [ws]
    )).rows.map(r => ({generation: Number(r.generation), provider: r.provider, previous: r.previous_provider, reason: r.reason, uid: r.uid, at: new Date(r.created_at).getTime()}));
    await client.query('COMMIT');
    return {format: 'samosval-authority', version: 1, source: 'ubuntu', workspaceId: ws, readAt: Date.now(), authority, presence: {phones: phones.seen, lastSeen: phones.last ? new Date(phones.last).getTime() : null}, events};
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

export function normalizeAuthorityCommand(input) {
  if (!map(input)) throw fail('invalid-authority-command');
  const {provider, expectedGeneration, reason} = input;
  if (!AUTHORITY_PROVIDERS.includes(provider)) throw fail('invalid-authority-provider');
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw fail('invalid-authority-generation');
  if (typeof reason !== 'string' || reason.length < 3 || reason.length > 500) throw fail('invalid-authority-reason');
  return {provider, expectedGeneration, reason};
}

// Manual switch by an active administrator. Optimistic concurrency on the
// generation prevents two admins from switching at the same time.
export async function switchAuthority(pool, uid, input, ws = WS()) {
  const command = normalizeAuthorityCommand(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await serviceActor(client, uid, null, {admin: true});
    await client.query("SELECT pg_advisory_xact_lock(hashtext('samosval-authority'))");
    const row = (await client.query(
      'SELECT provider,generation,reason,updated_at,updated_by FROM server_authority WHERE workspace_id=$1 FOR UPDATE', [ws]
    )).rows[0];
    if (!row) throw fail('authority-missing', 503);
    if (Number(row.generation) !== command.expectedGeneration) throw fail('authority-generation-conflict', 409);
    if (row.provider === command.provider) {
      await client.query('COMMIT');
      return {outcome: 'confirmed', changed: false, authority: view(row)};
    }
    const next = Number(row.generation) + 1;
    const updated = (await client.query(
      'UPDATE server_authority SET provider=$2,generation=$3,reason=$4,updated_by=$5,updated_at=now() WHERE workspace_id=$1 RETURNING provider,generation,reason,updated_at,updated_by',
      [ws, command.provider, next, command.reason, uid]
    )).rows[0];
    await client.query(
      'INSERT INTO server_authority_events(workspace_id,generation,provider,previous_provider,reason,uid) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [ws, next, command.provider, row.provider, command.reason, uid]
    );
    await client.query('COMMIT');
    return {outcome: 'confirmed', changed: true, authority: view(updated)};
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// Phones announce themselves. The pulse is what proves a server is really dead
// rather than one operator losing coverage.
export async function touchPresence(pool, uid, input, ws = WS()) {
  if (!map(input) || !['ubuntu', 'firebase'].includes(input.provider)) throw fail('invalid-presence');
  const generation = Number.isSafeInteger(input.generation) ? input.generation : 0;
  await pool.query(
    `INSERT INTO server_presence(workspace_id,actor_type,actor_id,provider,generation,last_seen)
     VALUES ($1,'phone',$2,$3,$4,now())
     ON CONFLICT (workspace_id,actor_type,actor_id)
     DO UPDATE SET provider=EXCLUDED.provider,generation=EXCLUDED.generation,last_seen=now()`,
    [ws, uid, input.provider, generation]
  );
  const row = (await pool.query(
    "SELECT count(*)::int AS seen FROM server_presence WHERE workspace_id=$1 AND actor_type='phone' AND last_seen > now() - interval '5 minutes'", [ws]
  )).rows[0];
  return {outcome: 'confirmed', phones: row.seen};
}
