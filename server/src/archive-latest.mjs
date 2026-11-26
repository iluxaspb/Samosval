// Единственный резолвер «последняя финализированная ревизия архива»
// (design §4.6 строка 243 и §5.2 строка 578).
//
// Авторитетный default pointer — только `shift_archive_series.latest_finalized_*`.
// Здесь нет и не должно быть выбора «максимальной ревизии», «самой новой строки»
// или «первой попавшейся»: если серия ещё не финализирована, default-записи нет
// (null). Явное чтение конкретной ревизии/истории — read-only и никогда не
// двигает указатель.
//
// Схема 025 аддитивна, а часть DB-тестов репозитория штатно живёт на baseline S24
// (до появления revision chain). Для этого окна `hasRevisionChain` явно
// возвращает false: ревизий не существует, и резолвер честно отдаёт null/пусто,
// а не угадывает по legacy-строкам.
import {fail} from './tabel-access.mjs';
import {validId} from './service-command.mjs';

const WS=process.env.WORKSPACE_ID||'main_workspace';
const presence=new WeakMap();

function requireWorkspace(workspaceId){
  if(!validId(workspaceId))throw fail('invalid-archive-id');
  return workspaceId;
}

function requireArchive(archiveId){
  if(!validId(archiveId))throw fail('invalid-archive-id');
  return archiveId;
}

function requireRevision(revision){
  if(!Number.isSafeInteger(revision)||revision<1)throw fail('invalid-archive-revision');
  return revision;
}

// `payload_bytes` — authoritative UTF-8 JSON bytes; парсим только для удобства
// потребителей, хеш всегда считается по самим байтам в БД.
function toRevision(row){
  const payloadBytes=Buffer.isBuffer(row.payload_bytes)?row.payload_bytes:Buffer.from(row.payload_bytes);
  return {
    archiveId:row.archive_id,
    revision:Number(row.archive_revision),
    sha256:row.payload_sha256,
    payloadBytes,
    payload:JSON.parse(payloadBytes.toString('utf8')),
    payloadSchemaVersion:Number(row.payload_schema_version),
    previousRevision:row.previous_revision==null?null:Number(row.previous_revision),
    previousSha256:row.previous_sha256??null,
    sourceKind:row.source_kind,
    sourceLocator:row.source_locator,
    createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at),
    createdByUid:row.created_by_uid,
  };
}

export async function hasRevisionChain(client){
  // Кешируем только положительный ответ: «таблицы ещё нет» (baseline S24) — это
  // дешёвая проверка, а устаревший false после применения 025 был бы опаснее.
  if(presence.get(client)===true)return true;
  const {rows}=await client.query("SELECT to_regclass('public.shift_archive_series') IS NOT NULL AS present");
  const present=rows[0]?.present===true;
  if(present)presence.set(client,true);
  return present;
}

// Все серии workspace с их catalog placement и указателем. Порядок детерминирован.
export async function listArchiveSeries(client,workspaceId=WS){
  requireWorkspace(workspaceId);
  if(!(await hasRevisionChain(client)))return [];
  const {rows}=await client.query(
    `SELECT archive_id,source_shift_id,current_location,latest_finalized_revision,
            latest_finalized_sha256,series_revision,created_at
       FROM shift_archive_series WHERE workspace_id=$1 ORDER BY archive_id COLLATE "C"`,
    [workspaceId],
  );
  return rows.map(row=>({
    archiveId:row.archive_id,
    sourceShiftId:row.source_shift_id,
    currentLocation:row.current_location,
    latestFinalizedRevision:row.latest_finalized_revision==null?null:Number(row.latest_finalized_revision),
    latestFinalizedSha256:row.latest_finalized_sha256??null,
    seriesRevision:Number(row.series_revision),
    createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at),
  }));
}

// Latest finalized: ровно указатель серии и точная ревизия по нему (FK гарантирует,
// что ревизия существует и её sha256 совпадает с указателем).
const LATEST_SELECT=`SELECT s.archive_id,s.source_shift_id,s.current_location,
            r.archive_revision,r.payload_bytes,r.payload_sha256,r.payload_schema_version,
            r.previous_revision,r.previous_sha256,r.source_kind,r.source_locator,
            r.created_at,r.created_by_uid
       FROM shift_archive_series s
       JOIN shift_archive_revisions r
         ON r.workspace_id=s.workspace_id AND r.archive_id=s.archive_id
        AND r.archive_revision=s.latest_finalized_revision
        AND r.payload_sha256=s.latest_finalized_sha256`;

function toLatest(row){
  const revision=toRevision(row);
  return {
    archiveId:row.archive_id,
    sourceShiftId:row.source_shift_id,
    currentLocation:row.current_location,
    revision:revision.revision,
    sha256:revision.sha256,
    payloadBytes:revision.payloadBytes,
    payload:revision.payload,
    payloadSchemaVersion:revision.payloadSchemaVersion,
    // Момент, когда именно эта ревизия была создана/опубликована (created_at ревизии).
    finalizedAt:revision.createdAt,
  };
}

export async function readLatestFinalizedArchive(client,workspaceId,archiveId){
  requireWorkspace(workspaceId);requireArchive(archiveId);
  if(!(await hasRevisionChain(client)))return null;
  const {rows}=await client.query(`${LATEST_SELECT} WHERE s.workspace_id=$1 AND s.archive_id=$2`,[workspaceId,archiveId]);
  return rows[0]?toLatest(rows[0]):null;
}

// То же самое для всего workspace одним запросом: список/снимок/экспорт не должны
// делать N+1 и не должны выбирать ревизию сами.
export async function listLatestFinalizedArchives(client,workspaceId=WS){
  requireWorkspace(workspaceId);
  if(!(await hasRevisionChain(client)))return [];
  const {rows}=await client.query(`${LATEST_SELECT} WHERE s.workspace_id=$1 ORDER BY s.archive_id COLLATE "C"`,[workspaceId]);
  return rows.map(toLatest);
}

// Явное чтение одной ревизии: точные байты и хеш, включая самую первую. Read-only.
export async function readArchiveRevision(client,workspaceId,archiveId,revision){
  requireWorkspace(workspaceId);requireArchive(archiveId);requireRevision(revision);
  if(!(await hasRevisionChain(client)))return null;
  const {rows}=await client.query(
    `SELECT archive_id,archive_revision,payload_bytes,payload_sha256,payload_schema_version,
            previous_revision,previous_sha256,source_kind,source_locator,created_at,created_by_uid
       FROM shift_archive_revisions
      WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=$3`,
    [workspaceId,archiveId,revision],
  );
  return rows[0]?toRevision(rows[0]):null;
}

// Метаданные всей цепочки + точные байты/хеши каждой ревизии, по возрастанию
// ревизии. Read-only: ни одной записи и ни одного сдвига latest-указателя.
export async function readArchiveHistory(client,workspaceId,archiveId){
  requireWorkspace(workspaceId);requireArchive(archiveId);
  if(!(await hasRevisionChain(client)))return null;
  const series=(await client.query(
    `SELECT archive_id,source_shift_id,current_location,latest_finalized_revision,
            latest_finalized_sha256,series_revision,created_at
       FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2`,
    [workspaceId,archiveId],
  )).rows[0];
  if(!series)return null;
  const rows=(await client.query(
    `SELECT archive_id,archive_revision,payload_bytes,payload_sha256,payload_schema_version,
            previous_revision,previous_sha256,source_kind,source_locator,created_at,created_by_uid
       FROM shift_archive_revisions
      WHERE workspace_id=$1 AND archive_id=$2
      ORDER BY archive_revision`,
    [workspaceId,archiveId],
  )).rows;
  return {
    archiveId:series.archive_id,
    sourceShiftId:series.source_shift_id,
    currentLocation:series.current_location,
    seriesRevision:Number(series.series_revision),
    latestFinalizedRevision:series.latest_finalized_revision==null?null:Number(series.latest_finalized_revision),
    latestFinalizedSha256:series.latest_finalized_sha256??null,
    createdAt:series.created_at instanceof Date?series.created_at.toISOString():String(series.created_at),
    revisions:rows.map(toRevision),
  };
}
