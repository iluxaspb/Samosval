import { createHash } from 'node:crypto';
import { fail, map } from './tabel-access.mjs';
import { serviceActor } from './service-command.mjs';
import { readAuthority } from './authority.mjs';
import { applyReplicaDocument } from './replica-materialize.mjs';

// Минутная репликация «основная Firebase -> резерв Ubuntu» и обратное чтение
// журнала для восстановления. Журнал хранит только изменённые операции,
// назначает строгую последовательность и не создаёт дубликатов при повторе.
const WS = () => process.env.WORKSPACE_ID || 'main_workspace';
const MAX_OPERATIONS = 500;
const MAX_PAYLOAD_BYTES = 262144;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{8,160}$/;

const digest = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

// Применение пачки изменений Firebase -> Ubuntu.
// Разрешено ТОЛЬКО пока владелец записи — Firebase: если Ubuntu объявлена
// владельцем, резерв не принимает зеркало, иначе базы разойдутся.
export async function appendReplicaBatch(pool, uid, input, ws = WS()) {
  if (!map(input)) throw fail('invalid-replica-batch');
  if (input.direction !== undefined && input.direction !== 'f2s') throw fail('invalid-replica-direction');
  const baseSeq = input.baseSeq;
  if (!Number.isSafeInteger(baseSeq) || baseSeq < 0) throw fail('invalid-replica-base');
  const operations = input.operations;
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) throw fail('invalid-replica-operations');
  if (operations.length === 0) {
    return { format: 'samosval-replica', version: 1, outcome: 'idle', direction: 'f2s', applied: 0, received: 0, seq: baseSeq };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await serviceActor(client, uid, null, { admin: false, lock: false });
    const authority = await readAuthority(client, ws);
    // Защита от двух активных серверов: резерв не пишет, когда он владелец.
    if (authority.provider !== 'firebase') throw fail('replica-reserve-is-owner', 409);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['replica:' + ws + ':f2s']);
    const row = (await client.query(
      'SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1 FOR UPDATE', [ws]
    )).rows[0];
    if (!row) throw fail('replica-cursor-missing', 503);
    let seq = Number(row.f2s_seq);
    // Сначала отбрасываем уже применённые операции: повтор всей пачки — это
    // успешная идемпотентная повторная отправка, а не пропуск. Пропуск
    // проверяется только для действительно новых операций.
    const known = new Map((await client.query(
      'SELECT operation_id, sha256 FROM replica_stream WHERE workspace_id=$1 AND direction=$2', [ws, 'f2s']
    )).rows.map(r => [r.operation_id, r.sha256]));
    const fresh = [];
    for (const operation of operations) {
      if (!map(operation) || !OPERATION_ID.test(String(operation.id || ''))) throw fail('invalid-replica-operation');
      if (typeof operation.kind !== 'string' || !operation.kind || operation.kind.length > 120) throw fail('invalid-replica-kind');
      const payload = operation.payload === undefined ? null : operation.payload;
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw fail('replica-payload-too-large', 413);
      const hash = digest(payload);
      if (known.has(operation.id)) {
        // Тот же id с другим содержимым — не повтор, а конфликт.
        if (known.get(operation.id) !== hash) throw fail('replica-operation-conflict', 409);
        continue;
      }
      fresh.push({ id: operation.id, kind: operation.kind, payload, hash });
    }
    if (fresh.length === 0) {
      await client.query('COMMIT');
      return { format: 'samosval-replica', version: 1, outcome: 'confirmed', direction: 'f2s', applied: 0, received: operations.length, seq };
    }
    // Пропуск в последовательности блокирует применение до восстановления.
    if (seq !== baseSeq) throw fail('replica-sequence-gap', 409);
    let applied = 0, materialized = 0;
    for (const operation of fresh) {
      // Сначала данные, затем журнал: обе записи в одной транзакции, поэтому
      // резерв не может подтвердить операцию, которую не применил.
      if (await applyReplicaDocument(client, ws, operation)) materialized += 1;
      seq += 1;
      await client.query(
        'INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [ws, seq, 'f2s', operation.id, operation.kind, JSON.stringify(operation.payload), operation.hash]
      );
      applied += 1;
    }
    if (applied > 0) {
      await client.query('UPDATE replica_cursor SET f2s_seq=$2, updated_at=now() WHERE workspace_id=$1', [ws, seq]);
    }
    await client.query('COMMIT');
    return { format: 'samosval-replica', version: 1, outcome: 'confirmed', direction: 'f2s', applied, received: operations.length, seq };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Чтение журнала резерва для обратной синхронизации Ubuntu -> Firebase.
// Курсор не двигается: он фиксирует подтверждённое применение на клиенте.
export async function readReplicaJournal(pool, uid, query = {}, ws = WS()) {
  const since = query.since === undefined ? 0 : Number(query.since);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isSafeInteger(since) || since < 0) throw fail('invalid-replica-since');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw fail('invalid-replica-limit');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await serviceActor(client, uid, null, { admin: false, lock: false });
    const cursor = (await client.query('SELECT s2f_seq FROM replica_cursor WHERE workspace_id=$1', [ws])).rows[0];
    const items = (await client.query(
      'SELECT seq,direction,operation_id,kind,payload,sha256,recorded_at FROM replica_stream WHERE workspace_id=$1 AND direction=$2 AND seq>$3 ORDER BY seq LIMIT $4',
      [ws, 's2f', since, limit]
    )).rows.map(r => ({
      seq: Number(r.seq), operationId: r.operation_id, kind: r.kind, payload: r.payload,
      sha256: r.sha256, at: new Date(r.recorded_at).getTime()
    }));
    // Признак разрыва: клиент пропустил операции и не должен считать себя в синхроне.
    const head = Number(cursor?.s2f_seq || 0);
    const contiguous = items.every((item, index) => item.seq === since + index + 1);
    await client.query('COMMIT');
    return { format: 'samosval-replica-journal', version: 1, source: 'ubuntu', workspaceId: ws, since, head, contiguous, items };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}