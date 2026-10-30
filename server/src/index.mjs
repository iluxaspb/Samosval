import http from 'node:http';
import { Pool } from 'pg';
import { verifyFirebaseUser } from './auth.mjs';
import { submitLineOperation } from './line-store.mjs';
import { readLineSnapshot } from './line-read.mjs';
import { readTabel, commitTabel } from './tabel-store.mjs';
import { closeShiftOperation } from './shift-close.mjs';
import { startShiftOperation } from './shift-start.mjs';
import { readCatalog, submitControl } from './control-store.mjs';

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
const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  if(origin){
    if(!permittedOrigins.has(origin)) return send(res,403,{error:'origin-not-allowed'});
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age','600');
  }
  const requestUrl=new URL(req.url||'/', 'http://localhost');
  const path=requestUrl.pathname;
  if(req.method==='OPTIONS')return send(res,204,{});
  if(req.method==='GET' && path==='/health/live')return send(res,200,{status:'ok'});
  if(req.method==='GET' && path==='/health/ready'){
    try{await pool.query('SELECT 1');return send(res,200,{status:'ready',database:'connected'});}
    catch{return send(res,503,{status:'unavailable'});}
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
});
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


