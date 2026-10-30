import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {normalizeRelease,digest,sourceBytes,verifiedRelease,planTestSchemaUpgrade} from '../updater/release.mjs';import {TestControlAgent} from '../updater/agent.mjs';
const file=path=>({path,sha256:'a'.repeat(64),bytes:1});
const manifest=()=>({format:'samosval-api-release',protocol:1,channel:'test',version:'4.1.1',commit:'a'.repeat(40),dependenciesSha256:'b'.repeat(64),schemaSha256:'c'.repeat(64),files:[file('src/index.mjs'),file('src/server-control.mjs')]});
test('release manifest excludes arbitrary URLs, paths, dependencies and production',()=>{
 assert.equal(normalizeRelease(manifest()).version,'4.1.1');
 for(const change of [{channel:'production'},{commit:'root'},{files:[file('../Dockerfile')]},{files:[file('src/index.mjs')]},{files:[file('src/index.mjs'),file('src/index.mjs')]},{files:[file('src/index.mjs'),{...file('src/server-control.mjs'),bytes:999999999}]}])assert.throws(()=>normalizeRelease({...manifest(),...change}));
});
test('source checksum and successful exact-commit CI are required',async()=>{
 const release=manifest(),f={...file('src/index.mjs'),bytes:2,sha256:digest('OK')};
 assert.equal(String(await sourceBytes(release,f,async()=>new Response('OK'))),'OK');
 await assert.rejects(sourceBytes(release,f,async()=>new Response('NO')),{message:'source-checksum-mismatch'});
 const calls=[];const fetchImpl=async url=>{calls.push(url);return new Response(JSON.stringify(calls.length%2?release:{workflow_runs:[{head_sha:release.commit,status:'completed',conclusion:'success',path:'.github/workflows/synology-server-tests.yml'}]}));};
 assert.equal((await verifiedRelease({fetchImpl})).commit,release.commit);assert(calls.every(x=>x.startsWith('https://raw.githubusercontent.com/iluxaspb/Samosval/')||x.startsWith('https://api.github.com/repos/iluxaspb/Samosval/')));
 await assert.rejects(verifiedRelease({fetchImpl:async url=>new Response(JSON.stringify(url.includes('api.github')?{workflow_runs:[]}:release))}),{message:'release-ci-not-successful'});
});
test('failed candidate launch returns old image without database restore',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sc-worker-')),calls=[],stages=[],old={image:'sha256:'+'a'.repeat(64),version:'4.1.0'},next={image:'sha256:'+'b'.repeat(64),version:'4.1.1'};
 try{const agent=new TestControlAgent({query:async(sql,args)=>{stages.push(args?.[1]);return {rows:[]};}},{root,docker:async args=>{calls.push(args);return '';}});let attempts=0;agent.healthy=async()=>{if(++attempts===1)throw Error('readiness-failed');};
 await assert.rejects(agent.switchTo({job_id:'job'},next,old),{message:'readiness-failed'});
 assert.deepEqual(JSON.parse(await readFile(root+'/api-override.json','utf8')).services.api,{image:old.image,environment:{SAMOSVAL_RELEASE:old.version}});assert.equal(JSON.parse(await readFile(root+'/inflight.json','utf8')),null);assert.equal(calls.length,2);assert(stages.includes('rolling_back'));assert(!calls.some(c=>c.includes('pg_restore')));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('worker restart reconciles interrupted switch before accepting another job',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sc-recover-')),calls=[],previous={image:'sha256:'+'a'.repeat(64),version:'4.1.0'};
 try{await writeFile(root+'/inflight.json',JSON.stringify({jobId:'job',previous}));const agent=new TestControlAgent({query:async sql=>({rows:sql.startsWith('SELECT')?[{job_id:'job'}]:[]})},{root,docker:async args=>{calls.push(args);return '';}});agent.healthy=async()=>{};await agent.recover();assert.equal(calls.length,1);assert.equal(JSON.parse(await readFile(root+'/inflight.json','utf8')),null);assert.equal(JSON.parse(await readFile(root+'/api-override.json','utf8')).services.api.image,previous.image);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('worker rejects traversal in database jobs before docker activity',async()=>{
 const agent=new TestControlAgent({},{docker:async()=>{throw Error('must-not-run');}});await assert.rejects(agent.execute({job_id:'../bad',type:'backup',request:{id:'../bad',type:'backup',channel:'test'}}),{code:'invalid-server-command'});
});

test('schema release only accepts pinned TEST SQL 014 and exact previous schema',()=>{
 const old='c'.repeat(64),next='d'.repeat(64);
 const upgrade={...manifest(),schemaSha256:next,previousSchemaSha256:old,
   migrations:[{path:'sql/014_reserve_outbox.sql',bytes:120,sha256:'f'.repeat(64)}]};
 const parsed=normalizeRelease(upgrade);
 const base={schemaSha256:old,dependenciesSha256:'b'.repeat(64)};
 assert.equal(planTestSchemaUpgrade(parsed,base).path,'sql/014_reserve_outbox.sql');
 assert.equal(planTestSchemaUpgrade(normalizeRelease(manifest()),base),null);
 for(const mutation of [
   {migrations:[{path:'sql/013_server_control.sql',bytes:120,sha256:'f'.repeat(64)}]},
   {migrations:[{path:'sql/014_reserve_outbox.sql',bytes:120,sha256:'f'.repeat(64)},{path:'sql/014_reserve_outbox.sql',bytes:120,sha256:'f'.repeat(64)}]},
   {previousSchemaSha256:'wrong'},{previousSchemaSha256:next},
   {migrations:[{path:'../etc/passwd',bytes:120,sha256:'f'.repeat(64)}]}
 ])assert.throws(()=>normalizeRelease({...upgrade,...mutation}));
 assert.throws(()=>planTestSchemaUpgrade(parsed,{...base,schemaSha256:'e'.repeat(64)}),/release-requires-bootstrap/);
 assert.throws(()=>planTestSchemaUpgrade(parsed,{...base,dependenciesSha256:'e'.repeat(64)}),/release-requires-bootstrap/);
 assert.throws(()=>planTestSchemaUpgrade(parsed,{...base,schemaSha256:next}),/unexpected-migration/);
 assert.throws(()=>planTestSchemaUpgrade(normalizeRelease({...manifest(),schemaSha256:next}),base),/release-requires-bootstrap/);
});
test('migration is first rehearsed on restored TEST database, never production',async()=>{
 const commands=[];
 const agent=new TestControlAgent({},{docker:async(args,opts)=>{
   commands.push({args,hasInput:!!opts?.inputFile});
   if(args[0]==='exec'&&args[1]==='pg-test'&&args.includes('-At')&&args.includes('-c'))
     return '39,1,0';
   return '';
 }});
 await assert.rejects(agent.assertOutboxInstalled('pg-test','production'),/test-database-required/);
 await agent.assertOutboxInstalled('pg-test','sc_verify_12345');
 assert.equal(commands.length,1);
 assert.equal(commands[0].args.includes('sc_verify_12345'),true);
 assert.equal(commands[0].args.some(x=>String(x).includes('DROP TABLE')),false);
});
test('worker refuses unverified/mismatched migrated schema before any API deployment',async()=>{
 const base={schemaSha256:'a'.repeat(64),dependenciesSha256:'b'.repeat(64)};
 const release=normalizeRelease({...manifest(),schemaSha256:'c'.repeat(64)});
 assert.throws(()=>planTestSchemaUpgrade(release,base),/release-requires-bootstrap/);
});
