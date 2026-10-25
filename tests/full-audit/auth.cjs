'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const coreDir=process.env.AUTH_CORE_DIR||'test-app/src/core';
const sources=['07-registration-sync','09-auth','23-user-admin'].map(name=>fs.readFileSync(path.join(root,coreDir,name+'.js'),'utf8')).join('\n');
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const nodes=new Map(),documents=new Map(),subscriptions=[],events=[],errors=[],toasts=[];
 const el=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',textContent:'',innerHTML:'',disabled:false,style:{display:''},dataset:{},classList:{contains:()=>false,add(){},remove(){}},querySelector:()=>({}),querySelectorAll:()=>[],setAttribute(){},removeAttribute(){}});return nodes.get(id);};
 const f={nodes,documents,subscriptions,events,errors,toasts,failTransaction:false,failWrite:false,authCreates:0,secondaryCreates:0,secondarySignsOut:0,storeThrows:false,profileCallback:null};
 function ref(collection,id){return {id,path:collection+'/'+id,get:async()=>snapshot(collection,id),onSnapshot(opts,cb,error){const subscription={collection,id,cb,error};subscriptions.push(subscription);return()=>subscription.stopped=true;},set:async(data,options)=>{if(f.failWrite)throw Error('profile denied');documents.set(collection+'/'+id,options?.merge?{...documents.get(collection+'/'+id),...clone(data)}:clone(data));},update:async data=>documents.set(collection+'/'+id,{...documents.get(collection+'/'+id),...clone(data)}),delete:async()=>documents.delete(collection+'/'+id)};}
 function snapshot(collection,id,meta={fromCache:false,hasPendingWrites:false}){const data=clone(documents.get(collection+'/'+id));return {id,exists:data!==undefined,data:()=>clone(data),metadata:meta};}
 function collection(name){return {doc:id=>ref(name,id),get:async()=>({docs:[...documents.keys()].filter(k=>k.startsWith(name+'/')).map(k=>snapshot(name,k.slice(name.length+1))),metadata:{fromCache:false}}),onSnapshot(options,cb,error){const sub={collection:name,cb,error};subscriptions.push(sub);return()=>sub.stopped=true;}};}
 const auth={currentUser:null,onAuthStateChanged:cb=>{f.authCallback=cb;},async signInWithEmailAndPassword(email,password){events.push('login');if(f.loginDeferred)await f.loginDeferred;if(f.loginError)throw f.loginError;auth.currentUser={uid:'new',email};await f.authCallback(auth.currentUser);return {user:auth.currentUser};},async createUserWithEmailAndPassword(email,password){f.authCreates++;if(f.createDeferred)await f.createDeferred;if(f.createError)throw f.createError;auth.currentUser={uid:'new',email};await f.authCallback(auth.currentUser);return {user:auth.currentUser};},async signOut(){events.push('signout');if(f.signOutError)throw f.signOutError;auth.currentUser=null;await f.authCallback(null);}};
 const ctx={console:{log(){},warn(){},error(){}},setTimeout:()=>0,clearTimeout(){},Date,Promise,Set,Map,auth,
  document:{getElementById:el,querySelector:el,querySelectorAll:()=>[],body:{removeAttribute(){}}},window:{},navigator:{onLine:true},
  localStorage:{getItem:()=>{if(f.storeThrows)throw Error('storage blocked');return null;},setItem(){if(f.storeThrows)throw Error('storage blocked');},removeItem(){if(f.storeThrows)throw Error('storage blocked');}},
  DEFAULT_PERMISSIONS:{viewer:{tabs:[],actions:[]}},ROLES:{admin:{label:'Администратор'},viewer:{label:'Наблюдатель'},foreman:{label:'Прораб'}},
  currentEmail:'',currentUid:'',currentUserRole:null,currentUserStatus:null,currentUserNickname:'',activeProfileKey:'',permissionsLoaded:false,permissionsConfig:{},initialized:false,confirmedLoadIds:new Set(),pendingOps:0,syncState:{},state:{users:[],requests:[],logs:[],truckStatus:{}},userDocUnsubscriber:null,reqsUnsubscriber:null,usersUnsubscriber:null,
  usersRef:collection('users'),requestsRef:collection('registration_requests'),
  stopSync(){events.push('stop');},startSync(){events.push('start');},loadCache(){},offlineProjectState(){},renderAll(){events.push('render');},setPermissionsNotice(){},updateSyncUI(){},markSync(){},cancelHold(){},runMaxQueue(){},loadAndApplyPatches:async()=>{},
  canAdmin:()=>ctx.currentUserRole==='admin'&&ctx.currentUserStatus==='active',isForcedAdminEmail:email=>email==='owner@example.test',sanitizeName:email=>email.split('@')[0],hasPermission:()=>false,getUserName:()=>ctx.currentUserNickname,updateNavUI(){},escapeHtml:s=>String(s),
  showError:text=>errors.push(text),showToastEl:text=>toasts.push(text),reportSyncError:(source,e)=>events.push('error:'+source+':'+e.message),tfAwait:p=>p,pendingStart(){events.push('pending-start');},pendingEnd(){events.push('pending-end');},appConfirm:async()=>f.confirm!==false,
  addAudit:async()=>{events.push('audit');if(f.auditError)throw Error('audit unavailable');if(f.auditDeferred)await f.auditDeferred;},
  secondaryApp:{auth:()=>({createUserWithEmailAndPassword:async(email)=>{f.secondaryCreates++;if(f.secondaryDeferred)await f.secondaryDeferred;return {user:{uid:'secondary',email}};},signOut:async()=>{f.secondarySignsOut++;}})},
  db:{runTransaction:async cb=>{if(f.transactionDeferred)await f.transactionDeferred;if(f.failTransaction)throw Error('permission denied');const writes=[];const result=await cb({get:async r=>snapshot(r.path.split('/')[0],r.id),set:(r,data)=>writes.push(['set',r,clone(data)]),update:(r,data)=>writes.push(['update',r,clone(data)]),delete:r=>writes.push(['delete',r])});for(const [method,r,data]of writes){if(method==='delete')documents.delete(r.path);else documents.set(r.path,method==='update'?{...documents.get(r.path),...data}:data);events.push(method+':'+r.path);}return result;}}
 };
 vm.createContext(ctx);vm.runInContext(sources,ctx,{filename:'auth-modules.js'});
 f.ctx=ctx;f.el=el;f.snapshot=snapshot;
 f.login=async(user={uid:'new',email:'new@example.test'})=>{auth.currentUser=user;await f.authCallback(user);};
 f.profile=async(data,meta)=>{if(data!==undefined)documents.set('users/'+ctx.currentUid,clone(data));else documents.delete('users/'+ctx.currentUid);const sub=subscriptions.filter(s=>s.collection==='users'&&s.id===ctx.currentUid).at(-1);await sub.cb(snapshot('users',ctx.currentUid,meta));};
 f.admin=()=>{ctx.currentUid='admin';ctx.currentEmail='admin@example.test';ctx.currentUserRole='admin';ctx.currentUserStatus='active';ctx.renderAdminPanel=()=>{};};
 return f;
}
(async()=>{
 let f=fixture();
 await f.ctx.ensurePendingAccount({uid:'new',email:'new@example.test'});
 assert.deepEqual(Object.keys(f.documents.get('users/new')).sort(),['createdAt','email','nickname','role','status']);
 assert.equal(f.documents.get('users/new').role,'viewer');assert.equal(f.documents.get('registration_requests/new').status,'pending');
 const writes=f.events.length;await f.ctx.ensurePendingAccount({uid:'new',email:'new@example.test'});assert.equal(f.events.length,writes,'repeated registration is idempotent');
 f.documents.get('users/new').status='active';f.documents.delete('registration_requests/new');await f.ctx.ensurePendingAccount({uid:'new',email:'new@example.test'});assert(!f.documents.has('registration_requests/new'),'approved user cannot re-enter pending');
 console.log('PASS auth: exact pending registration fields, idempotent retry, approved account is not reset');

 f=fixture();await f.login();f.failTransaction=true;await f.profile(undefined);
 assert.equal(f.el('pendingScreen').style.display,'flex');assert.match(f.el('registrationStatusText').textContent,/Не удалось/);assert.equal(f.el('authOverlay').style.display,'none');assert(!f.events.includes('start'));
 f.failTransaction=false;await f.ctx.retryAccountCheck();await f.profile(undefined);assert(f.documents.has('registration_requests/new'));assert.match(f.el('registrationStatusText').textContent,/заявка отправлена/);
 await f.profile({email:'new@example.test',nickname:'Новый',role:'viewer',status:'active'});assert.equal(f.el('pendingScreen').style.display,'none');assert(f.events.includes('start'));
 console.log('PASS auth: profile/request failure is visible; retry creates request without another Auth account; approval opens application');

 f=fixture();await f.login();let release;f.transactionDeferred=new Promise(r=>release=r);
 const pending=f.profile({email:'new@example.test',role:'viewer',status:'pending'});await tick();await f.ctx.auth.signOut();release();await pending;
 assert.equal(f.el('authOverlay').style.display,'flex');assert.equal(f.el('pendingScreen').style.display,'none');assert.equal(f.ctx.currentUid,'');assert(!f.events.includes('start'));
 const oldSubscription=f.subscriptions.find(s=>s.id==='new');oldSubscription.error(Error('late previous-session error'));assert.equal(f.el('pendingScreen').style.display,'none');
 console.log('PASS auth: stale pending/profile error callbacks cannot reopen old account after logout');

 f=fixture();f.el('authEmail').value='new@example.test';f.el('authPassword').value='secret';f.storeThrows=true;
 await f.ctx.handleLogin();assert.equal(f.el('authError').textContent,'');assert.equal(f.el('authPassword').value,'');
 f.signOutError=Error('offline');await f.ctx.handleLogout();assert.match(f.errors.at(-1),/Не удалось выйти/);
 f.signOutError=null;await f.ctx.handleLogout();assert.equal(f.ctx.currentUid,'');
 f=fixture();f.el('authEmail').value='new@example.test';f.el('authPassword').value='secret';let unlock;f.createDeferred=new Promise(r=>unlock=r);
 const first=f.ctx.handleRegister();await f.ctx.handleRegister();await f.ctx.handleLogin();assert.equal(f.authCreates,1);assert(!f.events.includes('login'));unlock();await first;assert.equal(f.el('registerBtn').disabled,false);assert.equal(f.el('authPassword').value,'');
 console.log('PASS auth: blocked localStorage does not turn successful login/logout into failure; double submit and competing login are locked');

 f=fixture();f.el('authEmail').value='new@example.test';f.el('authPassword').value='secret';f.createError={code:'auth/email-already-in-use'};await f.ctx.handleRegister();assert.match(f.el('authError').textContent,/уже зарегистрирован/);assert.equal(f.el('registerBtn').disabled,false);assert.equal(f.el('authPassword').value,'');
 f.el('authPassword').value='wrong';f.loginError={code:'auth/invalid-credential'};await f.ctx.handleLogin();assert.match(f.el('authError').textContent,/Неверный e-mail или пароль/);assert.equal(f.ctx.currentUid,'');
 f=fixture();await f.login();await f.profile({email:'new@example.test',role:'viewer',status:'disabled',rejectionReason:'Заявка отклонена'});assert.equal(f.el('disabledScreen').style.display,'flex');assert.equal(f.el('pendingScreen').style.display,'none');assert(!f.events.includes('start'));
 await f.profile({email:'new@example.test',role:'admin',status:'unknown'});assert.equal(f.el('pendingScreen').style.display,'flex');assert.equal(f.ctx.currentUserRole,null);assert(!f.events.includes('start'));
 console.log('PASS auth: existing email and bad password show useful errors; rejected and unknown-status accounts never start workspace sync');

 f=fixture();await f.login();let completePending;f.transactionDeferred=new Promise(r=>completePending=r);
 const oldPending=f.profile({email:'new@example.test',role:'viewer',status:'pending'});await tick();await f.profile({email:'new@example.test',role:'viewer',status:'active'});completePending();await oldPending;
 assert.equal(f.el('pendingScreen').style.display,'none');assert.equal(f.ctx.currentUserStatus,'active');assert(f.events.includes('start'));
 console.log('PASS auth: newer approval snapshot wins over older async pending callback');

 f=fixture();f.admin();f.documents.set('users/p',{email:'p@example.test',role:'viewer',status:'pending'});f.documents.set('registration_requests/p',{uid:'p',email:'p@example.test',status:'pending'});f.ctx.state.requests=[{id:'p',uid:'p',email:'p@example.test'}];f.el('req_role_p').value='foreman';f.auditError=true;
 await f.ctx.approveRequest('p');await tick();assert.equal(f.documents.get('users/p').status,'active');assert.equal(f.documents.get('users/p').role,'foreman');assert(!f.documents.has('registration_requests/p'));assert.equal(f.errors.length,0);assert(f.toasts.includes('Доступ открыт'));
 f.documents.set('users/q',{email:'q@example.test',role:'viewer',status:'pending'});f.documents.set('registration_requests/q',{uid:'q',email:'q@example.test',status:'pending'});f.ctx.state.requests.push({id:'q',uid:'q',email:'q@example.test'});await f.ctx.rejectRequest('q');assert.equal(f.documents.get('users/q').status,'disabled');assert(!f.documents.has('registration_requests/q'));
 console.log('PASS admin: approval/rejection are atomic; a failed auxiliary audit cannot report a failed decision');

 f=fixture();f.admin();f.documents.set('users/admin',{email:'admin@example.test',role:'admin',status:'active'});f.documents.set('users/owner',{email:'owner@example.test',role:'admin',status:'active'});
 await f.ctx.changeUserRole('admin','viewer');await f.ctx.changeUserRole('owner','viewer');await f.ctx.changeUserRole('owner','invented');await f.ctx.deleteUser('admin');await f.ctx.deleteUser('owner');
 assert.equal(f.documents.get('users/admin').role,'admin');assert.equal(f.documents.get('users/owner').role,'admin');assert.equal(f.errors.length,5);
 f.ctx.currentUserRole='viewer';await f.ctx.approveRequest('none');assert.equal(f.documents.size,2);
 console.log('PASS admin: invalid roles, self lockout, owner deletion/demotion and non-admin decisions are rejected');

 f=fixture();f.admin();f.el('newUserEmail').value='other@example.test';f.el('newUserPassword').value='secret';f.el('newUserRole').value='viewer';f.failWrite=true;
 await f.ctx.addNewUser();assert.equal(f.secondaryCreates,1);assert.equal(f.secondarySignsOut,1);assert.equal(f.el('newUserPassword').value,'');assert.match(f.errors.at(-1),/Учётная запись создана, но доступ не сохранён/);assert(!f.toasts.length);
 console.log('PASS admin: partial Auth/profile creation failure is actionable; password and secondary session are cleared');

 f=fixture();f.admin();f.ctx.renderRegistrationRequests=()=>{};f.ctx.startAdminSync();const old=f.subscriptions.filter(s=>!s.id);f.ctx.currentUid='new-admin';f.ctx.startAdminSync();const before=f.ctx.state.requests.length;
 old.find(s=>s.collection==='registration_requests').cb({docs:[{id:'old',data:()=>({uid:'old'})}],metadata:{fromCache:false}});assert.equal(f.ctx.state.requests.length,before);old.find(s=>s.collection==='users').error(Error('stale error'));assert(!f.events.some(x=>x.includes('stale error')));
 console.log('PASS registration sync: callbacks from previous admin session are ignored');
})().catch(e=>{console.error(e);process.exitCode=1;});
