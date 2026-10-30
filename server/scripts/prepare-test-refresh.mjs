// Compare-and-swap refresh before TEST cutover. Original imports remain immutable.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {stableSnapshot,validateMigrationSnapshot} from '../../test-app/synology/migration-snapshot.mjs';
import {parseKey,map} from '../src/tabel-access.mjs';
const text=x=>`convert_from(decode('${Buffer.from(String(x)).toString('hex')}','hex'),'UTF8')`;
const json=x=>text(JSON.stringify(x))+'::jsonb';
// Match the original prepare-test-import hash convention exactly.
export const snapshotHash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function prepareRefresh(before,after){
 const oldCounts=validateMigrationSnapshot(before),counts=validateMigrationSnapshot(after),oldSha=snapshotHash(before),sha256=snapshotHash(after),changes={};
 if(!Number.isSafeInteger(after.exportedAt)||after.exportedAt<before.exportedAt||before.exportedBy!==after.exportedBy||oldSha===sha256)throw Error('invalid-refresh-source');
 for(const name of Object.keys(before.data)){
  const old=new Map(before.data[name].map(x=>[x.id,x.data])),next=new Map(after.data[name].map(x=>[x.id,x.data]));
  const removed=[...old.keys()].filter(id=>!next.has(id)),added=[...next.keys()].filter(id=>!old.has(id)),changed=[...old.keys()].filter(id=>next.has(id)&&stableSnapshot(old.get(id))!==stableSnapshot(next.get(id)));
  if(removed.length||((added.length||changed.length)&&!['tabelNextRecords','notifications'].includes(name)))throw Error('refresh-requires-reviewed-domain:'+name);
  if(added.length||changed.length)changes[name]={added:added.length,changed:changed.length};
 }
 const rows=after.data.tabelNextRecords;
 for(const r of rows){const p=r.data,{objectId,recordId}=parseKey(p.key);if(p.objectId!==objectId||p.recordId!==recordId||p.recordId!==r.id||!Number.isSafeInteger(p.revision)||p.revision<1||!map(p.data))throw Error('invalid-tabel-refresh');}
 const sql=['\\set ON_ERROR_STOP on','BEGIN;',"DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;", "SELECT pg_advisory_xact_lock(hashtext('tabel:main_workspace'));", "SELECT id FROM workspaces WHERE id='main_workspace' FOR NO KEY UPDATE;", 'LOCK TABLE tabel_records,tabel_receipts,tabel_policy IN EXCLUSIVE MODE;',
  `DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM identity_state WHERE id=1 AND initialized AND import_sha256=${text(oldSha)}) OR NOT EXISTS(SELECT 1 FROM tabel_policy WHERE workspace_id='main_workspace' AND import_sha256=${text(oldSha)}) OR EXISTS(SELECT 1 FROM tabel_receipts WHERE workspace_id='main_workspace') OR (SELECT count(*) FROM tabel_records WHERE workspace_id='main_workspace')<>${oldCounts.tabelNextRecords} THEN RAISE EXCEPTION 'refresh target changed'; END IF; END $guard$;`];
 for(const r of before.data.tabelNextRecords)sql.push(`DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM tabel_records WHERE workspace_id='main_workspace' AND record_id=${text(r.id)} AND payload=${json(r.data)} AND baseline_payload=${json(r.data)}) THEN RAISE EXCEPTION 'NAS table differs from inspected baseline'; END IF; END $guard$;`);
 sql.push(`INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES (${text(sha256)},'main_workspace','samosval-offline',${after.exportedAt},${json(counts)});`);
 for(const [name,records] of Object.entries(after.data))for(const record of records){const path=name==='users'?'users/'+record.id:name==='registrationRequests'?'registration_requests/'+record.id:['permissions','appConfig'].includes(name)?'settings/'+record.id:'workspaces/main_workspace/'+name+'/'+record.id;sql.push(`INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES (${text(sha256)},${text(path)},${json(record.data)});`);}
 for(const record of rows){const p=record.data;sql.push(`INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload,baseline_payload) VALUES ('main_workspace',${text(record.id)},${text(p.objectId)},${text(p.key)},${json(p)},${json(p)}) ON CONFLICT(workspace_id,record_id) DO UPDATE SET payload=EXCLUDED.payload,baseline_payload=EXCLUDED.baseline_payload;`);}
 sql.push(`UPDATE identity_state SET import_sha256=${text(sha256)} WHERE id=1;`,`UPDATE tabel_policy SET import_sha256=${text(sha256)} WHERE workspace_id='main_workspace';`,'COMMIT;',"SELECT 'TEST_REFRESH_VERIFIED',count(*) FROM tabel_records WHERE workspace_id='main_workspace';",'');
 return {sql:sql.join('\n'),oldSha,sha256,counts,changes};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const [before,after,output]=process.argv.slice(2);if(!output)throw Error('Usage: prepare-test-refresh.mjs before.json after.json private-refresh.sql');const result=prepareRefresh(JSON.parse(readFileSync(before)),JSON.parse(readFileSync(after)));writeFileSync(output,result.sql,{mode:0o600});const {sql,...summary}=result;console.log(JSON.stringify(summary));}
