import { fail, map } from './tabel-access.mjs';
import { serviceActor } from './service-command.mjs';
import { readAuthority } from './authority.mjs';
import { applyReplicaDocument, normalizeReplicaOperation } from './replica-materialize.mjs';

// Минутная репликация «основная Firebase -> резерв Ubuntu» и обратное чтение
// журнала для восстановления. Журнал хранит только изменённые операции,
// назначает строгую последовательность и не создаёт дубликатов при повторе.
const WS = () => process.env.WORKSPACE_ID || 'main_workspace';
const MAX_OPERATIONS = 500;
const MAX_PAYLOAD_BYTES = 262144;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{8,160}$/;

// §4.10 parent policy: objects/users → shift/trucks → truckStatus/logs. A batch
// is materialized in this order regardless of arrival order; journal-only events
// touch neither heads nor canonical rows, so they are written last. The sort in
// appendReplicaBatch is stable, so repeated operations on one document keep
// their arrival order and the head CAS still decides the generation.
const MATERIALIZE_RANK = { objects: 0, users: 0, shift: 1, trucks: 1, truckStatus: 2, logs: 2 };
const materializeRank = normalized => (normalized.materializable
  ? MATERIALIZE_RANK[normalized.collection] ?? 3
  : 3);

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
    // 026 хранит protocol/hash version рядом с immutable stream row, поэтому
    // duplicate-сравнение учитывает версию: v1 и v2 с одним id всегда конфликт.
    const supportsV2 = Boolean((await client.query(
      "SELECT to_regclass('public.replica_document_heads') AS relation",
    )).rows[0].relation);
    const known = new Map((await client.query(
      supportsV2
        ? `SELECT operation_id, sha256, protocol_version, hash_version, kind
             FROM replica_stream WHERE workspace_id=$1 AND direction=$2`
        : `SELECT operation_id, sha256, kind
             FROM replica_stream WHERE workspace_id=$1 AND direction=$2`,
      [ws, 'f2s']
    )).rows.map(r => [r.operation_id, r]));
    const fresh = [];
    const inBatch = new Map();
    for (const operation of operations) {
      if (!map(operation) || !OPERATION_ID.test(String(operation.id || ''))) throw fail('invalid-replica-operation');
      const normalized = normalizeReplicaOperation(operation);
      const payloadText = normalized.protocolVersion === 1
        ? (operation.payload === undefined ? null : JSON.stringify(operation.payload))
        : JSON.stringify(normalized.payload);
      if (Buffer.byteLength(payloadText ?? 'null') > MAX_PAYLOAD_BYTES) throw fail('replica-payload-too-large', 413);
      const identity = `${normalized.protocolVersion}:${normalized.kind}:${normalized.hash}`;
      const prior = known.get(operation.id);
      if (prior) {
        // Тот же id с другим содержимым/версией — не повтор, а конфликт.
        // До 026 в строке нет версий: сравниваем только kind и sha256, ровно
        // как старый журнал.
        const sameEnvelope = supportsV2
          ? Number(prior.protocol_version) === normalized.protocolVersion
            && Number(prior.hash_version) === normalized.hashVersion
            && prior.kind === normalized.kind
            && prior.sha256 === normalized.hash
          : prior.kind === normalized.kind && prior.sha256 === normalized.hash;
        if (!sameEnvelope) throw fail('replica-operation-conflict', 409);
        continue;
      }
      const duplicate = inBatch.get(operation.id);
      if (duplicate) {
        if (duplicate.identity !== identity) throw fail('replica-operation-conflict', 409);
        continue;
      }
      const entry = {
        id: operation.id,
        kind: normalized.kind,
        hash: normalized.hash,
        protocolVersion: normalized.protocolVersion,
        hashVersion: normalized.hashVersion,
        normalized,
        identity,
        payloadText,
      };
      inBatch.set(operation.id, entry);
      fresh.push(entry);
    }
    if (fresh.length === 0) {
      await client.query('COMMIT');
      return { format: 'samosval-replica', version: 1, outcome: 'confirmed', direction: 'f2s', applied: 0, received: operations.length, seq };
    }
    // Пропуск в последовательности блокирует применение до восстановления.
    if (seq !== baseSeq) throw fail('replica-sequence-gap', 409);
    let applied = 0, materialized = 0;
    // The immutable stream keeps arrival order: each fresh operation gets the
    // sequence of its position in the batch. Only materialization is reordered,
    // so a parent that shares the batch with its child is already written.
    const ordered = fresh
      .map((entry, index) => ({ entry, seq: seq + index + 1 }))
      .sort((left, right) => materializeRank(left.entry.normalized) - materializeRank(right.entry.normalized));
    seq += fresh.length;
    for (const { entry: operation, seq: operationSeq } of ordered) {
      // Нормативный порядок §4.10: сначала immutable stream row (head FK
      // ссылается на неё), затем head CAS, canonical/pending, cursor последним.
      // Обе записи в одной транзакции, поэтому резерв не может подтвердить
      // операцию, которую не применил.
      if (supportsV2) {
        await client.query(
          `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256,protocol_version,hash_version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ws, operationSeq, 'f2s', operation.id, operation.kind, operation.payloadText, operation.hash,
            operation.protocolVersion, operation.hashVersion]
        );
      } else {
        await client.query(
          'INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [ws, operationSeq, 'f2s', operation.id, operation.kind, operation.payloadText, operation.hash]
        );
      }
      if (await applyReplicaDocument(client, ws, operation.normalized, {
        seq: operationSeq, normalized: operation.normalized,
      })) materialized += 1;
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