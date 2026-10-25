
(function(){
'use strict';
const C=window.RoadArcadeCore,E=escapeHtml,events=['history','game_penalty'];
let owner='',unsub=null,winsUnsub=null,generation=0,head=C.initialHead(),players={},recent=[],ready=false,error='',fetching=new Map(),ownPending=null;
const callbacks=new Set(),format=n=>Number(n||0).toLocaleString('ru-RU');
const active=()=>permissionsLoaded&&currentUserStatus==='active'&&!!currentUid;
const flag=(name,policy=appConfig)=>policy?.testReviewFlags?.[name]!==false;
const shiftOpen=()=>!!state.shift?.id&&state.shift.isActive===true;
const available=kind=>active()&&shiftOpen()&&window.__gameEconomy?.snapshot().enabled===true&&flag('game_mode')&&flag('arcade_enabled')&&(!kind||flag('arcade_'+kind));
const me=()=>players[currentUid]||C.initialPlayer(currentUid,currentEmail,getUserName());
const emit=()=>{for(const cb of callbacks)try{cb();}catch(e){console.warn('[arcade view]',e);}};
const receiptId=(uid,id)=>'arcade_receipt_'+encodeURIComponent(uid)+'_'+id;
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now()+'_'+crypto.getRandomValues(new Uint32Array(2)).join('_');
function roll(){const values=new Uint32Array(1),bound=4294960000;do{crypto.getRandomValues(values);}while(values[0]>=bound);return values[0]%10000;}
function validRound(d){return Number.isSafeInteger(d.gameRound)&&d.gameRound>0&&d.id===C.roundId(d.gameRound)&&Number.isSafeInteger(d.bank)&&d.bank>=0&&d.actors&&d.player&&d.userUid;}
function acceptPlayer(d){if(!validRound(d))return;if(!players[d.userUid]||Number(players[d.userUid]._round||0)<d.gameRound)players[d.userUid]={...d.player,_round:d.gameRound};}
async function loadPlayers(current,token){
 await Promise.all(Object.entries(current.actors||{}).map(async([id,round])=>{
  if(players[id]?._round>=round||fetching.get(id)===round)return;fetching.set(id,round);
  try{const snap=await refs.audit.doc(C.roundId(round)).get();if(token===generation&&snap.exists)acceptPlayer({id:snap.id,...snap.data()});}catch(e){if(token===generation)error='Часть рейтинга пока не загрузилась.';}finally{if(token===generation){fetching.delete(id);emit();}}
 }));
}
function sync(){
 const next=active()?currentUid:'';if(next!==owner){unsub?.();winsUnsub?.();unsub=null;winsUnsub=null;ownPending=null;owner=next;generation++;head=C.initialHead();players={};recent=[];ready=false;error='';fetching.clear();emit();}
 if(owner&&!unsub){const token=generation;unsub=refs.audit.orderBy('gameRound','desc').limit(80).onSnapshot({includeMetadataChanges:true},snap=>{
  if(token!==generation)return;const rows=snap.docs.filter(d=>!d.metadata.hasPendingWrites).map(d=>({id:d.id,...d.data()})).filter(validRound).sort((a,b)=>b.gameRound-a.gameRound);
  if(rows[0]&&rows[0].gameRound>=head.gameRound)head=rows[0];for(const row of rows)acceptPlayer(row);
  ready=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites;error='';loadPlayers(head,token);emit();
 },e=>{if(token===generation){ready=false;error='Нет связи с игровым банком. Ставки приостановлены.';emit();console.warn('[arcade ledger]',e);}});
 winsUnsub=refs.audit.orderBy('gameWinRound','desc').limit(20).onSnapshot(s=>{if(token!==generation)return;recent=s.docs.map(d=>({id:d.id,...d.data()})).filter(validRound);emit();},e=>console.warn('[arcade latest wins]',e));}
}
function balance(){const s=window.__gameEconomy?.snapshot();return s&&window.RoadShop?window.RoadShop.available(s.earned,window.RoadShop.spent(s.records,currentUid),currentUserRole,currentUserStatus):0;}
function pendingKey(){return 'samosval-arcade-spin-v1:'+firebaseConfig.projectId+':'+WORKSPACE_ID+':'+currentUid;}
function readSpin(){try{const v=JSON.parse(localStorage.getItem(pendingKey())||'null');return v?.kind==='slot'&&typeof v.id==='string'&&Number.isInteger(v.roll)&&v.roll>=0&&v.roll<10000?v:null;}catch(e){return ownPending;}}
function storeSpin(op){ownPending=op;try{if(op)localStorage.setItem(pendingKey(),JSON.stringify(op));else localStorage.removeItem(pendingKey());}catch(e){if(op)throw Error('Браузер не разрешил сохранить вращение. Разрешите локальное хранилище.');}}
async function transact(action){
 const user=currentUid,email=currentEmail,name=getUserName(),economy=window.__gameEconomy?.snapshot();
 if(!active()||!navigator.onLine||!ready||!economy?.ready)throw Error('Дождитесь связи и синхронизации кошелька.');
 if(action.kind!=='purchase'&&!shiftOpen())throw Error('Мини-игры доступны только во время открытой смены.');
 if(action.kind!=='purchase'&&!available(action.kind==='finish'?'mario':action.kind))throw Error('Эта мини-игра выключена администратором.');
 const operation={...action,id:action.id||uid(),shiftId:action.shiftId||state.shift?.id||''},receipt=refs.audit.doc(receiptId(user,operation.id)),baseRound=head.gameRound;
 const raw=window.__historyRawTransaction||db.runTransaction.bind(db);
 const result=await raw(async tx=>{
  const saved=await tx.get(receipt);if(saved.exists)return {...saved.data().outcome,replayed:true};
  const profile=await tx.get(usersRef.doc(user)),policyDoc=await tx.get(appConfigRef),policy=policyDoc.exists?policyDoc.data():{};
  if(currentUid!==user||!profile.exists||profile.data().status!=='active')throw Error('Учётная запись или доступ изменились.');
  if(!flag('game_mode',policy))throw Error('Игровой режим выключен.');
  const kind=operation.kind==='finish'?'mario':operation.kind;
  if(kind!=='purchase'&&(!flag('arcade_enabled',policy)||!flag('arcade_'+kind,policy)))throw Error('Мини-игра выключена администратором.');
  if(kind==='purchase'&&!window.RoadShop.canUse(profile.data().role,profile.data().status,true))throw Error('Магазин недоступен этой роли.');
  if(kind!=='purchase'){
   const shiftDoc=await tx.get(refs.shift),shift=shiftDoc.exists?shiftDoc.data():null;
   if(!shift?.isActive){const e=Error('Смена закрыта. Мини-игры приостановлены.');e.code='arcade-shift-closed';throw e;}
   if(shift.id!==operation.shiftId){const e=Error('Началась другая смена. Откройте игру заново. Ставка не списана.');e.code='arcade-shift-changed';throw e;}
  }
  let current=C.initialHead(),n=baseRound;
  if(n){const first=await tx.get(refs.audit.doc(C.roundId(n)));if(!first.exists)throw Error('Обновите игровой банк и повторите действие.');current={id:first.id,...first.data()};if(!validRound(current))throw Error('Не удалось проверить игровой банк.');}
  let nextRef;
  for(let attempts=0;attempts<40;attempts++){nextRef=refs.audit.doc(C.roundId(n+1));const next=await tx.get(nextRef);if(!next.exists)break;current={id:next.id,...next.data()};if(!validRound(current))throw Error('Неверная запись игрового банка.');n++;if(attempts===39)throw Error('Банк занят. Повторите действие через несколько секунд.');}
  let player=C.initialPlayer(user,email,name);const playerRound=current.actors?.[user];
  if(playerRound){const own=playerRound===current.gameRound?current:(await tx.get(refs.audit.doc(C.roundId(playerRound)))).data();if(!own?.player)throw Error('Не удалось проверить игровой счёт.');player={...own.player};}
  player.name=name;player.email=email;
  const purchaseRefs=window.RoadShop.themes.map(t=>refs.audit.doc(window.RoadShop.purchaseId(user,t.id))),purchaseSnaps=await Promise.all(purchaseRefs.map(r=>tx.get(r)));
  const paid=window.RoadShop.spent(purchaseSnaps.filter(d=>d.exists).map(d=>({id:d.id,...d.data()})),user);
  const funds=economy.earned+window.RoadShop.bonus(profile.data().role,profile.data().status)+player.net-paid;
  let item=null;if(kind==='purchase'){item=window.RoadShop.themes.find(t=>t.id===operation.itemId);if(!item)throw Error('Тема не найдена.');if(purchaseSnaps[window.RoadShop.themes.indexOf(item)].exists)return {noop:true,reason:'owned',delta:0};operation.price=item.price;}
  const outcome=C.settle(current,player,operation,funds,C.dayKey());if(outcome.noop)return outcome;
  const timestamp=Date.now(),nextRound=n+1;
  const state={gameRound:nextRound,bank:outcome.head.bank,totalStakes:outcome.head.totalStakes,totalPayouts:outcome.head.totalPayouts,actors:{...current.actors,[user]:nextRound},player:outcome.player};
  const final={delta:outcome.delta,cost:outcome.cost||0,payout:outcome.payout||0,result:outcome.result||{},kind:operation.kind,level:operation.level||null,coin:operation.coin??null,round:nextRound};
  const author={shiftId:operation.shiftId,userUid:user,userEmail:email,createdByEmail:email,userName:name,timestamp,timeStr:new Date(timestamp).toLocaleString('ru-RU')};
  tx.set(nextRef,{...author,...state,...(operation.kind==='slot'&&final.payout>final.cost?{gameWinRound:nextRound}:{}),eventType:'game_arcade',kind:operation.kind,cost:final.cost,payout:final.payout,delta:final.delta,result:final.result,requestId:operation.id,text:'🎮 '+({slot:'Вращение автомата',mario:'Монета Марио',finish:'Уровень Марио',purchase:'Покупка темы'}[operation.kind])});
  tx.set(receipt,{...author,eventType:'game_arcade_receipt',outcome:final,text:'🎮 Подтверждение игрового действия'});
  if(item)tx.set(purchaseRefs[window.RoadShop.themes.indexOf(item)],{...author,eventType:'game_purchase',itemId:item.id,price:item.price,text:'🛍 Куплена тема: '+item.name});
  return {...final,confirmedHead:{...state,id:nextRef.id,...author,kind:operation.kind,payout:final.payout,cost:final.cost,result:final.result}};
 });
 if(currentUid===user&&result.confirmedHead){const d=result.confirmedHead;if(d.gameRound>=head.gameRound)head=d;acceptPlayer(d);if(d.kind==='slot'&&d.payout>d.cost)recent=[d,...recent.filter(r=>r.id!==d.id)].slice(0,20);emit();}
 return result;
}
window.RoadArcade={available,delta:id=>players[id]?.net||0,balance,me,head:()=>head,players:()=>players,recent:()=>recent,status:()=>({ready,error,hydrated:ready&&(!head.actors[currentUid]||players[currentUid]?._round>=head.actors[currentUid])}),subscribe:fn=>{callbacks.add(fn);return ()=>callbacks.delete(fn);},transact,readSpin,storeSpin,newSpin:()=>({id:uid(),kind:'slot',shiftId:state.shift?.id||'',roll:roll()}),buyTheme:item=>transact({kind:'purchase',itemId:item.id}),sync};
window.addEventListener('road-shift-changed',()=>{sync();emit();});
window.addEventListener('review-flags-changed',()=>{sync();emit();});setInterval(sync,1000);sync();
})();

