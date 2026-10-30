// Independent TEST control worker. No HTTP listener and no user-supplied commands.
import {readFile,writeFile,mkdir,rename,copyFile,stat,statfs,readdir} from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {verifiedRelease,normalizeRelease,sourceBytes,planTestSchemaUpgrade} from './release.mjs';
import {normalizeServerCommand} from '../src/server-control.mjs';
const CONTROL='/control',COMPOSE='/volume2/docker/samosval-test-candidate/compose.yaml',PROJECT='samosval-test-candidate';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safeError=e=>/^[a-z0-9-]{1,100}$/.test(e.message)?e.message:'control-step-failed';
const imageId=x=>typeof x==='string'&&/^sha256:[a-f0-9]{64}$/.test(x);
const containerId=x=>typeof x==='string'&&/^[a-f0-9]{12,64}$/.test(x);
// pg_restore --list reads only the archive TOC. Drain the remaining bytes
// before closing Docker stdin, retaining the real pg_restore exit status.
export const BACKUP_LIST_COMMAND='pg_restore --list; list_status=$?; cat >/dev/null; exit "$list_status"';
// Validate every pinned module in one isolated container, avoiding one costly
// Synology container mount/start per source file. Each file still uses --check.
export const SYNTAX_CHECK_SCRIPT="import {spawnSync} from 'node:child_process'; for(const file of process.argv.slice(1)){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}";
export async function run(args,{inputFile,outputFile,timeout=180000}={}){
 return new Promise((accept,reject)=>{
  const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']}),chunks=[];let size=0,done=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('docker-timeout'));},timeout);
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):accept(value);};
  child.on('error',()=>finish(Error('docker-start-failed')));child.stderr.resume();
  const output=outputFile?pipeline(child.stdout,createWriteStream(outputFile,{mode:0o600})):Promise.resolve();
  if(!outputFile)child.stdout.on('data',b=>{size+=b.length;if(size>3000000){child.kill('SIGKILL');finish(Error('docker-output-too-large'));}else chunks.push(b);});
  const input=inputFile?pipeline(createReadStream(inputFile),child.stdin):Promise.resolve(child.stdin.end());
  // Attach rejection handlers immediately, including failures before process exit.
  input.catch(()=>{child.kill('SIGKILL');finish(Error('docker-input-failed'));});output.catch(()=>{child.kill('SIGKILL');finish(Error('docker-output-failed'));});
  child.on('close',async code=>{try{await Promise.all([input,output]);finish(code===0?null:Error('docker-command-failed'),Buffer.concat(chunks).toString('utf8').trim());}catch{finish(Error('docker-stream-failed'));}});
 });
}
async function atomic(path,value){const temp=path+'.tmp';await writeFile(temp,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});await rename(temp,path);}
async function readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export class TestControlAgent{
 constructor(pool,{docker=run,release=verifiedRelease,bytes=sourceBytes,root=CONTROL}={}){this.pool=pool;this.docker=docker;this.getRelease=release;this.getBytes=bytes;this.root=root;this.state={protocol:1,workerVersion:'4.1.1',host:{},backups:[],rollbackAvailable:false};}
 async containers(){
  const api=await this.docker(['ps','-q','--filter','label=com.docker.compose.project='+PROJECT,'--filter','label=com.docker.compose.service=api']);
  const postgres=await this.docker(['ps','-q','--filter','label=com.docker.compose.project=samosval-test','--filter','label=com.docker.compose.service=postgres']);
  if(!containerId(api)||!containerId(postgres))throw Error('test-containers-not-unique');
  const info=JSON.parse(await this.docker(['inspect',api]));
  const pgInfo=JSON.parse(await this.docker(['inspect',postgres]));
  if(!pgInfo[0]?.Config?.Env?.includes('POSTGRES_DB=samosval_test'))throw Error('test-database-required');
  if(!imageId(info[0]?.Image))throw Error('invalid-api-image');
  return {api,postgres,image:info[0].Image,version:info[0].Config.Env.find(s=>s.startsWith('SAMOSVAL_RELEASE='))?.slice(17)||'4.0.2'};
 }
 async heartbeat(){
  const before=await readJson(this.root+'/previous.json',null),images=await this.containers();
  let host={};try{
   const mem=await readFile('/host/proc/meminfo','utf8'),get=name=>Number(new RegExp('^'+name+':\\s+(\\d+)','m').exec(mem)?.[1])*1024;
   const total=get('MemTotal'),free=get('MemAvailable'),disk=await statfs('/nas-volume');
   host={memory:{totalBytes:total,usedBytes:total-free},load:(await readFile('/host/proc/loadavg','utf8')).trim().split(/\s+/).slice(0,3).map(Number),disk:{totalBytes:disk.blocks*disk.bsize,availableBytes:disk.bavail*disk.bsize}};
  }catch{/* Do not substitute container metrics for unavailable host measurements. */}
  const backups=[];
  for(const name of (await readdir(this.root+'/backups').catch(()=>[])).sort().slice(-40).reverse()){
   const meta=await readJson(this.root+'/backups/'+name+'/verified.json',null);if(meta)backups.push(meta);
  }
  Object.assign(this.state,{host,imageId:images.image,installedVersion:images.version,rollbackAvailable:!!before&&before.image!==images.image,backups});
  await this.pool.query("INSERT INTO server_control_state(channel,heartbeat,payload) VALUES ('test',now(),$1) ON CONFLICT(channel) DO UPDATE SET heartbeat=now(),payload=EXCLUDED.payload",[this.state]);
 }
 async stage(job,stage,detail={}){
  await this.pool.query("UPDATE server_control_jobs SET stage=$2,detail=detail||$3::jsonb,updated_at=now() WHERE job_id=$1",[job.job_id,stage,JSON.stringify(detail)]);
  await this.pool.query('INSERT INTO server_control_events(job_id,stage) VALUES ($1,$2)',[job.job_id,stage]);
 }
 async backup(job,containers,{migrationFile=null}={}){
  await this.stage(job,'backing_up');const dir=this.root+'/backups/'+Date.now()+'_'+job.job_id;await mkdir(dir,{recursive:true,mode:0o700});
  const dump=dir+'/database.dump',verify='sc_verify_'+Date.now();
  await this.docker(['exec',containers.postgres,'sh','-c','pg_dump -U "$POSTGRES_USER" -d samosval_test -Fc'],{outputFile:dump,timeout:300000});
  if((await stat(dump)).size<1)throw Error('empty-backup');
  await this.docker(['exec','-i',containers.postgres,'sh','-c',BACKUP_LIST_COMMAND],{inputFile:dump,outputFile:dir+'/contents.txt'});
  await this.docker(['exec',containers.postgres,'sh','-c','createdb -U "$POSTGRES_USER" "$1"','sh',verify]);
  try{
   await this.docker(['exec','-i',containers.postgres,'sh','-c','pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error --no-owner','sh',verify],{inputFile:dump,timeout:300000});
   if(migrationFile){
     // Apply the exact pinned SQL to a freshly restored throwaway database.
     // This never changes the live test database or any production database.
     await this.docker(['exec','-i',containers.postgres,'sh','-c',
       'psql -X -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1','sh',verify],
       {inputFile:migrationFile,timeout:300000});
     await this.assertOutboxInstalled(containers.postgres,verify);
   }
   await this.docker(['exec',containers.postgres,'sh','-c','psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -At -c "SELECT (SELECT count(*) FROM app_users),(SELECT count(*) FROM line_trucks),(SELECT count(*) FROM line_logs),(SELECT count(*) FROM tabel_records)"','sh',verify],{outputFile:dir+'/restored-counts.txt'});
  }finally{await this.docker(['exec',containers.postgres,'sh','-c','dropdb -U "$POSTGRES_USER" "$1"','sh',verify]);}
  const meta={createdAt:Date.now(),bytes:(await stat(dump)).size,restored:true,id:dir.split('/').at(-1)};
  await atomic(dir+'/verified.json',meta);return meta;
 }
 async assertOutboxInstalled(postgres,database='samosval_test'){
  if(!/^samosval_test$|^sc_verify_[0-9]+$/.test(database))throw Error('test-database-required');
  const probe=`SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='reserve_row_change' AND NOT tgisinternal)
    ||','||(SELECT count(*) FROM reserve_outbox_cursor WHERE singleton=true)
    ||','||(SELECT count(*) FROM reserve_replica_receipt)`;
  const answer=(await this.docker(['exec',postgres,'sh','-c',
    'psql -X -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -At -c "$2"',
    'sh',database,probe])).trim();
  const [triggers,cursors,receipts]=answer.split(',').map(Number);
  if(triggers!==39||cursors!==1||receipts>1||!Number.isSafeInteger(receipts))
    throw Error('outbox-schema-verification-failed');
 }
 async applyOutboxMigration(postgres,migrationFile){
  await this.docker(['exec','-i',postgres,'sh','-c',
    'test "$POSTGRES_DB" = samosval_test && psql -X -U "$POSTGRES_USER" -d samosval_test -v ON_ERROR_STOP=1'],
    {inputFile:migrationFile,timeout:300000});
  await this.assertOutboxInstalled(postgres);
 }
 async compose(){return this.docker(['compose','-p',PROJECT,'-f',COMPOSE,'-f',this.root+'/api-override.json','up','-d','--no-deps','--no-build','api'],{timeout:180000});}
 async setImage(image,version){if(!imageId(image)||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw Error('invalid-image-target');await atomic(this.root+'/api-override.json',{services:{api:{image,environment:{SAMOSVAL_RELEASE:version}}}});}
 async healthy(){
  const c=await this.containers();
  await this.docker(['exec',c.api,'node','--input-type=module','-e','for(let i=0;i<40;i++){try{let r=await fetch("http://127.0.0.1:8080/health/ready",{signal:AbortSignal.timeout(2000)});if(r.status===200)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)'],{timeout:125000});
  await this.docker(['exec',c.api,'node','--input-type=module','-e','for(const p of ["/api/v1/admin/server","/api/v1/line/snapshot","/api/v1/games"]){const r=await fetch("http://127.0.0.1:8080"+p,{signal:AbortSignal.timeout(3000)});if(r.status!==401)throw Error("auth-check-failed")}'],{timeout:20000});
 }
 async switchTo(job,next,previous){
  // Persist rollback intent BEFORE changing the API. Worker restart reconciles it.
  await atomic(this.root+'/inflight.json',{jobId:job.job_id,previous});
  try{await this.stage(job,'switching');await this.setImage(next.image,next.version);await this.compose();await this.stage(job,'validating');await this.healthy();}
  catch(error){await this.stage(job,'rolling_back');try{await this.setImage(previous.image,previous.version);await this.compose();await this.healthy();await atomic(this.root+'/inflight.json',null);}catch{throw Error('rollback-failed');}throw error;}
  await atomic(this.root+'/previous.json',previous);await atomic(this.root+'/inflight.json',null);
 }
 async execute(job){
  const request=normalizeServerCommand(job.request);if(request.id!==job.job_id||request.type!==job.type)throw Error('invalid-job');
  const c=await this.containers();
  if(['update','rollback'].includes(job.type)&&request.expectedImage!==c.image)throw Error('server-image-changed');
  if(job.type==='check'){
   await this.stage(job,'verifying');const release=await this.getRelease();
   const base=await readJson(this.root+'/baseline.json',null);
   const migration=planTestSchemaUpgrade(release,base);
   await atomic(this.root+'/release.json',release);
   this.state.release={version:release.version,commit:release.commit,notes:release.notes,
     verified:true,schemaMigrationRequired:!!migration};return;
  }
  if(job.type==='backup'){await this.backup(job,c);return;}
  if(job.type==='restart'){await this.stage(job,'switching');await this.docker(['restart','--time','20',c.api]);await this.stage(job,'validating');await this.healthy();return;}
  if(job.type==='rollback'){
   const previous=await readJson(this.root+'/previous.json',null);if(!previous||previous.image===c.image)throw Error('rollback-unavailable');
   await this.backup(job,c);await this.switchTo(job,previous,{image:c.image,version:c.version});return;
  }
  if(job.type!=='update')throw Error('invalid-job-type');
  // Re-read trusted GitHub manifest and CI at execution time, never trust browser input.
  const release=normalizeRelease(await this.getRelease()),base=await readJson(this.root+'/baseline.json',null);
  if(release.version!==request.releaseId)throw Error('release-changed');
  const migration=planTestSchemaUpgrade(release,base);
  await this.stage(job,'downloading');const dir=this.root+'/staging/'+job.job_id;
  await mkdir(dir+'/src',{recursive:true,mode:0o700});
  if(migration)await mkdir(dir+'/sql',{recursive:true,mode:0o700});
  let disk=await statfs(this.root);if(disk.bavail*disk.bsize<512*1024*1024)throw Error('insufficient-disk-space');
  for(const file of release.files)await writeFile(dir+'/'+file.path,await this.getBytes(release,file),{mode:0o600});
  const migrationFile=migration?dir+'/'+migration.path:null;
  if(migrationFile)await writeFile(migrationFile,await this.getBytes(release,migration),{mode:0o600});
  await this.stage(job,'verifying');
  const tag='samosval-test-api:control-'+release.commit.slice(0,16);
  await writeFile(dir+'/Dockerfile',`FROM ${c.image}\nCOPY --chown=node:node src /app/src\nENV SAMOSVAL_RELEASE=${release.version}\n`);
  await this.docker(['build','--network','none','-t',tag,dir],{timeout:300000});
  const nextImage=await this.docker(['image','inspect','--format','{{.Id}}',tag]);if(!imageId(nextImage))throw Error('image-not-built');
  await this.docker(['run','--rm','--network','none','--read-only','--entrypoint','node',nextImage,
    '--input-type=module','-e',SYNTAX_CHECK_SCRIPT,...release.files.map(f=>f.path)]);
  await this.backup(job,c,{migrationFile});
  // Another administrator or maintenance script must not be overwritten.
  if((await this.containers()).image!==c.image)throw Error('server-image-changed');
  if(migrationFile){
    await this.stage(job,'migrating');
    // The SQL is additive and transactional. On a later API rollback we do
    // NOT restore old database bytes and never discard newly committed trips.
    await this.applyOutboxMigration(c.postgres,migrationFile);
    // Record real installed schema before API swap: if the worker crashes,
    // the next run must not mistake migrated SQL for the old baseline.
    await atomic(this.root+'/baseline.json',{
      ...base,schemaSha256:release.schemaSha256
    });
  }
  await this.switchTo(job,{image:nextImage,version:release.version},{image:c.image,version:c.version});
 }
 async recover(){
  const journal=await readJson(this.root+'/inflight.json',null);
  if(journal){await this.setImage(journal.previous.image,journal.previous.version);await this.compose();await this.healthy();await atomic(this.root+'/inflight.json',null);}
  const jobs=(await this.pool.query("SELECT job_id FROM server_control_jobs WHERE status='running' AND channel='test'")).rows;
  for(const job of jobs){await this.stage(job,'interrupted',{error:'worker-restarted'});await this.pool.query("UPDATE server_control_jobs SET status='failed',updated_at=now() WHERE job_id=$1",[job.job_id]);}
 }
 async next(){
  const job=(await this.pool.query("UPDATE server_control_jobs SET status='running',updated_at=now() WHERE job_id=(SELECT job_id FROM server_control_jobs WHERE channel='test' AND status='queued' ORDER BY created_at LIMIT 1) RETURNING *")).rows[0];if(!job)return false;
  try{
   const actor=(await this.pool.query('SELECT role,status,profile FROM app_users WHERE uid=$1',[job.uid])).rows[0];
   if(actor?.role!=='admin'||actor.status!=='active'||actor.profile?.deleted)throw Error('administrator-access-revoked');
   await this.execute(job);await this.stage(job,'ready');await this.pool.query("UPDATE server_control_jobs SET status='succeeded',updated_at=now() WHERE job_id=$1",[job.job_id]);
  }catch(e){await this.stage(job,'failed',{error:safeError(e)});await this.pool.query("UPDATE server_control_jobs SET status='failed',updated_at=now() WHERE job_id=$1",[job.job_id]);if(e.message==='rollback-failed')throw e;}
  return true;
 }
}
export async function main(){
 if(process.env.POSTGRES_DB!=='samosval_test')throw Error('test-database-required');
 const pool=new pg.Pool({host:process.env.PGHOST||'postgres',port:Number(process.env.PGPORT||5432),database:process.env.POSTGRES_DB,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,max:3,connectionTimeoutMillis:5000});
 const lock=await pool.connect();
 if(!(await lock.query("SELECT pg_try_advisory_lock(hashtext('samosval-test-control-agent')) AS locked")).rows[0].locked)throw Error('control-agent-already-running');
 lock.on('error',()=>process.exit(1)); // Losing the exclusive session stops all worker activity.
 await mkdir(CONTROL+'/backups',{recursive:true,mode:0o700});
 const agent=new TestControlAgent(pool);await agent.recover();
 const timer=setInterval(()=>void agent.heartbeat().catch(()=>{}),15000);timer.unref();
 for(;;){try{await agent.heartbeat();await agent.next();}catch(e){if(e.message==='rollback-failed')throw e;console.error('[server-control] control-cycle-failed');}await sleep(3000);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('[server-control] startup-failed');process.exit(1);});
