import http from 'node:http';
import {readServerControl,submitServerCommand,observeServerRequest} from './server-control.mjs';
import {sendJson as send} from './json-response.mjs';
import {readNotifications,submitNotificationTest,deliverNotification} from './notification-store.mjs';
import {installDatasetGuard,datasetRequest} from './dataset-guard.mjs';
import {readBackups,submitBackup} from './backup-store.mjs';
import {submitReport} from './report-store.mjs';
import {readArchiveSnapshot} from './archive-read.mjs';
import {readLineHistory,historyOperation} from './history-store.mjs';
import { Pool } from 'pg';
import { verifyFirebaseUser, verifyFirebaseIdentity } from './auth.mjs';
import {readSession,registerPending,readAdministration,identityOperation,readMembers,
  registerWithPassword,loginWithPassword,refreshSession,logoutSession,revokeAllSessions,
  listSessions,revokeSession,issuePasswordReset,consumePasswordReset} from './identity-store.mjs';
import {loadSessionSecret} from './auth-config.mjs';
import {verifySession} from './auth-local.mjs';
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
import {handleHealthRequest} from './health.mjs';
import {readAuthorityState,switchAuthority,assertWriteAuthority,touchPresence} from './authority.mjs';
import {appendReplicaBatch,readReplicaJournal} from './replica-store.mjs';

const required = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'FIREBASE_PROJECT_ID'];
for (const key of required) {
  if (!process.env[key] || process.env[key] === 'REPLACE_WITH_A_LONG_RANDOM_SECRET')
    throw new Error(`Missing or unsafe configuration: ${key}`);
}
const permittedOrigins = new Set(String(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean));
// Секрет подписи сессий загружается один раз при старте: он нужен локальному
// входу и проверке токенов. Заданный, но неверный секрет останавливает запуск,
// отсутствующий — заменяется временным на процесс (auth-config предупреждает).
const sessionSecret = await loadSessionSecret();
const pool = new Pool({
  host:process.env.PGHOST||'postgres', port:Number(process.env.PGPORT||5432),
  database:process.env.POSTGRES_DB, user:process.env.POSTGRES_USER,
  password:process.env.POSTGRES_PASSWORD, max:5,
  connectionTimeoutMillis:2000, idleTimeoutMillis:30000
});
installDatasetGuard(pool);
const tabelPresence=createPresenceService({authorize:(uid,target)=>authorizeTabelPresence(pool,uid,target),workspaceId:process.env.WORKSPACE_ID||'main_workspace'});
function readJson(req,limit=262144) {
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
const RESET_REQUEST_MESSAGE='Если учётная запись с такой почтой существует, ссылка для восстановления отправлена.';
const AUTH_ERROR_STATUSES=new Set([400,401,403,409,413,415,429]);
// Ответы локального входа не должны раскрывать текст ошибки базы: наружу
// уходит только короткий код из белого списка, остальное — в журнал.
function authFailure(res,error,label){
  const status=AUTH_ERROR_STATUSES.has(error?.status)?error.status:500;
  if(status===500)console.error('[auth-api] '+label+' failed',error?.code||error?.name||'unknown');
  const code=typeof error?.code==='string'&&/^[a-z][a-z0-9-]{1,63}$/.test(error.code)?error.code:'invalid-request';
  return send(res,status,{error:status===500?'server-error':code});
}
const jsonBody=req=>String(req.headers['content-type']||'').toLowerCase().startsWith('application/json');
const bodyObject=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const textValue=value=>typeof value==='string'?value:'';
const hasTokens=result=>!!(result&&(result.tokens||result.accessToken||result.refreshToken));
// В журнал устройств уходят только признаки устройства, без адресов и токенов.
function deviceInfoFrom(req,body){
  const info={...bodyObject(body?.device)};
  if(!info.userAgent&&req.headers['user-agent'])info.userAgent=String(req.headers['user-agent']);
  return info;
}
// Проверка локального access-токена: подпись, тип и срок проверяет auth-local,
// затем база подтверждает, что сессия не отозвана и не истекла, а профиль
// активен и не удалён. Ошибка базы не превращается в успешную проверку.
async function verifyAccessToken(req){
  const match=/^Bearer\s+([A-Za-z0-9._-]{1,4096})$/i.exec(String(req.headers.authorization||'').trim());
  if(!match)return null;
  const claims=await verifySession(match[1],{secret:sessionSecret,type:'access'});
  if(!claims||typeof claims.sid!=='string'||!claims.sid||claims.sid.length>128)return null;
  const row=(await pool.query("SELECT s.id,s.uid,s.expires_at,s.revoked_at,u.status,u.profile FROM user_sessions s JOIN app_users u ON u.uid=s.uid WHERE s.id=$1 AND s.uid=$2",[claims.sid,claims.uid])).rows[0];
  if(!row||row.revoked_at||new Date(row.expires_at).getTime()<=Date.now())return null;
  if(row.status!=='active'||row.profile?.deleted)return null;
  return {uid:row.uid,sid:row.id};
}
const server=http.createServer((req,res)=>datasetRequest(pool,req,res,async()=>{
  observeServerRequest(req,res);
  const origin=req.headers.origin;
  if(origin){
    if(!permittedOrigins.has(origin)) return send(res,403,{error:'origin-not-allowed'});
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Samosval-Epoch, X-Samosval-Generation, If-None-Match');
    res.setHeader('Access-Control-Max-Age','600');
    res.setHeader('Access-Control-Expose-Headers','X-Samosval-Epoch, X-Samosval-Generation, ETag');
  }
  const requestUrl=new URL(req.url||'/', 'http://localhost');
  const path=requestUrl.pathname;
  if(req.method==='OPTIONS')return send(res,204,{});
  if(handleHealthRequest(req,res))return;
  if(req.method==='GET' && path==='/health/live')return send(res,200,{status:'ok'});
  if(req.method==='GET' && path==='/health/ready'){
    try{await pool.query('SELECT 1');return send(res,200,{status:'ready',database:'connected'});}
    catch{return send(res,503,{status:'unavailable'});}
  }
  if(path==='/api/v1/authority'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readAuthorityState(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await switchAuthority(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;if(status===500)console.error('[authority-api] request failed',e?.code||e?.name||'unknown');return send(res,status,{error:status===500?'authority-unavailable':e.code||e.message});}
  }
  if(path==='/api/v1/presence'&&req.method==='POST'){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await touchPresence(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;return send(res,status,{error:status===500?'presence-unavailable':e.code||e.message});}
  }
  // Локальный вход: пароль и токены проверяются здесь, без Firebase и без
  // заголовков authority. Поэтому маршруты объявлены до single-writer gate:
  // иначе первый вход после переключения был бы заблокирован.
  if(path==='/api/v1/auth/register'&&req.method==='POST'){
    if(!jsonBody(req))return send(res,415,{error:'unsupported-media-type'});
    try{
      const body=await readJson(req);
      const registered=await registerWithPassword(pool,body);
      if(hasTokens(registered))return send(res,201,registered);
      // Store может вернуть только профиль: тогда сразу выдаём сессию тем же
      // паролем. Если учётная запись ждёт подтверждения, это не ошибка.
      try{
        const session=await loginWithPassword(pool,textValue(body?.email),textValue(body?.password),deviceInfoFrom(req,body));
        return send(res,201,{...bodyObject(registered),...bodyObject(session)});
      }catch(error){
        if(error?.status===403||error?.code==='account-disabled'||error?.code==='pending-approval')return send(res,201,registered);
        throw error;
      }
    }catch(error){return authFailure(res,error,'register');}
  }
  if(path==='/api/v1/auth/login'&&req.method==='POST'){
    if(!jsonBody(req))return send(res,415,{error:'unsupported-media-type'});
    try{
      const body=await readJson(req);
      return send(res,200,await loginWithPassword(pool,textValue(body?.email),textValue(body?.password),deviceInfoFrom(req,body)));
    }catch(error){return authFailure(res,error,'login');}
  }
  if(path==='/api/v1/auth/refresh'&&req.method==='POST'){
    if(!jsonBody(req))return send(res,415,{error:'unsupported-media-type'});
    try{
      const body=await readJson(req);
      return send(res,200,await refreshSession(pool,textValue(body?.refreshToken),deviceInfoFrom(req,body)));
    }catch(error){return authFailure(res,error,'refresh');}
  }
  if(path==='/api/v1/auth/logout'&&req.method==='POST'){
    if(!jsonBody(req))return send(res,415,{error:'unsupported-media-type'});
    try{
      const body=await readJson(req);
      await logoutSession(pool,textValue(body?.refreshToken));
      return send(res,200,{ok:true});
    }catch(error){return authFailure(res,error,'logout');}
  }
  if(path==='/api/v1/auth/forgot'&&req.method==='POST'){
    if(!jsonBody(req))return send(res,415,{error:'unsupported-media-type'});
    let body;
    try{body=await readJson(req);}
    catch(error){return send(res,error?.status===413?413:400,{error:error?.status===413?'body-too-large':'invalid-json'});}
    try{await issuePasswordReset(pool,textValue(body?.email));}
    catch(error){console.error('[auth-api] forgot failed',error?.code||error?.name||'unknown');}
    // Ответ одинаков для известной и неизвестной почты: иначе маршрут стал бы
    // проверкой существования учётной записи. Токен клиенту не возвращается.
    return send(res,200,{ok:true,message:RESET_REQUEST_MESSAGE});
  }
  if(path==='/api/v1/auth/reset'&&req.method==='POST'){
    if(!jsonBody(req))return send(res,415,{error:'unsupported-media-type'});
    try{
      const body=await readJson(req);
      await consumePasswordReset(pool,textValue(body?.token),textValue(body?.newPassword));
      return send(res,200,{ok:true});
    }catch(error){return authFailure(res,error,'reset');}
  }
  if(path==='/api/v1/auth/sessions'&&req.method==='GET'){
    try{
      const auth=await verifyAccessToken(req);
      if(!auth)return send(res,401,{error:'unauthorized'});
      return send(res,200,await listSessions(pool,auth.uid));
    }catch(error){return authFailure(res,error,'sessions');}
  }
  if(path==='/api/v1/auth/sessions'&&req.method==='DELETE'){
    try{
      const auth=await verifyAccessToken(req);
      if(!auth)return send(res,401,{error:'unauthorized'});
      // Только свои сессии: uid из тела запроса не читается.
      const result=await revokeAllSessions(pool,auth.uid);
      return send(res,200,{ok:true,...(Number.isSafeInteger(result?.revoked)?{revoked:result.revoked}:{})});
    }catch(error){return authFailure(res,error,'revoke-all');}
  }
  const ownSessionPath=/^\/api\/v1\/auth\/sessions\/([^/]{1,128})$/.exec(path);
  if(ownSessionPath&&req.method==='DELETE'){
    try{
      const auth=await verifyAccessToken(req);
      if(!auth)return send(res,401,{error:'unauthorized'});
      let id;
      try{id=decodeURIComponent(ownSessionPath[1]);}
      catch{return send(res,400,{error:'invalid-session-id'});}
      await revokeSession(pool,auth.uid,id);
      return send(res,200,{ok:true});
    }catch(error){return authFailure(res,error,'revoke-session');}
  }
  // Single-writer gate. Reads stay open; every authenticated application write
  // is refused unless this server is the declared authority at the current
  // generation. A phone that lags behind cannot write after a switch.
  if(req.method==='POST'&&path.startsWith('/api/v1/')&&path!=='/api/v1/authority'&&path!=='/api/v1/presence'&&path!=='/api/v1/registration'&&path!=='/api/v1/replica/apply'){
    try{await assertWriteAuthority(pool,req);}
    catch(e){const status=[400,403,409].includes(e.status)?e.status:503;return send(res,status,{error:e.code||e.message});}
  }
  if(path==='/api/v1/admin/server'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(req.method==='GET')return send(res,200,await readServerControl(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitServerCommand(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;return send(res,status,{error:status===500?'server-control-unavailable':e.code||e.message});}
  }
  if(path==='/api/v1/notifications'&&['GET','POST'].includes(req.method)){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{if(req.method==='GET')return send(res,200,await readNotifications(pool,uid));
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await submitNotificationTest(pool,uid,await readJson(req)));
    }catch(e){const status=[400,403,409,413].includes(e.status)?e.status:500;return send(res,status,{error:status===500?'server-error':e.code||e.message});}
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
  if(path==='/api/v1/replica/apply'&&req.method==='POST'){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{error:'unsupported-media-type'});
      return send(res,200,await appendReplicaBatch(pool,uid,await readJson(req)));
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[replica-api] apply failed',e?.code||e?.name||'unknown');
      return send(res,status,{error:status===500?'server-error':e.code||e.message});
    }
  }
  if(path==='/api/v1/replica/journal'&&req.method==='GET'){
    const uid=await verifyFirebaseUser(req);if(!uid)return send(res,401,{error:'unauthorized'});
    try{
      return send(res,200,await readReplicaJournal(pool,uid,{
        since:requestUrl.searchParams.get('since')??0,
        limit:requestUrl.searchParams.get('limit')??100
      }));
    }catch(e){
      const status=[400,403,409,413].includes(e.status)?e.status:500;
      if(status===500)console.error('[replica-api] journal failed',e?.code||e?.name||'unknown');
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
let notificationBusy=false;const notificationTimer=setInterval(async()=>{if(notificationBusy)return;notificationBusy=true;try{await deliverNotification(pool);}catch(e){console.error('[notification-worker] failed',e?.code||e?.name||'unknown');}finally{notificationBusy=false;}},2000);
let stopping=false;
async function shutdown(){
  if(stopping)return;
  stopping=true;clearInterval(notificationTimer);
  server.close();
  try{await pool.end();}finally{process.exit(0);}
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
