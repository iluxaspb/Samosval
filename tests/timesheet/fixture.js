/* Local QA only. Never loaded by index-test.html. */
var firebaseConfig={projectId:'samosval-offline'},WORKSPACE_ID='main_workspace';
var currentUid='qa-admin',currentUserStatus='active',permissionsLoaded=true,currentUserRole='admin';
var state={objects:[{id:'obj',name:'Всеволожск · ул. Свердлова'}],shift:{objectId:'obj'}};
var __messages=[],__authListeners=[],__rows=new Map(),__subscriptions=[];
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function hasTabAccess(){return currentUserStatus==='active';}
function hasPermission(){return currentUserRole==='admin';}
function getUserName(){return 'Тестовый мастер';}
function showToastEl(s){__messages.push(s);}
function showError(s){__messages.push('ERROR: '+s);}
function renderAll(){}
function stopSync(){}
var auth={onAuthStateChanged:cb=>{__authListeners.push(cb);return()=>{};}};
var firebase={firestore:{FieldValue:{serverTimestamp:()=>Date.now()}}};
function __clone(v){return v===undefined?undefined:JSON.parse(JSON.stringify(v));}
function __snapshot(path){const d=__rows.get(path);return {exists:d!==undefined,id:path.split('/').pop(),data:()=>__clone(d)};}
function __query(collection,filter){const docs=[...__rows.keys()].filter(k=>k.startsWith(collection+'/')&&k.split('/').length===collection.split('/').length+1).map(__snapshot).filter(s=>!filter||s.data()[filter[0]]===filter[1]);return {docs,metadata:{fromCache:!navigator.onLine,hasPendingWrites:false}};}
function __notify(){queueMicrotask(()=>__subscriptions.slice().forEach(s=>s.cb(__query(s.path,s.filter))));}
function __collection(path,filter){return{doc:id=>({path:path+'/'+id,get:async()=>__snapshot(path+'/'+id)}),where:(key,_,value)=>__collection(path,[key,value]),get:async()=>__query(path,filter),onSnapshot:(_,cb)=>{const sub={path,filter,cb};__subscriptions.push(sub);queueMicrotask(()=>{if(__subscriptions.includes(sub))cb(__query(path,filter));});return()=>{__subscriptions=__subscriptions.filter(s=>s!==sub);};}};}
var wsRef={collection:name=>__collection('workspaces/main_workspace/'+name)};
var db={runTransaction:async cb=>{const writes=[];const result=await cb({get:async ref=>__snapshot(ref.path),set:(ref,data)=>writes.push([ref.path,__clone(data)])});for(const [path,data]of writes)__rows.set(path,data);__notify();return result;}};
for(const [id,name]of [['p1','Иван Петров'],['p2','Сергей Иванов'],['p3','Алексей Соколов']])__rows.set('workspaces/main_workspace/timesheetPeople/'+id,{name,group:'operator',deleted:false,revision:1});
__rows.set('workspaces/main_workspace/timesheetEquipment/w205',{name:'Фреза W205',ownership:'own',contractor:'',crewIds:['p1','p2','p3'],deleted:false,revision:1});
