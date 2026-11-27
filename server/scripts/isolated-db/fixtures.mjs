import { createHash } from 'node:crypto';

import {
  REPORT_SCHEMA,
  buildHistoricalizationReport,
  canonicalJson,
  computeDatabaseFingerprint,
} from '../../src/legacy-historicalization.mjs';

const TARGET=/^samosval_parallel_shifts_test_[a-f0-9]{12,20}_[a-f0-9]{12}$/;
const REPLICA_UID='test-admin-replica';
// Canonical consumer DDL (archive-store, seed-objects-db, archive-read,
// archive-parallel-restore, prepare-test-import.mjs): the foreign key carries
// no cascade action and no index beyond the two primary keys is invented.
const IMPORT_DDL=`CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL); CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path))`;
const IMPORT_HASH=createHash('sha256').update(IMPORT_DDL).digest('hex');
const REGISTRY_DDL=`CREATE TABLE IF NOT EXISTS samosval_fixture_registry(id text PRIMARY KEY,source_hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;

// ---------------------------------------------------------------------------
// S25 provenance/archive fixtures (I6). Every identifier below lives in a real
// parent row (workspaces, app_users, workspace_objects, line_trucks), so a
// missing parent fails as 23503 instead of being silently accepted. The golden
// v2 document is the exact 14-key document written by src/shift-start.mjs, and
// the legacy v1 document is the exact 7-key Firebase document of design §4.8.
// ---------------------------------------------------------------------------
const sha256Hex=value=>createHash('sha256').update(value).digest('hex');
const canonicalSha256=value=>sha256Hex(Buffer.from(canonicalJson(value),'utf8'));
// The live v1 replica writer hashes `JSON.stringify(payload)` of the operation
// it received (`digest` at src/replica-store.mjs:15, applied at :55, stored at
// :77). Design §4.10 requires JCS only for the v2 envelope
// `{protocolVersion:2,kind,payload}`, which a `replica_stream` v1 row is not, so
// the golden journal row below must use this legacy algorithm.
const legacySha256=value=>sha256Hex(JSON.stringify(value??null));
const hex64=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const recordFixture=(q,id,hash)=>q('INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)',[id,hash]);
const insertUser=(q,uid,displayName,role)=>q(`INSERT INTO app_users(uid,email,display_name,role,status,revision,profile,protected) VALUES ($1,$2,$3,$4,'active',1,'{}',false)`,[uid,`${uid}@example.invalid`,displayName,role]);
const insertObject=(q,workspaceId,objectId,name)=>q(`INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ($1,$2,$3)`,[workspaceId,objectId,{id:objectId,name}]);
const insertTruck=(q,workspaceId,truckId,name)=>q(`INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)`,[workspaceId,truckId,{id:truckId,name}]);

// Recreates one pre-025 legacy document exactly as 025's one-time backfill
// classified it. The v2 bridge deliberately refuses every legacy write, so the
// fixture must present the already-classified row: it disables the named bridge
// trigger for this single INSERT (owner/superuser only) and re-enables it in the
// same transaction. Nothing here is a runtime write path.
async function insertLegacyV1(q,{workspaceId,shiftId,objectId,objectName,payload}){
  await q('ALTER TABLE shifts DISABLE TRIGGER shifts_legacy_bridge_trigger');
  try{
    await q(`INSERT INTO shifts(workspace_id,shift_id,is_active,payload,state,object_id,object_name_snapshot,work_date,shift_type,shift_type_resolution,opened_at,opened_by_uid,opened_by_name_snapshot,identity_resolution,payload_schema_version,revision)
             VALUES ($1,$2,false,$3,'historical',$4,$5,to_date($6,'DD.MM.YYYY'),NULL,'unresolved',to_timestamp(($7::double precision)/1000.0),NULL,$8,'unresolved',1,1)`,
      [workspaceId,shiftId,payload,objectId,objectName,payload.startDate,payload.startedAt,payload.startedBy]);
  }finally{
    await q('ALTER TABLE shifts ENABLE TRIGGER shifts_legacy_bridge_trigger');
  }
}

// Runs a statement that must fail closed and rolls the savepoint back, so a
// fixture verifier can prove a refusal without leaving any trace. When `code`
// is given the refusal must carry exactly that SQLSTATE.
async function rejectsWith(q,sql,values,pattern,code){
  await q('SAVEPOINT fixture_expectation');
  let error=null;
  try{await q(sql,values);}catch(caught){error=caught;}
  await q('ROLLBACK TO SAVEPOINT fixture_expectation');
  if(!error)throw new Error(`expected refusal was accepted: ${pattern}`);
  if(!pattern.test(String(error.message??'')))throw new Error(`unexpected refusal: ${error.message}`);
  if(code!==undefined&&error.code!==code)throw new Error(`expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
  return true;
}

// Runs a statement under a real unprivileged role and rolls the savepoint back,
// so a fixture proves a write is refused by actual grants, not merely by an
// `has_table_privilege` flag. `role` is always a closed literal from this file.
async function rejectsAsRole(q,role,sql,values,pattern){
  await q('SAVEPOINT fixture_role_expectation');
  let error=null;
  try{
    await q(`SET LOCAL ROLE ${role}`);
    await q(sql,values);
  }catch(caught){error=caught;}
  await q('ROLLBACK TO SAVEPOINT fixture_role_expectation');
  await q('RESET ROLE');
  if(!error)throw new Error(`expected refusal was accepted under ${role}: ${pattern}`);
  if(!pattern.test(String(error.message??'')))throw new Error(`unexpected refusal under ${role}: ${error.message}`);
  return true;
}

const LEGACY_WORKSPACE='main_workspace';
const LEGACY_OBJECT_ID='fixture_legacy_object';
const LEGACY_SHIFT_ID='shift_fixture_legacy_v1';
const LEGACY_STARTED_AT=1795420800000;
const LEGACY_PAYLOAD=Object.freeze({
  id:LEGACY_SHIFT_ID,
  objectId:LEGACY_OBJECT_ID,
  objectName:'Объект наследия',
  startDate:'23.11.2026',
  startedAt:LEGACY_STARTED_AT,
  startedBy:'Мастер прошлой смены',
  isActive:true,
});

const V2_WORKSPACE='main_workspace';
const V2_OBJECT_ID='fixture_v2_object';
const V2_CREATOR_UID='fixture_v2_creator';
const V2_SENDER_UID='fixture_v2_sender';
const V2_SHIFT_ID='shift_fixture_v2_night';
const V2_STARTED_AT=1795453200000;
const V2_PAYLOAD=Object.freeze({
  payloadSchemaVersion:2,
  id:V2_SHIFT_ID,
  shiftId:V2_SHIFT_ID,
  objectId:V2_OBJECT_ID,
  objectName:'Ночной объект фикстуры',
  startDate:'23.11.2026',
  date:'2026-11-23',
  workShift:'night',
  type:'night',
  state:'active',
  isActive:true,
  startedAt:V2_STARTED_AT,
  startedBy:'Ночной мастер',
  startedByUid:V2_CREATOR_UID,
});
const V2_JOURNAL=Object.freeze({
  collection:'shift',
  path:`shift/${V2_SHIFT_ID}`,
  data:V2_PAYLOAD,
  // Transport identity of the replica batch. It authorizes delivery only and is
  // never the document creator; the materialized row must keep startedByUid.
  senderUid:V2_SENDER_UID,
});

const CUTOVER_WORKSPACE='fixture_cutover_workspace';
const CUTOVER_OBJECT_ID='fixture_cutover_object';
const CUTOVER_SHIFT_ID='shift_fixture_cutover_v1';
const CUTOVER_ADMIN_UID='fixture_cutover_admin';
const CUTOVER_OPENED_AT=1795424400000;
const CUTOVER_PAYLOAD=Object.freeze({
  id:CUTOVER_SHIFT_ID,
  objectId:CUTOVER_OBJECT_ID,
  objectName:'Объект отчёта перехода',
  startDate:'23.11.2026',
  startedAt:CUTOVER_OPENED_AT,
  startedBy:'Мастер отчёта',
  isActive:true,
});
const CUTOVER_CONFIRMATION_ID='fixture_cutover_confirmation';
const CUTOVER_REPORT_CONTEXT=Object.freeze({
  workspaceId:CUTOVER_WORKSPACE,
  migrationVersion:'025_parallel_shifts_core.sql',
  generatedAt:'2098-12-31T00:00:00.000Z',
  expiresAt:'2099-01-01T00:00:00.000Z',
  backupManifestSha256:'a'.repeat(64),
});

const ARCHIVE_EDITOR_UID='fixture_archive_editor';
const ARCHIVE_ORIGINAL_UID='fixture_archive_original';
const ARCHIVE_OBJECT_ID='fixture_archive_object';
const ARCHIVE_TRUCK_ID='fixture_archive_truck';
const ARCHIVE_REVISION_ONE=Buffer.from(canonicalJson({schema:'samosval.archive/v1',shiftId:'shift_fixture_archive_source',revision:1,objectId:ARCHIVE_OBJECT_ID}),'utf8');
const ARCHIVE_REVISION_TWO=Buffer.from(canonicalJson({schema:'samosval.archive/v1',shiftId:'shift_fixture_archive_source',revision:2,objectId:ARCHIVE_OBJECT_ID}),'utf8');
// Design §4.6: a restored context's `original_*` columns are copied only from
// the source archive revision provenance, and archive schema v2 carries the
// original `shift_type`, `shift_type_resolution`, `opened_by_uid`,
// `opened_by_name_snapshot`, `identity_resolution` and `payload_schema_version`.
// This fixture therefore stores that provenance inside the revision bytes — the
// only place a writer may read it from — and its verifier re-derives the
// expected `original_*` from the bytes it reads back out of the database, never
// from the literal it inserted. A restored-context writer does not exist yet
// (`INSERT INTO restored_shift_contexts` is absent from src/), so the fixture
// fixes the shape that writer must implement and proves the copy is checked at
// its source, not against a constant.
const ARCHIVE_SOURCE_PROVENANCE=Object.freeze({
  openedByUid:ARCHIVE_ORIGINAL_UID,
  openedByNameSnapshot:'Оригинальный мастер',
  identityResolution:'source',
  shiftType:'night',
  shiftTypeResolution:'source',
  payloadSchemaVersion:2,
  sourceShiftRevision:1,
});
const ARCHIVE_REVISION_CONTEXT=Buffer.from(canonicalJson({
  schema:'samosval.archive/v1',
  shiftId:'shift_fixture_context_source',
  revision:1,
  objectId:ARCHIVE_OBJECT_ID,
  provenance:ARCHIVE_SOURCE_PROVENANCE,
}),'utf8');
// Source provenance of stored revision bytes, or `null` when the bytes carry
// none: a missing provenance is a failed expectation, never a silent pass.
function archiveProvenance(bytes){
  try{
    const parsed=JSON.parse(Buffer.isBuffer(bytes)?bytes.toString('utf8'):String(bytes??''));
    const provenance=parsed?.provenance;
    return provenance&&typeof provenance==='object'&&!Array.isArray(provenance)?provenance:null;
  }catch{return null;}
}
const CHAIN_EDITOR_UID='fixture_chain_editor';
const CHAIN_OBJECT_ID='fixture_chain_object';

const RUNTIME_PROBE_TABLES=Object.freeze([
  'shift_archive_revisions','archive_operation_receipts','archive_revision_publications',
  'restored_context_status_snapshots','restored_context_history','restored_context_receipts',
  'restored_context_audit','restored_context_migration_evidence',
  'restored_context_migration_evidence_rows','archive_audit',
]);
const RUNTIME_PROBE_SOURCE_TABLES=Object.freeze([
  'workspace_service_audit','workspace_service_receipts','line_audit','line_operation_receipts',
  'line_history','history_audit','history_receipts','shift_operation_receipts',
]);
const RUNTIME_PROBE_FUNCTIONS=Object.freeze([
  'public.restored_context_migration_plan(text,text,text,bigint,text)',
  'public.restored_context_source_manifest(text,text,text,bigint,text)',
  'public.migrate_legacy_restored_context_exact(text,jsonb)',
]);

async function catalog(query,names){return (await query(`SELECT c.relname,c.relkind,owner.rolname owner,COALESCE(array_to_string(c.relacl,','),'') acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles owner ON owner.oid=c.relowner WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname`,[names])).rows;}
function exactNames(rows,names){return rows.map(r=>r.relname).join('|')===[...names].sort().join('|');}

// ---------------------------------------------------------------------------
// S26 replica staging fixtures (I7). They materialize the real 026 contract on
// a disposable clone: immutable replica_stream rows whose sha256 is computed by
// PostgreSQL from the exact stored jsonb text (never a constant), the persistent
// head ledger (settled set / settled delete / pending set) and the pending
// transport row, which carries no payload copy. They do not imitate the restore
// flow; `tests/replica-exact-backup.test.mjs` owns that proof.
// ---------------------------------------------------------------------------
const OO_WORKSPACE='fixture_out_of_order_workspace';
const OO_OBJECT_ID='fixture_oo_object';
const OO_USER_UID='fixture_oo_user';
const OO_TRUCK_ID='fixture_oo_truck';
const OO_ABSENT_SHIFT='fixture_oo_absent_shift';

const FR_WORKSPACE='fixture_full_restore_workspace';
const FR_OBJECT_ID='fixture_fr_object';
const FR_USER_UID='fixture_fr_user';
const FR_SHIFT_ID='fixture_fr_shift';
const FR_TRUCK_ID='fixture_fr_truck';
const FR_LOG_ID='fixture_fr_log';

// pgcrypto is installed into the shared `postgres` database by bootstrap.sql,
// but a target cloned from template0 does not inherit it. The fixture computes
// the hash in SQL as the contract requires, so it installs the extension itself.
const ensurePgcrypto=q=>q('CREATE EXTENSION IF NOT EXISTS pgcrypto');
const insertReplicaStream=(q,workspaceId,seq,operationId,kind,payload)=>q(
  `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256,protocol_version,hash_version)
   VALUES ($1,$2,'f2s',$3,$4,$5::jsonb,encode(public.digest($5::jsonb::text,'sha256'),'hex'),2,2)`,
  [workspaceId,seq,operationId,kind,JSON.stringify(payload)]);
const insertReplicaHead=(q,head)=>q(
  `INSERT INTO replica_document_heads(workspace_id,collection,document_id,head_seq,stream_direction,head_kind,shift_id,truck_id,object_id,user_uid,applied_seq,canonical_present)
   VALUES ($1,$2,$3,$4,'f2s',$5,$6,$7,$8,$9,$10,$11)`,
  [head.workspaceId,head.collection,head.documentId,head.headSeq,head.headKind,head.shiftId??null,head.truckId??null,head.objectId??null,head.userUid??null,head.appliedSeq??null,head.canonicalPresent]);

const registry=new Map([
 ['import-schema',{order:10,async apply(q){await q(IMPORT_DDL);await q(`INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)`,['import-schema',IMPORT_HASH]);},async verify(q){const objects=await catalog(q,['migration_imports','migration_documents']);const constraints=(await q(`SELECT con.conname,con.confdeltype::text delete_rule,con.confrelid::regclass::text referenced FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace WHERE n.nspname='public' AND con.contype='f' AND con.conrelid=to_regclass('public.migration_documents')`)).rows;const invented=(await q(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public' AND tablename IN ('migration_imports','migration_documents') AND indexname NOT IN ('migration_imports_pkey','migration_documents_pkey')`)).rows[0];const counts=(await q(`SELECT (SELECT count(*)::int FROM migration_imports) imports,(SELECT count(*)::int FROM migration_documents) documents,(SELECT source_hash FROM samosval_fixture_registry WHERE id='import-schema') hash`)).rows[0];return {objects:exactNames(objects,['migration_imports','migration_documents']),foreignKey:constraints.length===1&&constraints[0].conname==='migration_documents_import_sha256_fkey'&&constraints[0].delete_rule==='a'&&constraints[0].referenced==='migration_imports',noInventedIndexes:invented?.n===0,empty:counts?.imports===0&&counts?.documents===0,hash:counts?.hash===IMPORT_HASH};}}],
 ['identity-empty',{order:20,async apply(q){await q(`INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)`,['identity-empty','baseline-s24']);},async verify(q){const row=(await q(`SELECT (SELECT count(*)::int FROM app_users) users,(SELECT count(*)::int FROM registration_requests) requests,(SELECT count(*)::int FROM identity_receipts) receipts,(SELECT count(*)::int FROM identity_audit) audit,(SELECT count(*)::int FROM identity_state WHERE initialized OR owner_uid IS NOT NULL) initialized`)).rows[0];return {empty:row&&Object.values(row).every(v=>v===0)};}}],
 ['auth-schema-018',{order:30,async apply(q){await q(`CREATE TABLE IF NOT EXISTS user_credentials(uid text PRIMARY KEY REFERENCES app_users(uid) ON DELETE CASCADE,password_hash text NOT NULL,algorithm text NOT NULL DEFAULT 'scrypt-sha256',salt text NOT NULL,password_reset_required boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),changed_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS user_sessions(id text PRIMARY KEY,uid text NOT NULL REFERENCES app_users(uid) ON DELETE CASCADE,token_hash text NOT NULL,device_info jsonb,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz); CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash); CREATE INDEX IF NOT EXISTS idx_user_sessions_uid ON user_sessions(uid); CREATE TABLE IF NOT EXISTS password_reset_tokens(token_hash text PRIMARY KEY,uid text NOT NULL REFERENCES app_users(uid) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,used_at timestamptz); CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_uid ON password_reset_tokens(uid)`);await q(`INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)`,['auth-schema-018','018']);},async verify(q){const names=['user_credentials','user_sessions','password_reset_tokens','idx_user_sessions_token_hash','idx_user_sessions_uid','idx_password_reset_tokens_uid'];const objects=await catalog(q,names);const count=(await q(`SELECT (SELECT count(*)::int FROM user_credentials)+(SELECT count(*)::int FROM user_sessions)+(SELECT count(*)::int FROM password_reset_tokens) n`)).rows[0]?.n;return {objects:exactNames(objects,names),empty:count===0};}}],
 ['authority-main-ubuntu',{order:40,async apply(q){await q(`UPDATE server_authority SET provider='ubuntu',generation=1,reason='initial',updated_by='system' WHERE workspace_id='main_workspace'`);await q(`INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)`,['authority-main-ubuntu','ubuntu-v1']);},async verify(q){const rows=(await q(`SELECT workspace_id,provider,generation::text generation,reason,updated_by FROM server_authority WHERE workspace_id='main_workspace'`)).rows;return {exact:rows.length===1&&rows[0].provider==='ubuntu'&&rows[0].generation==='1'&&rows[0].reason==='initial'&&rows[0].updated_by==='system'};}}],
 ['authority-main-firebase',{order:50,async apply(q){await q(`UPDATE server_authority SET provider='firebase',generation=1,reason='fixture',updated_by='system' WHERE workspace_id='main_workspace'`);await q(`INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)`,['authority-main-firebase','firebase-v1']);},async verify(q){const rows=(await q(`SELECT workspace_id,provider,generation::text generation FROM server_authority WHERE workspace_id='main_workspace'`)).rows;return {exact:rows.length===1&&rows[0].provider==='firebase'&&rows[0].generation==='1'};}}],
 ['replica-admin',{order:60,async apply(q){await q(`INSERT INTO app_users(uid,email,display_name,role,status,revision,profile,protected) VALUES ($1,$2,$3,'admin','active',1,'{}',false)`,[REPLICA_UID,'replica@example.invalid','Replica Admin']);await q(`INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)`,['replica-admin','replica-admin-v1']);},async verify(q){const rows=(await q(`SELECT uid,email,display_name,role,status FROM app_users`)).rows;return {exact:rows.length===1&&rows[0].uid===REPLICA_UID&&rows[0].email==='replica@example.invalid'&&rows[0].role==='admin'&&rows[0].status==='active'};}}],
 ['replica-empty-stream-cursors',{order:70,async apply(q){await q(`DELETE FROM replica_stream; UPDATE replica_cursor SET f2s_seq=0,s2f_seq=0 WHERE workspace_id='main_workspace'`);await q(`INSERT INTO samosval_fixture_registry(id,source_hash) VALUES ($1,$2)`,['replica-empty-stream-cursors','replica-empty-v1']);},async verify(q){const row=(await q(`SELECT (SELECT count(*)::int FROM replica_stream) stream,(SELECT count(*)::int FROM replica_cursor) cursors,(SELECT count(*)::int FROM replica_cursor WHERE workspace_id='main_workspace' AND f2s_seq=0 AND s2f_seq=0) initial`)).rows[0];const objects=await catalog(q,['replica_stream','replica_cursor']);return {objects:exactNames(objects,['replica_stream','replica_cursor']),empty:row?.stream===0,initial:row?.cursors===1&&row?.initial===1};}}],

 ['parallel-shift-legacy-unresolved',{order:100,
  async apply(q){
   await insertObject(q,LEGACY_WORKSPACE,LEGACY_OBJECT_ID,'Объект наследия');
   await insertLegacyV1(q,{workspaceId:LEGACY_WORKSPACE,shiftId:LEGACY_SHIFT_ID,objectId:LEGACY_OBJECT_ID,objectName:'Объект наследия',payload:LEGACY_PAYLOAD});
   await recordFixture(q,'parallel-shift-legacy-unresolved','legacy-v1-unresolved');
  },
  async verify(q){
   const row=(await q(`SELECT state,is_active,payload_schema_version::int AS version,identity_resolution,opened_by_uid,opened_by_name_snapshot,shift_type,shift_type_resolution,object_id,to_char(work_date,'YYYY-MM-DD') AS work_date,to_char(opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS opened_at FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,[LEGACY_WORKSPACE,LEGACY_SHIFT_ID])).rows[0];
   const payload=(await q('SELECT payload=$3::jsonb AS same FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[LEGACY_WORKSPACE,LEGACY_SHIFT_ID,LEGACY_PAYLOAD])).rows[0];
   const registry=(await q("SELECT source_hash FROM samosval_fixture_registry WHERE id='parallel-shift-legacy-unresolved'")).rows[0];
   const live=await rejectsWith(q,`UPDATE shifts SET state='active',is_active=true WHERE workspace_id=$1 AND shift_id=$2`,[LEGACY_WORKSPACE,LEGACY_SHIFT_ID],/protocol-upgrade-required/i);
   return {
    exact:row?.state==='historical'&&row?.is_active===false&&row?.version===1&&row?.identity_resolution==='unresolved'&&row?.opened_by_uid===null&&row?.opened_by_name_snapshot==='Мастер прошлой смены'&&row?.shift_type===null&&row?.shift_type_resolution==='unresolved'&&row?.object_id===LEGACY_OBJECT_ID&&row?.work_date==='2026-11-23'&&row?.opened_at==='2026-11-23T08:00:00.000Z',
    payloadBytes:payload?.same===true,
    registry:registry?.source_hash==='legacy-v1-unresolved',
    legacyNeverLive:live===true,
   };
  }}],

 ['parallel-shift-v2-night',{order:110,
  async apply(q){
   await insertUser(q,V2_CREATOR_UID,'Ночной мастер','foreman');
   await insertUser(q,V2_SENDER_UID,'Отправитель реплики','admin');
   await insertObject(q,V2_WORKSPACE,V2_OBJECT_ID,'Ночной объект фикстуры');
   await q('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[V2_WORKSPACE,V2_SHIFT_ID,V2_PAYLOAD]);
   await q(`INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq) VALUES ($1,1,0) ON CONFLICT (workspace_id) DO UPDATE SET f2s_seq=GREATEST(replica_cursor.f2s_seq,1),updated_at=now()`,[V2_WORKSPACE]);
   await q(`INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256) VALUES ($1,1,'f2s',$2,'doc.set',$3,$4)`,[V2_WORKSPACE,'fixture_v2_night_operation',V2_JOURNAL,legacySha256(V2_JOURNAL)]);
   await recordFixture(q,'parallel-shift-v2-night','golden-v2-night-sender-ne-creator');
  },
  async verify(q){
   const row=(await q(`SELECT opened_by_uid,opened_by_name_snapshot,shift_type,shift_type_resolution,identity_resolution,payload_schema_version::int AS version,state,is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,[V2_WORKSPACE,V2_SHIFT_ID])).rows[0];
   const payload=(await q('SELECT payload=$3::jsonb AS same FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[V2_WORKSPACE,V2_SHIFT_ID,V2_PAYLOAD])).rows[0];
   const journal=(await q(`SELECT payload->>'senderUid' AS sender,payload->'data'->>'startedByUid' AS creator,payload=$3::jsonb AS same,sha256 FROM replica_stream WHERE workspace_id=$1 AND operation_id=$2`,[V2_WORKSPACE,'fixture_v2_night_operation',V2_JOURNAL])).rows[0];
   const registry=(await q("SELECT source_hash FROM samosval_fixture_registry WHERE id='parallel-shift-v2-night'")).rows[0];
   return {
    exact:row?.opened_by_uid===V2_CREATOR_UID&&row?.opened_by_name_snapshot==='Ночной мастер'&&row?.shift_type==='night'&&row?.shift_type_resolution==='source'&&row?.identity_resolution==='source'&&row?.version===2&&row?.state==='active'&&row?.is_active===true,
    payloadBytes:payload?.same===true,
    senderIsTransportOnly:journal?.sender===V2_SENDER_UID&&journal?.creator===V2_CREATOR_UID&&journal.sender!==journal.creator&&row?.opened_by_uid!==journal.sender,
    // The stored hash must be the one the live v1 writer computes, i.e.
    // sha256(JSON.stringify(payload)) over the exact payload it received.
    journalHashLegacy:journal?.sha256===legacySha256(V2_JOURNAL),
    // ... and it must not be the JCS hash: §4.10 defines that only for the v2
    // envelope `{protocolVersion:2,kind,payload}`, so a v1 row that carried a
    // JCS hash would not be byte-true to the real stream. One line, two
    // algorithms, no ambiguity about which one this fixture pins.
    journalHashIsNotJcs:journal?.sha256!==canonicalSha256(V2_JOURNAL),
    // The hash is bound to the payload row that is actually stored. `payload` is
    // `jsonb`, which does not preserve key order, so the legacy hash cannot be
    // recomputed byte-wise from the row; identity is proved as jsonb equality
    // plus the legacy hash of the exact payload the writer received.
    journalPayloadUnchanged:journal?.same===true,
    registry:registry?.source_hash==='golden-v2-night-sender-ne-creator',
   };
  }}],

 ['parallel-shift-cutover-report',{order:120,
  async apply(q){
   await q('INSERT INTO workspaces(id) VALUES ($1)',[CUTOVER_WORKSPACE]);
   await insertUser(q,CUTOVER_ADMIN_UID,'Администратор отчёта','admin');
   await insertObject(q,CUTOVER_WORKSPACE,CUTOVER_OBJECT_ID,'Объект отчёта перехода');
   await insertLegacyV1(q,{workspaceId:CUTOVER_WORKSPACE,shiftId:CUTOVER_SHIFT_ID,objectId:CUTOVER_OBJECT_ID,objectName:'Объект отчёта перехода',payload:CUTOVER_PAYLOAD});
   const databaseFingerprint=await computeDatabaseFingerprint({query:q});
   const report=await buildHistoricalizationReport({query:q},{...CUTOVER_REPORT_CONTEXT,databaseFingerprint});
   await q(`INSERT INTO legacy_historicalization_confirmations(confirmation_id,workspace_id,report_schema,report_sha256,report_bytes,row_count,owner_actor_uid,expires_at,backup_manifest_sha256,database_fingerprint)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
     [CUTOVER_CONFIRMATION_ID,CUTOVER_WORKSPACE,REPORT_SCHEMA,report.sha256,report.bytes,report.rowCount,CUTOVER_ADMIN_UID,CUTOVER_REPORT_CONTEXT.expiresAt,CUTOVER_REPORT_CONTEXT.backupManifestSha256,databaseFingerprint]);
   await recordFixture(q,'parallel-shift-cutover-report','canonical-report-bytes');
  },
  async verify(q){
   const stored=(await q('SELECT report_bytes,report_sha256,row_count,state FROM legacy_historicalization_confirmations WHERE confirmation_id=$1',[CUTOVER_CONFIRMATION_ID])).rows[0];
   const databaseFingerprint=await computeDatabaseFingerprint({query:q});
   const recomputed=await buildHistoricalizationReport({query:q},{...CUTOVER_REPORT_CONTEXT,databaseFingerprint});
   const mutated=JSON.parse(recomputed.bytes.toString('utf8'));
   mutated.rows[0].objectId=`${mutated.rows[0].objectId}_mutated`;
   const shift=(await q(`SELECT state,closed_at,closed_by_uid,payload ? 'closedAt' AS has_closed,payload ? 'closing' AS has_closing FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,[CUTOVER_WORKSPACE,CUTOVER_SHIFT_ID])).rows[0];
   const registry=(await q("SELECT source_hash FROM samosval_fixture_registry WHERE id='parallel-shift-cutover-report'")).rows[0];
   return {
    bytes:Buffer.isBuffer(stored?.report_bytes)&&stored.report_bytes.equals(recomputed.bytes),
    hash:stored?.report_sha256===recomputed.sha256&&recomputed.sha256===sha256Hex(stored.report_bytes),
    mutationInvalidates:canonicalSha256(mutated)!==recomputed.sha256,
    noSyntheticClose:shift?.state==='historical'&&shift?.closed_at===null&&shift?.closed_by_uid===null&&shift?.has_closed===false&&shift?.has_closing===false,
    rowCount:stored?.row_count===1&&recomputed.rowCount===1&&stored?.state==='pending',
    registry:registry?.source_hash==='canonical-report-bytes',
   };
  }}],

 ['parallel-shift-restored-contexts',{order:130,
  async apply(q){
   await insertUser(q,ARCHIVE_EDITOR_UID,'Редактор архива','admin');
   await insertUser(q,ARCHIVE_ORIGINAL_UID,'Оригинальный мастер','foreman');
   await insertObject(q,LEGACY_WORKSPACE,ARCHIVE_OBJECT_ID,'Архивный объект');
   await insertTruck(q,LEGACY_WORKSPACE,ARCHIVE_TRUCK_ID,'Самосвал архива');
   await q(`INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id,current_location,series_revision) VALUES ($1,$2,$3,'archive',1)`,['main_workspace','fixture_archive_context','shift_fixture_context_source']);
   await q(`INSERT INTO shift_archive_revisions(workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
            VALUES ($1,$2,1,NULL,NULL,$3,$4,2,'firebase',$5,$6)`,
     ['main_workspace','fixture_archive_context',ARCHIVE_REVISION_CONTEXT,sha256Hex(ARCHIVE_REVISION_CONTEXT),'fixture://shift/shift_fixture_context_source',ARCHIVE_EDITOR_UID]);
   await q(`INSERT INTO restored_shift_contexts(workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,original_shift_type,original_shift_type_resolution,restored_by_uid,restored_by_name_snapshot,restored_at,archive_revision,context_revision,restore_operation_id,source_state_snapshot,source_shift_revision,opened_at_snapshot,object_id,object_name,work_date)
            VALUES ($1,$2,$3,$4,'parallel','open',$5,'Оригинальный мастер','source','night','source',$6,'Редактор архива',to_timestamp(($7::double precision)/1000.0),1,1,$8,$9,1,to_timestamp(($10::double precision)/1000.0),$11,$12,to_date($13,'DD.MM.YYYY'))`,
     ['main_workspace','fixture_restored_context','fixture_archive_context','shift_fixture_context_source',ARCHIVE_ORIGINAL_UID,ARCHIVE_EDITOR_UID,1795496400000,'fixture_restore_context_operation',{state:'closed',objectId:ARCHIVE_OBJECT_ID},1795420800000,ARCHIVE_OBJECT_ID,'Архивный объект','23.11.2026']);
   await q(`INSERT INTO restored_context_logs(workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,source_log_id,created_from_archive_revision)
            VALUES ($1,$2,$3,$4,$5,1,$6,1)`,
     ['main_workspace','fixture_restored_context','fixture_restored_log',ARCHIVE_TRUCK_ID,{id:'fixture_restored_log',truckId:ARCHIVE_TRUCK_ID,timestamp:1795424400000,type:'trip'},'source_log_fixture_0001']);
   await q(`INSERT INTO restored_context_status_snapshots(workspace_id,restored_context_id,truck_id,payload,status_revision,cycle_revision,ttn_revision)
            VALUES ($1,$2,$3,$4,1,1,1)`,
     ['main_workspace','fixture_restored_context',ARCHIVE_TRUCK_ID,{onLine:false,arriveTimestamp:1795424400000,lastLoadTimestamp:1795428000000,ttnStatus:true}]);
   await q(`INSERT INTO restored_context_history(workspace_id,action_id,restored_context_id,uid,type,before_log,after_log,revision,undone)
            VALUES ($1,$2,$3,$4,'restore',NULL,$5,1,false)`,
     ['main_workspace','fixture_restored_action','fixture_restored_context',ARCHIVE_EDITOR_UID,{id:'fixture_restored_log'}]);
   await recordFixture(q,'parallel-shift-restored-contexts','restored-context-snapshot');
  },
  async verify(q){
   const context=(await q(`SELECT original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,original_shift_type,original_shift_type_resolution,restored_by_uid,context_state,mode,archive_revision::int AS archive_revision,context_revision::int AS context_revision FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2`,['main_workspace','fixture_restored_context'])).rows[0];
   const series=(await q(`SELECT latest_finalized_revision,latest_finalized_sha256,series_revision::int AS series_revision FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2`,['main_workspace','fixture_archive_context'])).rows[0];
   const revision=(await q(`SELECT payload_bytes,payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1`,['main_workspace','fixture_archive_context'])).rows[0];
   const children=(await q(`SELECT (SELECT count(*)::int FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2) AS logs,(SELECT count(*)::int FROM restored_context_status_snapshots WHERE workspace_id=$1 AND restored_context_id=$2) AS snapshots,(SELECT count(*)::int FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2) AS history` ,['main_workspace','fixture_restored_context'])).rows[0];
   const snapshot=(await q(`SELECT payload->>'arriveTimestamp' AS arrive,payload->>'ttnStatus' AS ttn FROM restored_context_status_snapshots WHERE workspace_id=$1 AND restored_context_id=$2 AND truck_id=$3`,['main_workspace','fixture_restored_context',ARCHIVE_TRUCK_ID])).rows[0];
   const registry=(await q("SELECT source_hash FROM samosval_fixture_registry WHERE id='parallel-shift-restored-contexts'")).rows[0];
   // The expectation is recomputed from the revision bytes stored in the
   // database, so a context that did not copy its source provenance fails here.
   const source=archiveProvenance(revision?.payload_bytes);
   return {
    provenancePreserved:source!==null&&context?.original_opened_by_uid===source.openedByUid&&context?.original_opened_by_name_snapshot===source.openedByNameSnapshot&&context?.original_identity_resolution===source.identityResolution&&context?.original_shift_type===source.shiftType&&context?.original_shift_type_resolution===source.shiftTypeResolution,
    distinctRestorer:context?.restored_by_uid===ARCHIVE_EDITOR_UID&&context?.restored_by_uid!==context?.original_opened_by_uid,
    snapshotBytes:Buffer.isBuffer(revision?.payload_bytes)&&revision.payload_bytes.equals(ARCHIVE_REVISION_CONTEXT)&&hex64(revision?.payload_sha256)&&revision?.payload_sha256===sha256Hex(revision.payload_bytes),
    seriesNotAdvanced:series?.latest_finalized_revision===null&&series?.latest_finalized_sha256===null&&series?.series_revision===1,
    children:children?.logs===1&&children?.snapshots===1&&children?.history===1,
    statusSnapshot:snapshot?.arrive==='1795424400000'&&snapshot?.ttn==='true',
    registry:registry?.source_hash==='restored-context-snapshot',
   };
  }}],

 ['archive-immutable-revisions',{order:140,
  async apply(q){
   await insertUser(q,CHAIN_EDITOR_UID,'Редактор цепочки','admin');
   await insertObject(q,LEGACY_WORKSPACE,CHAIN_OBJECT_ID,'Объект цепочки');
   await q(`INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id,current_location,series_revision) VALUES ($1,$2,$3,'archive',1)`,['main_workspace','fixture_archive_chain','shift_fixture_chain_source']);
   const one=sha256Hex(ARCHIVE_REVISION_ONE),two=sha256Hex(ARCHIVE_REVISION_TWO);
   await q(`INSERT INTO shift_archive_revisions(workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
            VALUES ($1,$2,1,NULL,NULL,$3,$4,2,'firebase',$5,$6)`,
     ['main_workspace','fixture_archive_chain',ARCHIVE_REVISION_ONE,one,'fixture://shift/shift_fixture_chain_source',CHAIN_EDITOR_UID]);
   await q(`INSERT INTO shift_archive_revisions(workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
            VALUES ($1,$2,2,1,$3,$4,$5,2,'firebase',$6,$7)`,
     ['main_workspace','fixture_archive_chain',one,ARCHIVE_REVISION_TWO,two,'fixture://shift/shift_fixture_chain_source/2',CHAIN_EDITOR_UID]);
   await q(`UPDATE shift_archive_series SET latest_finalized_revision=2,latest_finalized_sha256=$3,series_revision=2 WHERE workspace_id=$1 AND archive_id=$2`,['main_workspace','fixture_archive_chain',two]);
   await q(`INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result) VALUES ($1,$2,$3,$4,$5,$6)`,
     ['main_workspace','fixture_chain_restore_operation','fixture_archive_chain',CHAIN_EDITOR_UID,'b'.repeat(64),{outcome:'restored'}]);
   await q(`INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result) VALUES ($1,$2,$3,$4,$5,$6)`,
     ['main_workspace','fixture_chain_finalize_operation','fixture_archive_chain',CHAIN_EDITOR_UID,'c'.repeat(64),{outcome:'finalized'}]);
   await q(`INSERT INTO restored_shift_contexts(workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,original_shift_type,original_shift_type_resolution,restored_by_uid,restored_by_name_snapshot,restored_at,archive_revision,context_revision,restore_operation_id,source_state_snapshot,source_shift_revision,opened_at_snapshot,object_id,object_name,work_date)
            VALUES ($1,$2,$3,$4,'parallel','finalized',NULL,'<unresolved>','unresolved',NULL,'unresolved',$5,'Редактор архива',to_timestamp(($6::double precision)/1000.0),1,1,$7,$8,1,to_timestamp(($9::double precision)/1000.0),$10,$11,to_date($12,'DD.MM.YYYY'))`,
     ['main_workspace','fixture_chain_context','fixture_archive_chain','shift_fixture_chain_source',CHAIN_EDITOR_UID,1795496400000,'fixture_chain_restore_operation',{state:'closed',objectId:CHAIN_OBJECT_ID},1795420800000,CHAIN_OBJECT_ID,'Архивный объект','23.11.2026']);
   await q(`INSERT INTO archive_revision_publications(workspace_id,archive_id,archive_revision,restored_context_id,restore_operation_id,finalize_operation_id,base_revision,base_sha256,command_hash,published_by_uid)
            VALUES ($1,$2,2,$3,$4,$5,1,$6,$7,$8)`,
     ['main_workspace','fixture_archive_chain','fixture_chain_context','fixture_chain_restore_operation','fixture_chain_finalize_operation',one,'d'.repeat(64),CHAIN_EDITOR_UID]);
   await recordFixture(q,'archive-immutable-revisions','two-revision-chain');
  },
  async verify(q){
   const revisions=(await q(`SELECT archive_revision::int AS revision,previous_revision::int AS previous_revision,previous_sha256,payload_sha256,encode(payload_bytes,'hex') AS bytes_hex FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 ORDER BY archive_revision`,['main_workspace','fixture_archive_chain'])).rows;
   const series=(await q(`SELECT latest_finalized_revision::int AS revision,latest_finalized_sha256 FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2`,['main_workspace','fixture_archive_chain'])).rows[0];
   const publication=(await q(`SELECT archive_revision::int AS revision,base_revision::int AS base_revision,base_sha256 FROM archive_revision_publications WHERE workspace_id=$1 AND archive_id=$2`,['main_workspace','fixture_archive_chain'])).rows[0];
   const receipts=(await q(`SELECT count(*)::int AS n FROM archive_operation_receipts WHERE workspace_id=$1 AND archive_id=$2`,['main_workspace','fixture_archive_chain'])).rows[0];
   const updateRefused=await rejectsWith(q,`UPDATE shift_archive_revisions SET source_kind='mutated' WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1`,['main_workspace','fixture_archive_chain'],/append-only/i);
   const deleteRefused=await rejectsWith(q,`DELETE FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1`,['main_workspace','fixture_archive_chain'],/append-only/i);
   const registry=(await q("SELECT source_hash FROM samosval_fixture_registry WHERE id='archive-immutable-revisions'")).rows[0];
   const [first,second]=revisions;
   return {
    chain:revisions.length===2&&first?.revision===1&&first?.previous_revision===null&&first?.previous_sha256===null&&first?.payload_sha256===sha256Hex(ARCHIVE_REVISION_ONE)&&first?.bytes_hex===ARCHIVE_REVISION_ONE.toString('hex')&&second?.revision===2&&second?.previous_revision===1&&second?.previous_sha256===first?.payload_sha256&&second?.payload_sha256===sha256Hex(ARCHIVE_REVISION_TWO)&&second?.bytes_hex===ARCHIVE_REVISION_TWO.toString('hex'),
    latest:series?.revision===2&&series?.latest_finalized_sha256===second?.payload_sha256,
    publication:publication?.revision===2&&publication?.base_revision===1&&publication?.base_sha256===first?.payload_sha256,
    receipts:receipts?.n===2,
    immutable:updateRefused===true&&deleteRefused===true,
    registry:registry?.source_hash==='two-revision-chain',
   };
  }}],

 ['restore-bootstrap-boundary',{order:150,
  async apply(q){
   await q('INSERT INTO workspaces(id) VALUES ($1)',['fixture_boundary_workspace']);
   await insertObject(q,'fixture_boundary_workspace','fixture_boundary_object','Объект границы восстановления');
   // A restore-only alias may never enter `shifts`: the published v2 document is
   // exact, so the boundary is enforced by the schema, not by one caller.
   await rejectsWith(q,'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
    ['fixture_boundary_workspace','shift_fixture_boundary',{...V2_PAYLOAD,id:'shift_fixture_boundary',shiftId:'shift_fixture_boundary',objectId:'fixture_boundary_object',restoredFrom:'archive_fixture'}],
    /invalid-shift-v2-provenance/i);
   await recordFixture(q,'restore-bootstrap-boundary','no-active-line-on-restore');
  },
  async verify(q){
   const counts=(await q(`SELECT (SELECT count(*)::int FROM shifts WHERE workspace_id=$1) AS shifts,(SELECT count(*)::int FROM line_logs WHERE workspace_id=$1) AS logs,(SELECT count(*)::int FROM line_truck_statuses WHERE workspace_id=$1) AS statuses` ,['fixture_boundary_workspace'])).rows[0];
   const bootstrap=(await q(`SELECT to_regclass('public.restored_shift_contexts') IS NOT NULL AS contexts,to_regclass('public.restored_context_logs') IS NOT NULL AS context_logs`)).rows[0];
   const registry=(await q("SELECT source_hash FROM samosval_fixture_registry WHERE id='restore-bootstrap-boundary'")).rows[0];
   return {
    noActiveLine:counts?.shifts===0&&counts?.logs===0&&counts?.statuses===0,
    bootstrapSchema:bootstrap?.contexts===true&&bootstrap?.context_logs===true,
    registry:registry?.source_hash==='no-active-line-on-restore',
   };
  }}],

 ['replica-pending-empty',{order:170,async apply(q){await recordFixture(q,'replica-pending-empty','026-empty-staging');},async verify(q){const row=(await q(`SELECT (SELECT count(*)::int FROM replica_stream) stream,(SELECT count(*)::int FROM replica_document_heads) heads,(SELECT count(*)::int FROM replica_pending_documents) pending,(SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='replica_pending_documents' AND column_name='payload') payload_columns`)).rows[0];const triggers=(await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname=ANY($1::text[]) AND tgenabled='O'`,[['replica_document_heads_pending_invariant','replica_pending_documents_head_invariant']])).rows[0];return {empty:row?.stream===0&&row?.heads===0&&row?.pending===0,noPayload:row?.payload_columns===0,triggers:triggers?.n===2};}}],
  ['replica-pending-out-of-order',{order:180,
   // Measured counts are the contract, so they are declared here and compared
   // exactly; the verifier's own numbers are never trusted on their own.
   expect:{streamOperations:4,settledHeads:2,pendingDocuments:1,pendingPayloadColumns:0,parentAbsent:true},
   async apply(q){
    await ensurePgcrypto(q);
    await q('INSERT INTO workspaces(id) VALUES ($1)',[OO_WORKSPACE]);
    // Four real f2s operations. seq2 overlaps seq1 on the same object, so the
    // head must point at seq2; seq3 is a soft delete of a user; seq4 stages a
    // truckStatus whose shift parent is absent, so it can only be pending.
    await insertReplicaStream(q,OO_WORKSPACE,1,'fixture_oo_op_1','doc.set',{collection:'objects',path:`workspaces/${OO_WORKSPACE}/objects/${OO_OBJECT_ID}`,data:{id:OO_OBJECT_ID,name:'Объект вне очереди'}});
    await insertReplicaStream(q,OO_WORKSPACE,2,'fixture_oo_op_2','doc.set',{collection:'objects',path:`workspaces/${OO_WORKSPACE}/objects/${OO_OBJECT_ID}`,data:{id:OO_OBJECT_ID,name:'Объект вне очереди (обновлён)'}});
    await insertReplicaStream(q,OO_WORKSPACE,3,'fixture_oo_op_3','doc.delete',{collection:'users',path:`users/${OO_USER_UID}`});
    await insertReplicaStream(q,OO_WORKSPACE,4,'fixture_oo_op_4','doc.set',{collection:'truckStatus',path:`workspaces/${OO_WORKSPACE}/truckStatus/${OO_TRUCK_ID}`,data:{id:OO_TRUCK_ID,shiftId:OO_ABSENT_SHIFT,onLine:true}});
    await insertReplicaHead(q,{workspaceId:OO_WORKSPACE,collection:'objects',documentId:OO_OBJECT_ID,headSeq:2,headKind:'doc.set',objectId:OO_OBJECT_ID,appliedSeq:2,canonicalPresent:true});
    await insertReplicaHead(q,{workspaceId:OO_WORKSPACE,collection:'users',documentId:OO_USER_UID,headSeq:3,headKind:'doc.delete',userUid:OO_USER_UID,appliedSeq:3,canonicalPresent:false});
    await insertReplicaHead(q,{workspaceId:OO_WORKSPACE,collection:'truckStatus',documentId:OO_TRUCK_ID,headSeq:4,headKind:'doc.set',truckId:OO_TRUCK_ID,shiftId:OO_ABSENT_SHIFT,appliedSeq:null,canonicalPresent:false});
    await q(`INSERT INTO replica_pending_documents(workspace_id,collection,document_id,stream_seq,stream_direction,shift_id,truck_id,log_id,missing_shift,missing_truck)
             VALUES ($1,'truckStatus',$2,4,'f2s',$3,$2,NULL,true,false)`,[OO_WORKSPACE,OO_TRUCK_ID,OO_ABSENT_SHIFT]);
    await recordFixture(q,'replica-pending-out-of-order','out-of-order-settled-and-pending');
   },
   async verify(q){
    const row=(await q(`SELECT
      (SELECT count(*)::int FROM replica_stream WHERE workspace_id=$1 AND direction='f2s') AS stream_operations,
      (SELECT count(*)::int FROM replica_document_heads WHERE workspace_id=$1 AND applied_seq IS NOT NULL) AS settled_heads,
      (SELECT count(*)::int FROM replica_pending_documents WHERE workspace_id=$1) AS pending_documents,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='replica_pending_documents' AND column_name='payload') AS pending_payload_columns`,[OO_WORKSPACE])).rows[0];
    const parents=(await q(`SELECT
      (SELECT count(*)::int FROM shifts WHERE workspace_id=$1 AND shift_id=$2) AS shift_rows,
      (SELECT count(*)::int FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$3) AS status_rows`,[OO_WORKSPACE,OO_ABSENT_SHIFT,OO_TRUCK_ID])).rows[0];
    const report={
     streamOperations:row?.stream_operations,
     settledHeads:row?.settled_heads,
     pendingDocuments:row?.pending_documents,
     pendingPayloadColumns:row?.pending_payload_columns,
     parentAbsent:parents?.shift_rows===0&&parents?.status_rows===0,
    };
    // The measured counts are returned for the report, so the verifier itself
    // must fail closed on any drift instead of trusting a non-false number.
    if(report.streamOperations!==4||report.settledHeads!==2||report.pendingDocuments!==1||report.pendingPayloadColumns!==0||report.parentAbsent!==true)throw new Error('replica-pending-out-of-order postcondition mismatch');
    return report;
   }}],
  ['full-exact-provenance-restore',{order:190,
   expect:{collections:6,exactProvenance:true,tombstones:2,pendingDocuments:0},
   async apply(q){
    await ensurePgcrypto(q);
    await q('INSERT INTO workspaces(id) VALUES ($1)',[FR_WORKSPACE]);
    // One exact stream operation per collection, so every head binds to a real
    // stream row by applied_seq. objects/users are soft tombstones; the rest are
    // settled sets with routing fields that satisfy the 026 shape CHECK.
    const operations=[
     [1,'fixture_fr_op_1','doc.delete',{collection:'objects',path:`workspaces/${FR_WORKSPACE}/objects/${FR_OBJECT_ID}`}],
     [2,'fixture_fr_op_2','doc.delete',{collection:'users',path:`users/${FR_USER_UID}`}],
     [3,'fixture_fr_op_3','doc.set',{collection:'shift',path:`workspaces/${FR_WORKSPACE}/shift/${FR_SHIFT_ID}`,data:{payloadSchemaVersion:2,id:FR_SHIFT_ID,shiftId:FR_SHIFT_ID,objectId:FR_OBJECT_ID,objectName:'Полный объект',startDate:'23.11.2026',date:'2026-11-23',startedAt:1795420800000,startedBy:'Мастер полного набора',isActive:true,state:'active',workShift:'day',type:'day'}}],
     [4,'fixture_fr_op_4','doc.set',{collection:'trucks',path:`workspaces/${FR_WORKSPACE}/trucks/${FR_TRUCK_ID}`,data:{id:FR_TRUCK_ID,name:'Самосвал полного набора'}}],
     [5,'fixture_fr_op_5','doc.set',{collection:'truckStatus',path:`workspaces/${FR_WORKSPACE}/truckStatus/${FR_TRUCK_ID}`,data:{id:FR_TRUCK_ID,shiftId:FR_SHIFT_ID,onLine:true}}],
     [6,'fixture_fr_op_6','doc.set',{collection:'logs',path:`workspaces/${FR_WORKSPACE}/logs/${FR_LOG_ID}`,data:{id:FR_LOG_ID,shiftId:FR_SHIFT_ID,truckId:FR_TRUCK_ID,type:'trip',timestamp:1795424400000}}],
    ];
    for(const [seq,operationId,kind,payload] of operations) await insertReplicaStream(q,FR_WORKSPACE,seq,operationId,kind,payload);
    const heads=[
     {collection:'objects',documentId:FR_OBJECT_ID,headSeq:1,headKind:'doc.delete',objectId:FR_OBJECT_ID,appliedSeq:1,canonicalPresent:false},
     {collection:'users',documentId:FR_USER_UID,headSeq:2,headKind:'doc.delete',userUid:FR_USER_UID,appliedSeq:2,canonicalPresent:false},
     {collection:'shift',documentId:FR_SHIFT_ID,headSeq:3,headKind:'doc.set',shiftId:FR_SHIFT_ID,objectId:FR_OBJECT_ID,appliedSeq:3,canonicalPresent:true},
     {collection:'trucks',documentId:FR_TRUCK_ID,headSeq:4,headKind:'doc.set',truckId:FR_TRUCK_ID,appliedSeq:4,canonicalPresent:true},
     {collection:'truckStatus',documentId:FR_TRUCK_ID,headSeq:5,headKind:'doc.set',truckId:FR_TRUCK_ID,shiftId:FR_SHIFT_ID,appliedSeq:5,canonicalPresent:true},
     {collection:'logs',documentId:FR_LOG_ID,headSeq:6,headKind:'doc.set',shiftId:FR_SHIFT_ID,truckId:FR_TRUCK_ID,appliedSeq:6,canonicalPresent:true},
    ];
    for(const head of heads) await insertReplicaHead(q,{workspaceId:FR_WORKSPACE,...head});
    await recordFixture(q,'full-exact-provenance-restore','full-bundle-prepared;restore-flow=replica-exact-backup');
   },
   async verify(q){
    const row=(await q(`SELECT
      (SELECT count(DISTINCT collection)::int FROM replica_document_heads WHERE workspace_id=$1) AS collections,
      (SELECT count(*)::int FROM replica_document_heads WHERE workspace_id=$1 AND head_kind='doc.delete') AS tombstones,
      (SELECT count(*)::int FROM replica_pending_documents WHERE workspace_id=$1) AS pending_documents`,[FR_WORKSPACE])).rows[0];
    const provenance=(await q(`SELECT
      count(*)::int AS total,
      (count(*) FILTER (WHERE s.seq IS NOT NULL AND s.kind=h.head_kind AND s.sha256=encode(public.digest(s.payload::text,'sha256'),'hex')))::int AS exact
      FROM replica_document_heads h
      LEFT JOIN replica_stream s
        ON s.workspace_id=h.workspace_id AND s.direction=h.stream_direction AND s.seq=h.applied_seq
      WHERE h.workspace_id=$1`,[FR_WORKSPACE])).rows[0];
    const report={
     collections:row?.collections,
     exactProvenance:provenance?.total===6&&provenance?.exact===6,
     tombstones:row?.tombstones,
     pendingDocuments:row?.pending_documents,
    };
    if(report.collections!==6||report.exactProvenance!==true||report.tombstones!==2||report.pendingDocuments!==0)throw new Error('full-exact-provenance-restore postcondition mismatch');
    return report;
   }}],
 ['parallel-shift-runtime-role',{order:160,
  async apply(q){
   await recordFixture(q,'parallel-shift-runtime-role','runtime-read-only');
  },
  async verify(q){
   const probes=(await q(`WITH roles AS (SELECT unnest(ARRAY['samosval_runtime','samosval_maintenance']) AS role)
     SELECT
       (SELECT count(*)::int FROM unnest($1::text[]) AS t(name), roles r
         WHERE has_table_privilege(r.role,'public.'||t.name,'SELECT') OR has_table_privilege(r.role,'public.'||t.name,'INSERT')
            OR has_table_privilege(r.role,'public.'||t.name,'UPDATE') OR has_table_privilege(r.role,'public.'||t.name,'DELETE')
            OR has_table_privilege(r.role,'public.'||t.name,'TRUNCATE') OR has_table_privilege(r.role,'public.'||t.name,'REFERENCES')
            OR has_table_privilege(r.role,'public.'||t.name,'TRIGGER')) AS archive_privileges,
       (SELECT count(*)::int FROM unnest($2::text[]) AS t(name), roles r
         WHERE has_table_privilege(r.role,'public.'||t.name,'UPDATE') OR has_table_privilege(r.role,'public.'||t.name,'DELETE')
            OR has_table_privilege(r.role,'public.'||t.name,'TRUNCATE') OR has_table_privilege(r.role,'public.'||t.name,'REFERENCES')
            OR has_table_privilege(r.role,'public.'||t.name,'TRIGGER')) AS source_mutations,
       (SELECT has_schema_privilege('samosval_runtime','public','USAGE') AND has_schema_privilege('samosval_maintenance','public','USAGE')) AS schema_usage,
       (SELECT NOT has_function_privilege('samosval_runtime',$3,'EXECUTE') AND NOT has_function_privilege('samosval_maintenance',$3,'EXECUTE')) AS mutation_revoked,
       (SELECT has_function_privilege('samosval_maintenance',$4,'EXECUTE') AND has_function_privilege('samosval_maintenance',$5,'EXECUTE')
           AND NOT has_function_privilege('samosval_runtime',$4,'EXECUTE') AND NOT has_function_privilege('samosval_runtime',$5,'EXECUTE')) AS read_only_grants,
       (SELECT has_table_privilege('samosval_runtime','public.archive_overrides','UPDATE') AND has_table_privilege('samosval_runtime','public.archive_overrides','DELETE')) AS receipt_catalog`,
    [RUNTIME_PROBE_TABLES,RUNTIME_PROBE_SOURCE_TABLES,RUNTIME_PROBE_FUNCTIONS[2],RUNTIME_PROBE_FUNCTIONS[0],RUNTIME_PROBE_FUNCTIONS[1]])).rows[0];
   const registry=(await q("SELECT source_hash FROM samosval_fixture_registry WHERE id='parallel-shift-runtime-role'")).rows[0];
   // Three cheap facts of the evidence matrix (design §4.6): the parent/child FK
   // exists with RESTRICT on both actions, an orphan child row is refused with
   // 23503, and neither runtime nor maintenance may write evidence. The full
   // matrix (double authority, trigger rollback, counts) stays in P8 —
   // `tests/restored-context-migration.test.mjs` — and is not duplicated here.
   const evidenceFk=(await q(`SELECT con.conname,con.confdeltype::text AS delete_rule,con.confupdtype::text AS update_rule FROM pg_constraint con
     WHERE con.contype='f' AND con.conrelid=to_regclass('public.restored_context_migration_evidence_rows')
       AND con.confrelid=to_regclass('public.restored_context_migration_evidence')`)).rows;
   const orphanPk='{"auditId":1}';
   const orphanRejected=await rejectsWith(q,`INSERT INTO restored_context_migration_evidence_rows(workspace_id,evidence_id,source_table,source_pk_canonical_jcs,source_pk_hash,source_row_sha256,representation_kind,target_table,target_pk_canonical_jcs)
     VALUES ($1,'00000000-0000-0000-0000-000000000000','line_audit',$2,$3,$4,'exact','line_audit',$2)`,
     ['main_workspace',orphanPk,sha256Hex(orphanPk),'e'.repeat(64)],/fk_restored_evidence_rows_parent|violates foreign key constraint/i,'23503');
   const evidenceInsert=`INSERT INTO restored_context_migration_evidence(workspace_id,evidence_id,legacy_shift_id,archive_id,base_archive_revision,source_locator,source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id)
     VALUES ($1,gen_random_uuid(),'legacy_fixture','archive_fixture',1,'fixture://evidence',$2,'{}','{}',$2,'context_fixture','fixture_evidence_operation')`;
   const evidenceWriteRefused=await rejectsAsRole(q,'samosval_runtime',evidenceInsert,['main_workspace','f'.repeat(64)],/permission denied for table restored_context_migration_evidence/i)
     &&await rejectsAsRole(q,'samosval_maintenance',evidenceInsert,['main_workspace','f'.repeat(64)],/permission denied for table restored_context_migration_evidence/i);
   return {
    appendOnlyClosed:probes?.archive_privileges===0,
    sourceMutationsClosed:probes?.source_mutations===0,
    schemaUsage:probes?.schema_usage===true,
    mutationRevoked:probes?.mutation_revoked===true,
    readOnlyGrants:probes?.read_only_grants===true,
    receiptCatalog:probes?.receipt_catalog===true,
    evidenceParentFk:evidenceFk.length===1&&evidenceFk[0].conname==='fk_restored_evidence_rows_parent'&&evidenceFk[0].delete_rule==='r'&&evidenceFk[0].update_rule==='r',
    evidenceOrphanRejected:orphanRejected===true,
    evidenceWriteRevoked:evidenceWriteRefused===true,
    registry:registry?.source_hash==='runtime-read-only',
   };
  }}],
]);
export const FIXTURE_IDS=Object.freeze([...registry.keys()]);
// Legacy fail-closed gate: a verifier without an explicit expectation may only
// report boolean facts, and every one of them must be literally true. A number,
// string or missing value is not a pass — only `true` is.
function passed(report){return Boolean(report)&&typeof report==='object'&&!Array.isArray(report)&&Object.values(report).every(v=>v===true);}

// Exact comparison for a verifier that reports measured values instead of
// booleans (S26 staging counts). Same key set and strict value identity, numbers
// included, so a wrong count fails closed instead of merely looking non-false.
function exactReport(actual,expected){
  if(!actual||typeof actual!=='object'||Array.isArray(actual))return false;
  const actualKeys=Object.keys(actual),expectedKeys=Object.keys(expected);
  if(actualKeys.length!==expectedKeys.length)return false;
  return expectedKeys.every(key=>Object.prototype.hasOwnProperty.call(actual,key)&&Object.is(actual[key],expected[key]));
}

// The single gate used by applyFixtures and verifyFixtures. `expect` is a
// separate contract argument and is never trusted as the report itself: the
// value returned to callers is always the verifier's measured `postcondition`.
export function postconditionSatisfied(postcondition,expect){
  return expect!==undefined?exactReport(postcondition,expect):passed(postcondition);
}
export async function applyFixtures(context,requested){
 if(!context||Object.keys(context).join()!=='query'||typeof context.query!=='function')throw new Error('fixture context is not approved');
 if(!Array.isArray(requested))throw new Error('fixture list is not approved');
 const unique=new Set();for(const id of requested){if(!registry.has(id))throw new Error(`fixture is unavailable: ${id}`);if(unique.has(id))throw new Error(`duplicate fixture: ${id}`);unique.add(id);}
 const database=(await context.query('SELECT current_database() AS database')).rows[0]?.database;if(!TARGET.test(database))throw new Error('fixture target is not approved');
 const ordered=[...unique].sort((a,b)=>registry.get(a).order-registry.get(b).order);const reports=[];
 let registryReady=false;
  for(const id of ordered){const fixture=registry.get(id);try{await context.query('BEGIN');if(!registryReady){await context.query(REGISTRY_DDL);registryReady=true;}await fixture.apply(context.query);const postcondition=await fixture.verify(context.query);if(!postconditionSatisfied(postcondition,fixture.expect))throw new Error(`fixture postcondition failed: ${id}`);await context.query('COMMIT');reports.push(Object.freeze({type:'samosval-fixture-report:v1',id,postcondition:Object.freeze(postcondition)}));}catch(error){await context.query('ROLLBACK').catch(()=>{});if(error?.code==='23505'||error?.code==='42P07')throw new Error(`fixture already applied: ${id}`);throw error;}}
 return reports;
}

// Read-only re-verification of fixtures that are already applied. It exists so
// a contract test can prove a verifier rejects tampered state instead of only
// observing that a correct fixture passes.
export async function verifyFixtures(context,requested){
 if(!context||Object.keys(context).join()!=='query'||typeof context.query!=='function')throw new Error('fixture context is not approved');
 if(!Array.isArray(requested)||requested.length===0)throw new Error('fixture list is not approved');
 const database=(await context.query('SELECT current_database() AS database')).rows[0]?.database;if(!TARGET.test(database))throw new Error('fixture target is not approved');
 const reports=[];
 for(const id of requested){if(!registry.has(id))throw new Error(`fixture is unavailable: ${id}`);const fixture=registry.get(id);const postcondition=await fixture.verify(context.query);if(!postconditionSatisfied(postcondition,fixture.expect))throw new Error(`fixture postcondition failed: ${id}`);reports.push(Object.freeze({type:'samosval-fixture-report:v1',id,postcondition:Object.freeze(postcondition)}));}
 return reports;
}
