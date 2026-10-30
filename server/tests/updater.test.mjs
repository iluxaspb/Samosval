import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {normalizeRelease,digest,sourceBytes,verifiedRelease,planTestSchemaUpgrade} from '../updater/release.mjs';import {TestControlAgent,BACKUP_LIST_COMMAND,SYNTAX_CHECK_SCRIPT} from '../updater/agent.mjs';
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
 assert.equal(planTestSchemaUpgrade(parsed,{...base,schemaSha256:next}),null,'migration already applied: retry only the API image');
 assert.throws(()=>planTestSchemaUpgrade(normalizeRelease({...manifest(),schemaSha256:next}),base),/release-requires-bootstrap/);
});
test('migration is first rehearsed on restored TEST database, never production',async()=>{
 const commands=[];
 const agent=new TestControlAgent({},{docker:async(args,opts)=>{
   commands.push({args,hasInput:!!opts?.inputFile});
   if(args[0]==='exec'&&args[1]==='pg-test')
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

test('schema update rehearses on restored copy before migrating live NAS and then switches API',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sc-schema-updater-')),events=[];
 const old={image:'sha256:'+'a'.repeat(64),version:'4.1.0',postgres:'pg-test',api:'api-test'};
 const release=normalizeRelease({...manifest(),version:'4.1.1',schemaSha256:'d'.repeat(64),
   previousSchemaSha256:'c'.repeat(64),
   migrations:[{path:'sql/014_reserve_outbox.sql',sha256:digest('-- pinned'),bytes:9}]});
 try{
  await writeFile(root+'/baseline.json',JSON.stringify({
    schemaSha256:'c'.repeat(64),dependenciesSha256:'b'.repeat(64)
  }));
  const agent=new TestControlAgent({},{root,
    release:async()=>release,bytes:async(_,file)=>Buffer.from(file.path.startsWith('sql/')?'-- pinned':'x'),
    docker:async args=>{events.push(args[0]);
      if(args[0]==='image')return 'sha256:'+'e'.repeat(64);
      return '';
    }});
  agent.containers=async()=>old;
  agent.stage=async(_,stage)=>{events.push(stage);};
  agent.backup=async(_,__,{migrationFile})=>{
    events.push('backup-and-rehearse');
    if(migrationFile)assert.match(await readFile(migrationFile,'utf8'),/pinned/);
    else events.push('backup-without-migration');
  };
  agent.applyOutboxMigration=async(_,file)=>{
    events.push('live-migrate');
    assert.match(await readFile(file,'utf8'),/pinned/);
  };
  agent.switchTo=async()=>{events.push('switch-api');};
  await agent.execute({job_id:'test-schema-update',type:'update',request:{
    id:'test-schema-update',type:'update',channel:'test',releaseId:'4.1.1',expectedImage:old.image
  }});
  assert(events.indexOf('backup-and-rehearse')<events.indexOf('live-migrate'));
  assert(events.indexOf('live-migrate')<events.indexOf('switch-api'));
  const base=JSON.parse(await readFile(root+'/baseline.json','utf8'));
  assert.equal(base.schemaSha256,release.schemaSha256);
  // SQL 014 has committed. A repeated admin update or recovery after API
  // rollback must not run its DDL/trigger installation a second time.
  await agent.execute({job_id:'test-schema-update',type:'update',request:{
    id:'test-schema-update',type:'update',channel:'test',releaseId:'4.1.1',expectedImage:old.image
  }});
  assert.equal(events.filter(e=>e==='live-migrate').length,1);
  assert.equal(events.filter(e=>e==='backup-and-rehearse').length,2);
  assert.equal(events.filter(e=>e==='switch-api').length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('failed backup rehearsal leaves live schema and API untouched',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sc-schema-block-')),events=[];
 const old={image:'sha256:'+'a'.repeat(64),version:'4.1.0',postgres:'pg-test',api:'api-test'};
 const release=normalizeRelease({...manifest(),version:'4.1.1',schemaSha256:'d'.repeat(64),
   previousSchemaSha256:'c'.repeat(64),
   migrations:[{path:'sql/014_reserve_outbox.sql',sha256:digest('-- pinned'),bytes:9}]});
 try{
  await writeFile(root+'/baseline.json',JSON.stringify({
    schemaSha256:'c'.repeat(64),dependenciesSha256:'b'.repeat(64)
  }));
  const agent=new TestControlAgent({},{root,
    release:async()=>release,bytes:async()=>Buffer.from('x'),
    docker:async args=>args[0]==='image'?'sha256:'+'e'.repeat(64):''});
  agent.containers=async()=>old;
  agent.stage=async()=>{};
  agent.backup=async()=>{events.push('rehearsal-failed');throw Error('restore-test-failed');};
  agent.applyOutboxMigration=async()=>{events.push('unsafe-live-migration');};
  agent.switchTo=async()=>{events.push('unsafe-api-switch');};
  await assert.rejects(agent.execute({job_id:'test-schema-fail',type:'update',request:{
    id:'test-schema-fail',type:'update',channel:'test',releaseId:'4.1.1',expectedImage:old.image
  }}),/restore-test-failed/);
  assert.deepEqual(events,['rehearsal-failed']);
  assert.equal(JSON.parse(await readFile(root+'/baseline.json','utf8')).schemaSha256,'c'.repeat(64));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('archive TOC inspection drains a multi-megabyte stdin and preserves list errors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sc-list-stream-'));
 try{
  const {spawn}=await import('node:child_process');
  await writeFile(join(root,'pg_restore'),'#!/bin/sh\ndd bs=1 count=8 >/dev/null 2>&1\nprintf "TOC\\n"\nexit "$MOCK_LIST_EXIT"\n',{mode:0o700});
  for(const expected of [0,7]){
   const result=await new Promise((resolve,reject)=>{
    const child=spawn('sh',['-c',BACKUP_LIST_COMMAND],{env:{...process.env,PATH:root+':'+process.env.PATH,MOCK_LIST_EXIT:String(expected)},stdio:['pipe','pipe','pipe']});
    let output='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('drain-timeout'));},10000);
    child.on('error',reject);child.stdin.on('error',reject);child.stderr.resume();child.stdout.on('data',b=>output+=b);
    child.on('close',code=>{clearTimeout(timer);resolve({code,output});});
    child.stdin.end(Buffer.alloc(8*1024*1024,42));
   });
   assert.equal(result.code,expected);assert.equal(result.output,'TOC\n');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('batched candidate syntax checks accept all valid modules and reject one invalid module',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sc-check-batch-'));
 try{
  const {spawnSync}=await import('node:child_process');
  const good=join(root,'good.mjs'),bad=join(root,'bad.mjs');
  await writeFile(good,'export const valid=1;');await writeFile(bad,'export const = ;');
  assert.equal(spawnSync(process.execPath,['--input-type=module','-e',SYNTAX_CHECK_SCRIPT,good,good]).status,0);
  assert.notEqual(spawnSync(process.execPath,['--input-type=module','-e',SYNTAX_CHECK_SCRIPT,good,bad]).status,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
