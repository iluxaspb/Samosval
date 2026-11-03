/* Local-only indirect Firebase usage model. No Firestore reads/writes; consumes existing snapshots. */
(function(){
'use strict';
if(window.FirebaseTrafficInference)return;
const MAX_ROWS=12000,MAX_DAYS=180,WINDOW=30*60000,DB_NAME='samosval_firebase_inference_v1';
const labelRole={admin:'Админ',lopater:'Лопатёр',master:'Мастер',foreman:'Прораб',viewer:'Наблюдатель'};
const state={users:[],rows:[],ready:false,persisted:true,notice:'',snapshotLimit:200,lastAuditAt:0};
let pending=[],dbPromise=null,persistTimer=0,writing=false,initializing=false;
const clean=x=>String(x??'').trim().toLowerCase();
const hash=x=>{let n=2166136261;for(const c of String(x)){n=Math.imul(n^c.charCodeAt(0),16777619);}return (n>>>0).toString(36);};
const key=(prefix,value)=>value?prefix+':'+hash(clean(value)):null;
const aliases=(x,kind)=>{
 const set=new Set();
 const put=(prefix,value)=>{const k=key(prefix,value);if(k)set.add(k);};
 if(kind==='registered'){
  put('uid',x.id);put('uid',x.uid);put('email',x.email);
  put('name',x.nickname);put('name',x.name);put('name',x.displayName);
 }else{
  put('uid',x.userUid);put('uid',x.uid);put('uid',x.history?.actor?.uid);
  put('email',x.userEmail);put('email',x.createdByEmail);put('email',x.email);put('email',x.history?.actor?.email);
  put('name',x.userName);put('name',x.createdBy);put('name',x.history?.user);put('name',x.actor);put('name',x.player?.name);
 }
 return [...set];
};
const eventTime=a=>{
 const x=a.timestamp??a.createdAt??a.history?.timestamp??a.time;
 if(Number.isFinite(Number(x)))return Number(x);
 if(x&&typeof x.toMillis==='function')return x.toMillis();
 if(x&&Number.isFinite(x.seconds))return x.seconds*1000;
 return NaN;
};
function eventKind(a){
 const t=clean(a.eventType), msg=clean([a.text,a.html,a.history?.description,a.type,a.action].filter(Boolean).join(' '));
 if(/game_arcade|game_purchase|game_penalty|arcade/.test(t)||Number.isFinite(a.gameRound)||Number.isFinite(a.gameWinRound))return 'game';
 if(t==='load'||/погруз|загруз|рейс\s*№/.test(msg))return 'load';
 if(t==='arrive'||/приехал|прибыл|прибытие/.test(msg))return 'arrive';
 if(t==='ttn'||/ттн/.test(msg))return 'ttn';
 if(/отмен|восстанов|undo|redo/.test(t+' '+msg))return 'undo';
 if(/game|монет|мини.игр|слот|марио|джекпот|ставк/.test(msg))return 'game';
 if(t==='history'&&Array.isArray(a.history?.operations)){
  const col=a.history.operations.map(op=>clean(op.collection)).join(' ');
  if(/\blogs\b/.test(col))return 'load';
  if(/truckstatus/.test(col))return 'arrive';
 }
 return 'other';
}
const notify=()=>{try{window.dispatchEvent(new CustomEvent('firebase-inference-change'));}catch(_){}};
const unique=(arr)=>[...new Set(arr)];
function compactAudit(items){
 if(!Array.isArray(items))return [];
 const limit=Date.now()-MAX_DAYS*86400000;
 return items.flatMap(a=>{
  const ts=eventTime(a);if(!Number.isFinite(ts)||ts<limit||ts>Date.now()+60000)return [];
  const id=key('audit',a.id||a.offlineOperationId||[ts,a.eventType,a.userEmail,a.text].join('|'));
  if(!id)return [];
  return [{id,ts,day:window.FirebaseTraffic?.quotaDay(ts)||'',
    kind:eventKind(a),aliases:aliases(a,'audit')}];
 });
}
function combine(records){
 const seen=new Set(state.rows.map(r=>r.id));let added=0;
 for(const a of records){if(!a.day||seen.has(a.id))continue;seen.add(a.id);state.rows.push(a);added++;}
 state.rows.sort((a,b)=>a.ts-b.ts);
 const cutoff=Date.now()-MAX_DAYS*86400000;
 state.rows=state.rows.filter(r=>r.ts>=cutoff).slice(-MAX_ROWS);
 return added;
}
function captureAudit(snapshot){
 if(!window.FirebaseTraffic?.active()||!Array.isArray(snapshot))return;
 state.lastAuditAt=Date.now();
 const rows=compactAudit(snapshot);
 if(!state.ready){pending.push(...rows);return;}
 if(combine(rows)){schedule();notify();}
}
function captureUsers(records){
 if(!window.FirebaseTraffic?.active()||!Array.isArray(records))return;
 const valid=records.filter(u=>u&&['active','approved','enabled',''].includes(clean(u.status))&&u.disabled!==true&&u.enabled!==false);
 // A registered account, not a browser connection, is the model's hard ceiling.
 const seen=new Set();
 state.users=valid.map((u,i)=>{
  const keys=aliases(u,'registered'),id=keys.find(k=>k.startsWith('uid:'))||keys.find(k=>k.startsWith('email:'))||keys[0];
  if(!id||seen.has(id))return null;
  seen.add(id);
  return {id,aliases:keys,role:clean(u.role)||'unknown',label:(labelRole[clean(u.role)]||'Пользователь')+' '+(i+1)};
 }).filter(Boolean);
 schedule();notify();
}
function openDB(){
 if(dbPromise)return dbPromise;
 dbPromise=new Promise(resolve=>{
  try{
   const r=indexedDB.open(DB_NAME,1);
   r.onupgradeneeded=()=>r.result.createObjectStore('data');
   r.onsuccess=()=>resolve(r.result);
   r.onerror=()=>{state.persisted=false;state.notice='IndexedDB недоступна';resolve(null);};
  }catch(_){state.persisted=false;resolve(null);}
 });
 return dbPromise;
}
async function init(){
 if(initializing)return;initializing=true;
 const db=await openDB();
 if(db)await new Promise(resolve=>{
  try{
   const tx=db.transaction('data','readonly'),req=tx.objectStore('data').get('main');
   req.onsuccess=()=>{
    const saved=req.result||{};
    combine(saved.rows||[]);
    if(!state.users.length&&Array.isArray(saved.users))state.users=saved.users;
   };
   tx.oncomplete=resolve;tx.onerror=resolve;tx.onabort=resolve;
  }catch(_){resolve();}
 });
 state.ready=true;combine(pending);pending=[];notify();schedule();
}
function schedule(){if(persistTimer)return;persistTimer=setTimeout(()=>{persistTimer=0;persist().catch(()=>{});},1800);}
async function persist(){
 if(!state.ready||writing){schedule();return;}
 writing=true;const db=await openDB();
 if(!db){writing=false;return;}
 await new Promise(resolve=>{
  try{
   const tx=db.transaction('data','readwrite');
   tx.objectStore('data').put({rows:state.rows,users:state.users},'main');
   tx.oncomplete=resolve;tx.onerror=()=>{state.persisted=false;state.notice='Ошибка локальной записи';resolve();};tx.onabort=resolve;
  }catch(_){resolve();}
 });
 writing=false;
}
function matchUsers(){
 const map=new Map();
 for(const u of state.users)for(const k of u.aliases){
  if(map.has(k))map.set(k,null);else map.set(k,u);
 }
 return map;
}
function summary(day,selfUid='',selfEmail=''){
 const users=state.users, count=users.length;
 const result={period:day,registered:count,modelReady:state.ready&&count>0,
    auditRows:0,identified:0,unassigned:0,otherUsers:0,
    reads:{low:0,expected:0,high:0},writes:{low:0,expected:0,high:0},
    actions:{load:0,arrive:0,ttn:0,undo:0,game:0,other:0},participants:[],notice:'Журнал аудита загружается существующей подпиской (последние 200 записей); при пропусках история и оценка будут неполными.'};
 const group=state.rows.filter(e=>e.day===day);
 result.auditRows=group.length;
 if(!count)return result;
 const map=matchUsers(), self=new Set([key('uid',selfUid),key('email',selfEmail)].filter(Boolean));
 const getActor=e=>{
  const hits=unique(e.aliases.map(k=>map.get(k)).filter(Boolean).map(u=>u.id));
  return hits.length===1?users.find(u=>u.id===hits[0]):null;
 };
 const events=group.map(e=>({e,user:getActor(e)}));
 const known=new Set(),bySlot=new Map();
 for(const {e,user} of events){
  if(!user)continue;
  const slot=Math.floor(e.ts/(15*60000));
  let group=bySlot.get(slot);if(!group)bySlot.set(slot,group=new Set());
  group.add(user.id);
 }
 const perUser=new Map();
 for(const {e,user} of events){
  if(!user){result.unassigned++;continue;}
  result.identified++;
  if(user.aliases.some(a=>self.has(a)))continue;
  known.add(user.id);
  const actor=perUser.get(user.id)||{id:user.id,label:user.label,role:user.role,actions:0,reads:0,writes:0};
  actor.actions++;perUser.set(user.id,actor);
  const kind=e.kind;result.actions[kind]=(result.actions[kind]||0)+1;
  const profiles={
   load:{r:[0,3,8],w:[1,2,4],update:2},
   arrive:{r:[0,2,6],w:[1,2,3],update:1},
   ttn:{r:[0,2,5],w:[1,2,3],update:1},
   undo:{r:[0,3,8],w:[1,2,4],update:2},
   game:{r:[0,4,15],w:[1,2,5],update:1},
   other:{r:[0,1,5],w:[1,1,3],update:1}
  };
  const p=profiles[kind]||profiles.other,slot=Math.floor(e.ts/(15*60000));
  const near=new Set();
  for(let k=slot-2;k<=slot+2;k++)for(const id of bySlot.get(k)||[])if(id!==user.id&&!users.find(u=>u.id===id)?.aliases.some(x=>self.has(x)))near.add(id);
  // One device per registered account; do not infer more receivers than registered accounts.
  const highReceivers=Math.max(0,count-2), likelyReceivers=Math.min(highReceivers,near.size);
  result.reads.low+=p.r[0];
  result.reads.expected+=p.r[1]+p.update*likelyReceivers;
  result.reads.high+=p.r[2]+p.update*highReceivers;
  result.writes.low+=p.w[0];result.writes.expected+=p.w[1];result.writes.high+=p.w[2];
  actor.reads+=p.r[1]+p.update*likelyReceivers;actor.writes+=p.w[1];
 }
 result.otherUsers=known.size;
 result.participants=[...perUser.values()].sort((a,b)=>b.reads-a.reads||b.actions-a.actions);
 return result;
}
async function clear(){
 state.rows=[];state.users=[];state.lastAuditAt=0;
 const db=await openDB();
 if(db)await new Promise(resolve=>{try{const tx=db.transaction('data','readwrite');tx.objectStore('data').clear();tx.oncomplete=resolve;tx.onerror=resolve;}catch(_){resolve();}});
 notify();
}
function enable(){if(!window.FirebaseTraffic?.active())return;init().catch(()=>{state.ready=true;notify();});}
window.FirebaseTrafficInference={captureAudit,captureUsers,summary,enable,persist,clear,data:state};
window.addEventListener('pagehide',()=>{if(window.FirebaseTraffic?.active())persist().catch(()=>{});});
})();