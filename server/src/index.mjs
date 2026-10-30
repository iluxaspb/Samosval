import http from 'node:http';
import {installDatasetGuard,datasetRequest} from './dataset-guard.mjs';
import {readBackups,submitBackup} from './backup-store.mjs';
import {submitReport} from './report-store.mjs';
import {readArchiveSnapshot} from './archive-read.mjs';
import {readLineHistory,historyOperation} from './history-store.mjs';
import { Pool } from 'pg';
import { verifyFirebaseUser, verifyFirebaseIdentity } from './auth.mjs';
import {readSession,registerPending,readAdministration,identityOperation,readMembers} from './identity-store.mjs';
import { submitLineOperation } from './line-store.mjs';
import { readLineSnapshot } from './line-read.mjs';
import {createPresenceService} from './tabel-presence.mjs';
import {authorizeTabelPresence} from './tabel-store.mjs';
import { readTabel, commitTabel } from './tabel-store.mjs';
import { closeShiftOperation } from './shift-close.mjs';
import { startShiftOperation } from './shift-start.mjs';
import { readCatalog, submitControl } from './control-store.mjs';
import {readSettings,submitSettings} from './settings-store.mjs';
import {submitArchive} from './archive-store.mjs';
import {readGames,submitGame} from './game-store.mjs';
import {readAuxiliary,submitAuxiliary} from './auxiliary-store.mjs';

const required = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'FIREBASE_PROJECT_ID'];
for (const key of required) {
  if (!process.env[key] || process.env[key] === 'REPLACE_WITH_A_LONG_RANDOM_SECRET')
    throw new Error(`Missing or unsafe configuration: ${key}`);
}
const permittedOrigins = new Set(String(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean));
const pool = new Pool({
  host:process.env.PGHOST||'postgres', port:Number(process.env.PGPORT||5432),
  database:process.env.POSTGRES_DB, user:process.env.POSTGRES_USER,
  password:process.env.POSTGRES_PASSWORD, max:5,
  connectionTimeoutMillis:2000, idleTimeoutMillis:30000
});
installDatasetGuard(pool);
const tabelPresence=createPresenceService({authorize:(uid,target)=>authorizeTabelPresence(pool,uid,target),workspaceId:process.env.WORKSPACE_ID||'main_workspace'});
function send(res,status,body) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}
function readJson(req,limit=32768) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0,aborted=false;
    req.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>limit){aborted=true;reject(Object.assign(new Error('body-too-large'),{status:413}));req.destroy();}
      else if(!aborted)chunks.push(chunk);
    });
    req.on('end',()=>{
      if(aborted)return;
      try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
      catch{reject(Object.assign(new Error('invalid-json'),{status:400}));}
    });
    req.on('error',reject);
  });
}
const server=http.createServer((req,res)=>datasetRequest(pool,req,res,async()=>{
  const origin=req.headers.origin;
  if(origin){
    if(!permittedOrigins.has(origin)) return send(res,403,{error:'origin-not-allowed'});
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Samosval-Epoch');
    res.setHeader('Access-Control-Max-Age','600');
    res.setHeader('Access-Control-Expose-Headers','X-Samosval-Epoch');
  }
  const requestUrl=new URL(req.url||'/', 'http://localhost');
  const path=requestUrl.pathname;
  if(req.method==='OPTIONS')return send(res,204,{});
  if(req.method==='GET' && path==='/health/live')return send(res,200,{status:'ok'});
  if(req.method==='GET' && path==='/health/ready'){
    try{await pool.query('SELECT 1');return send(res,200,{status:'ready',database:'connected'});}
    catch{return send(res,503,{status:'unavailable'});}
  }
  if(path==='/api/v1/backups'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readBackups(pool,uid,requestUrl.searchParams.get('id')));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitBackup(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;if(status===500)console.error('[backup-api] request failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'server-error':e.code||e.message});}
  }
  if(path==='/api/v1/auxiliary'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readAuxiliary(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitAuxiliary(pool,uid,await readJson(req,8000000)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;if(status===500)console.error('[auxiliary-api] request failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'server-error':e.code||e.message});}
  }
  if(path==='/api/v1/report/operations'&&req.method==='POST'){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitReport(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;if(status===500)console.error('[report-api] request failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'server-error':e.code||e.message});}
  }
  if(path==='/api/v1/settings'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readSettings(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitSettings(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;if(status===500)console.error('[settings-api] request failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'server-error':e.code||e.message});}
  }
  if(path==='/api/v1/games'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readGames(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitGame(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;if(status===500)console.error('[game-api] request failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'server-error':e.code||e.message});}
  }
  if(path==='/api/v1/archive/snapshot'&&req.method==='GET'){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{return send(res,200,await readArchiveSnapshot(pool,uid));}
    catch(e){
      const status=[400,403,409].includes(e.status)?e.status:500;
      if(status===500)console.error('[archive-api] request failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(path==='/api/v1/archive/operations'&&req.method==='POST'){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitArchive(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;if(status===500)console.error('[archive-api] mutation failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'server-error':e.code||e.message});}
  }
  if(path==='/api/v1/history'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readLineHistory(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await historyOperation(pool,uid,await readJson(req)));
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[history-api] request failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(path==='/api/v1/registration'&&req.method==='POST'){
    const identity=await verifyFirebaseIdentity(req);
    if(!identity)return send(res,401,{error:'unauthorized'});
    try{
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await registerPending(pool,identity,await readJson(req)));
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[registration-api] request failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(req.method==='GET'&&['/api/v1/session','/api/v1/members','/api/v1/admin/access'].includes(path)||req.method==='POST'&&path==='/api/v1/admin/access'){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(path==='/api/v1/session')return send(res,200,await readSession(pool,uid));
      if(path==='/api/v1/members')return send(res,200,await readMembers(pool,uid));
      if(req.method==='GET')return send(res,200,await readAdministration(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await identityOperation(pool,uid,await readJson(req)));
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[identity-api] request failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if((path==='/api/v1/catalog'&&req.method==='GET')||(path==='/api/v1/controls'&&req.method==='POST')){
    const uid=await verifyFirebaseUser(req);
    if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readCatalog(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitControl(pool,uid,await readJson(req)));
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[control-api] request failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(path==='/api/v1/tabel/presence'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await tabelPresence.list(uid,Object.fromEntries(requestUrl.searchParams)));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await tabelPresence.write(uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413,429].includes(e.status)?e.status:500;if(status===500)console.error('[presence-api] request failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'server-error':e.code||e.message});}
  }
  if(path==='/api/v1/tabel/records' && ['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);
    if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET'){
        const query=Object.fromEntries(requestUrl.searchParams);
        return send(res,200,await readTabel(pool,uid,query));
      }
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))
        return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await commitTabel(pool,uid,await readJson(req,800000)));
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[tabel-api] request failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(path==='/api/v1/shifts/start'&&req.method==='POST'){
    const uid=await verifyFirebaseUser(req);
    if(!uid)return send(res,401,{error:'unauthorized'});
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))
      return send(res,415,{error:'unsupported-media-type'});
    try{return send(res,200,await startShiftOperation(pool,uid,await readJson(req)));}
    catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[shift-api] start failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(path==='/api/v1/shifts/close'&&req.method==='POST'){
    const uid=await verifyFirebaseUser(req);
    if(!uid)return send(res,401,{error:'unauthorized'});
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))
      return send(res,415,{error:'unsupported-media-type'});
    try{return send(res,200,await closeShiftOperation(pool,uid,await readJson(req)));}
    catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[shift-api] close failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(path==='/api/v1/line/snapshot'&&req.method==='GET'){
    const uid=await verifyFirebaseUser(req);
    if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      const snapshot=await readLineSnapshot(pool,uid);
      return send(res,200,snapshot);
    }catch(e){
      const status=[403,409].includes(e.status)?e.status:500;
      if(status===500)console.error('[line-api] snapshot failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.message});
    }
  }
  if(path==='/api/v1/line/operations'&&req.method==='POST'){
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))
      return send(res,415,{error:'unsupported-media-type'});
    const uid=await verifyFirebaseUser(req);
    if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      const op=await readJson(req);
      const outcome=await submitLineOperation(pool,uid,op);
      return send(res,200,outcome);
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[line-api] operation failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message||'invalid'});
    }
  }
  return send(res,404,{error:'not-found'});
}));
const port=Number(process.env.PORT||8080);
server.listen(port,'0.0.0.0',()=>console.info(`Samosval TEST API listening on ${port}`));
let stopping=false;
async function shutdown(){
  if(stopping)return;
  stopping=true;
  server.close();
  try{await pool.end();}finally{process.exit(0);}
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);



