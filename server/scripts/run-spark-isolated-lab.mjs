// Fresh, disposable SQL001-015 bootstrap and safety tests.
 // NEVER run this against a NAS database or using a user-provided URL.
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import pg from 'pg';

const endpoint='postgres://samosval_lab:lab_only_not_a_secret@postgres:5432/samosval_test';
if(process.env.SPARK_LAB_ONLY!=='1'||
   process.env.TEST_DATABASE_URL!==endpoint||
   process.env.FIREBASE_PROJECT_ID!=='samosval-offline'||
   process.env.TEST_WRITER_FENCE_ENABLED!=='0')
 throw Error('spark-lab-environment-not-isolated');
const url=new URL(endpoint);
if(url.hostname!=='postgres'||url.port!=='5432'||url.pathname!=='/samosval_test')
 throw Error('spark-lab-url-not-internal');
const client=new pg.Client({connectionString:endpoint,connectionTimeoutMillis:10000});
await client.connect();
try{
 const id=(await client.query(
  'SELECT current_database() AS db,current_user AS uid,'+
  ' inet_server_addr()::text AS host')).rows[0];
 if(id?.db!=='samosval_test'||id?.uid!=='samosval_lab'||!id.host||
    id.host==='127.0.0.1')
  throw Error('spark-lab-server-identity-invalid');
 const rows=(await client.query(
  "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
 if(rows!==0)throw Error('spark-lab-requires-empty-database');
 for(let n=1;n<=15;n++){
  const prefix=String(n).padStart(3,'0')+'_';
  const file=readdirSync(new URL('../sql/',import.meta.url))
   .find(f=>f.startsWith(prefix)&&f.endsWith('.sql'));
  if(!file)throw Error('spark-lab-migration-missing:'+n);
  await client.query(readFileSync(new URL('../sql/'+file,import.meta.url),'utf8'));
 }
 const gate=(await client.query(
  "SELECT to_regclass('reserve_control.writer_gate') AS relation")).rows[0]?.relation;
 if(gate!==null)throw Error('spark-lab-sql016-must-remain-manual');
 console.log('SPARK_LAB_SQL001_015_BOOTSTRAPPED_ON_DISPOSABLE_DATABASE');
}finally{await client.end();}
const tests=[
 'test-spark-pg-replay.test.mjs',
 'test-spark-upgrade-rehearsal.test.mjs',
 'test-writer-coordinator.test.mjs',
 'test-spark-auto-line-client.test.mjs',
 'test-spark-pg-dry-run.test.mjs',
 'test-spark-typed-line-reader.test.mjs',
 'test-spark-owner.test.mjs'
].map(name=>'tests/'+name);
const child=spawnSync(process.execPath,
 ['--test','--test-concurrency=1',...tests],
 {cwd:new URL('../',import.meta.url).pathname,stdio:'inherit',
  env:{...process.env,TEST_DATABASE_URL:endpoint}});
if(child.error)throw child.error;
if(child.status!==0)throw Error('spark-lab-tests-failed:'+child.status);
console.log('SPARK_ISOLATED_LAB_SUCCESS_SYNTHETIC_ONLY_NO_NAS_OR_PHONES');
