// Guard evaluated Docker Compose configuration before a disposable lab run.
// No host mounts, exposed ports, Docker socket, default external networks
// or real server credentials are permitted.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const file=process.argv[2];
if(!file)throw Error('spark-lab-config-argument-required');
const c=JSON.parse(readFileSync(file,'utf8'));
const serviceNames=Object.keys(c.services||{}).sort();
assert.deepEqual(serviceNames,['postgres','runner']);
const net=c.networks?.lab;
assert.equal(net?.internal,true,'network must be internal, no external access');
assert.notEqual(net?.external,true);
for(const name of serviceNames){
 const s=c.services[name];
 for(const forbidden of ['ports','volumes','volumes_from','devices','secrets',
  'configs','privileged','network_mode','pid','ipc','extra_hosts','links',
  'cap_add','extends']){
  if(s[forbidden]!==undefined)throw Error('spark-lab-forbidden-'+name+'-'+forbidden);
 }
 assert.equal(s.restart,'no');
 assert.deepEqual(Object.keys(s.networks||{}),['lab']);
 assert.equal(s.labels?.['samosval.test.scope'],'disposable-synthetic');
}
const db=c.services.postgres;
assert.equal(db.image,'postgres:16-alpine');
assert.equal(db.environment?.POSTGRES_USER,'samosval_lab');
assert.equal(db.environment?.POSTGRES_DB,'samosval_test');
assert.equal(db.environment?.POSTGRES_PASSWORD,'lab_only_not_a_secret');
assert.ok(Array.isArray(db.tmpfs)&&db.tmpfs.some(x=>x.startsWith('/var/lib/postgresql/data:')));
const worker=c.services.runner;
assert.equal(worker.read_only,true);
assert.equal(worker.environment?.SPARK_LAB_ONLY,'1');
assert.equal(worker.environment?.TEST_WRITER_FENCE_ENABLED,'0');
assert.equal(worker.environment?.FIREBASE_PROJECT_ID,'samosval-offline');
assert.equal(worker.environment?.TEST_DATABASE_URL,
 'postgres://samosval_lab:lab_only_not_a_secret@postgres:5432/samosval_test');
assert.ok(Array.isArray(worker.tmpfs)&&worker.tmpfs.some(x=>x.startsWith('/tmp:')));
assert.ok(worker.build?.dockerfile?.endsWith('server/Dockerfile.spark-lab'));
console.log('SPARK_LAB_COMPOSE_ISOLATION_VERIFIED');
