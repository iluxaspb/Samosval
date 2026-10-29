// Converts an inspected TEST export into an atomic, empty-database-only psql import.
// The generated SQL contains private application data. Never commit it to GitHub.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateMigrationSnapshot } from '../../test-app/synology/migration-snapshot.mjs';

const json=value=>`convert_from(decode('${Buffer.from(JSON.stringify(value),'utf8').toString('hex')}','hex'),'UTF8')::jsonb`;
const str=value=>`convert_from(decode('${Buffer.from(String(value),'utf8').toString('hex')}','hex'),'UTF8')`;
export function prepareImport(payload,{cycleMinutes}={}){
  const counts=validateMigrationSnapshot(payload),data=payload.data;
  if(!Number.isSafeInteger(payload.exportedAt)||payload.exportedAt<=0)throw new Error('Export timestamp is required');
  const shift=data.shift[0].data, workspace=payload.workspaceId;
  if(typeof shift.isActive!=='boolean')throw new Error('Shift activity must be explicit');
  const configuredCycle=data.appConfig[0]?.data?.cycleMinutes;
  const cycle=cycleMinutes??configuredCycle;
  if(!Number.isSafeInteger(cycle)||cycle<15||cycle>10080)throw new Error('Explicit server cycle minutes required (15..10080)');
  const trucks=new Set(data.trucks.map(record=>record.id));
  for(const record of data.logs){
    if(record.data.shiftId!==shift.id||!trucks.has(record.data.truckId))throw new Error('Log has an unknown shift or truck');
  }
  for(const record of data.truckStatus)if(record.data.shiftId!==shift.id)throw new Error('Status belongs to another shift');
  for(const record of data.users){
    if(!['active','pending','disabled'].includes(record.data.status)||typeof record.data.role!=='string'||typeof record.data.email!=='string')throw new Error('Invalid account profile');
  }
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const sql=[String.raw`\set ON_ERROR_STOP on`, 'BEGIN;',
    `DO $guard$ BEGIN IF current_database() <> 'samosval_test' THEN RAISE EXCEPTION 'Import allowed only in samosval_test'; END IF; END $guard$;`,
    `SELECT pg_advisory_xact_lock(hashtext('samosval-test-initial-import'));`,
    'LOCK TABLE app_users, role_permissions, shifts, line_trucks, line_truck_statuses, line_logs, line_operation_receipts, line_audit IN EXCLUSIVE MODE;',
    `DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM app_users) OR EXISTS(SELECT 1 FROM role_permissions) OR EXISTS(SELECT 1 FROM shifts) OR EXISTS(SELECT 1 FROM line_trucks) OR EXISTS(SELECT 1 FROM line_truck_statuses) OR EXISTS(SELECT 1 FROM line_logs) OR EXISTS(SELECT 1 FROM line_operation_receipts) OR EXISTS(SELECT 1 FROM line_audit) THEN RAISE EXCEPTION 'Target is not empty; refusing to overwrite'; END IF; END $guard$;`,
    'CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY, workspace_id text NOT NULL, source_project text NOT NULL, exported_at bigint NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(), counts jsonb NOT NULL);',
    'CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256), document_path text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(import_sha256,document_path));',
    `INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES (${str(hash)},${str(workspace)},${str(payload.firebaseProjectId)},${Number(payload.exportedAt)},${json(counts)});`,
    `INSERT INTO workspaces(id,cycle_minutes) VALUES (${str(workspace)},${cycle}) ON CONFLICT(id) DO UPDATE SET cycle_minutes=EXCLUDED.cycle_minutes;`
  ];
  for(const record of data.users)sql.push(`INSERT INTO app_users(uid,email,display_name,role,status) VALUES (${str(record.id)},${str(record.data.email)},${str(record.data.nickname||record.data.displayName||record.data.email)},${str(record.data.role)},${str(record.data.status)});`);
  for(const [role,permissions] of Object.entries(data.permissions[0].data)){
    if(!permissions||typeof permissions!=='object')throw new Error('Invalid permissions');
    for(const [field,prefix] of [['tabs','tab_'],['actions','']]){
      const values=permissions[field]??[];
      if(!Array.isArray(values)||values.some(value=>typeof value!=='string'))throw new Error('Invalid role permissions');
      for(const action of new Set(values))sql.push(`INSERT INTO role_permissions(role,action,allowed) VALUES (${str(role)},${str(prefix+action)},true);`);
    }
  }
  sql.push(`INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES (${str(workspace)},${str(shift.id)},${shift.isActive?'true':'false'},${json(shift)});`);
  for(const record of data.trucks)sql.push(`INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES (${str(workspace)},${str(record.id)},${json(record.data)});`);
  for(const record of data.truckStatus)sql.push(`INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES (${str(workspace)},${str(record.id)},${str(shift.id)},${json(record.data)});`);
  for(const record of data.logs)sql.push(`INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES (${str(workspace)},${str(record.id)},${str(shift.id)},${str(record.data.truckId)},${json(record.data)});`);
  for(const [name,records] of Object.entries(data)){
    if(!Array.isArray(records))continue;
    for(const record of records){
      let path;
      if(name==='users')path='users/'+record.id;
      else if(name==='registrationRequests')path='registration_requests/'+record.id;
      else if(['permissions','appConfig'].includes(name))path='settings/'+record.id;
      else path='workspaces/'+workspace+'/'+name+'/'+record.id;
      sql.push(`INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES (${str(hash)},${str(path)},${json(record.data)});`);
    }
  }
  sql.push('COMMIT;',"SELECT 'users' AS section,count(*) FROM app_users UNION ALL SELECT 'trucks',count(*) FROM line_trucks UNION ALL SELECT 'statuses',count(*) FROM line_truck_statuses UNION ALL SELECT 'logs',count(*) FROM line_logs;",'');
  return {sql:sql.join('\n'),counts,sha256:hash,cycleMinutes:cycle};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,output,override]=process.argv.slice(2);
  if(!input||!output)throw new Error('Usage: node prepare-test-import.mjs export.json private-import.sql [cycle-minutes]');
  const result=prepareImport(JSON.parse(readFileSync(input,'utf8')),{cycleMinutes:override===undefined?undefined:Number(override)});
  writeFileSync(output,result.sql,{mode:0o600});
  console.log(JSON.stringify({output,sha256:result.sha256,cycleMinutes:result.cycleMinutes,counts:result.counts}));
}
