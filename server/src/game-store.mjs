import {randomInt} from 'node:crypto';
import {fail,map} from './tabel-access.mjs';
import {serviceActor,serviceCommand,validId} from './service-command.mjs';
import {calculate} from './game-economy.mjs';
import {settle,initialHead,initialPlayer,roundId,dayKey} from './arcade-rules.mjs';
import {themePrices} from './theme-prices.mjs';
import {gameTransferRecord} from './game-transfer.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
const allowedTypes=new Set(['history','game_penalty','game_purchase','game_arcade']);
const purchaseId=(uid,itemId)=>'game_purchase_'+encodeURIComponent(uid)+'_'+itemId;
export function normalizeGame(input){
  if(!map(input)||!validId(input.id))throw fail('invalid-game-operation');
  if(input.type==='game.grant'){
    if(typeof input.targetUid!=='string'||!input.targetUid||input.targetUid.length>128||!Number.isSafeInteger(input.amount)||input.amount<1||input.amount>10000||typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.trim().length>160)throw fail('invalid-coin-grant');
    return {id:input.id,type:input.type,targetUid:input.targetUid,amount:input.amount,reason:input.reason.trim()};
  }
  if(input.type!=='game.play'||!map(input.action)||!['slot','mario','finish','purchase'].includes(input.action.kind))throw fail('invalid-game-operation');
  const a=input.action,action={kind:a.kind};
  if(a.kind==='purchase'){if(!Object.hasOwn(themePrices,a.itemId))throw fail('unknown-theme');action.itemId=a.itemId;}
  if(['mario','finish'].includes(a.kind)){
    if(!Number.isInteger(a.level)||a.level<1||a.level>20)throw fail('invalid-game-level');action.level=a.level;
  }
  if(a.kind==='mario'){
    if(!Number.isInteger(a.coin)||a.coin<0||a.coin>4||typeof a.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(a.day))throw fail('invalid-game-coin');action.coin=a.coin;action.day=a.day;
  }
  // Slot outcomes and theme prices always come from the server.
  return {id:input.id,type:input.type,action};
}
async function gameData(client,ws){
  if(!(await client.query('SELECT 1 FROM workspace_services_state WHERE workspace_id=$1',[ws])).rowCount)throw fail('games-not-ready',409);
  const stored=(await client.query('SELECT record_id,collection,payload FROM game_records WHERE workspace_id=$1 ORDER BY record_id',[ws])).rows;
  const records=stored.filter(r=>r.collection==='audit'&&allowedTypes.has(r.payload.eventType)).map(r=>({...r.payload,id:r.record_id}));
  const adjustments=stored.filter(r=>r.collection==='coinTransactions'&&r.payload.eventType==='game_coin_adjustment').map(r=>({...r.payload,id:r.record_id}));
  const history=(await client.query('SELECT h.*,u.email,u.display_name,s.payload AS shift FROM line_history h JOIN shifts s ON s.workspace_id=h.workspace_id AND s.shift_id=h.shift_id LEFT JOIN app_users u ON u.uid=h.uid WHERE h.workspace_id=$1 ORDER BY h.created_at,h.action_id',[ws])).rows;
  for(const h of history){const actor=h.game_actor||{email:h.email,name:h.display_name},operations=[{collection:'truckStatus',id:h.truck_id,before:h.before_status,after:h.after_status}];
    if(h.log_data)operations.push({collection:'logs',id:h.log_data.id,before:null,after:h.log_data});
    records.push({id:'nas_history_'+h.action_id,eventType:'history',timestamp:new Date(h.created_at).getTime(),shiftId:h.shift_id,objectId:actor.objectId||h.shift.objectId||'',objectName:actor.objectName||h.shift.objectName||'',userEmail:actor.email||'',userName:actor.name||'',history:{operations,undone:h.undone,...(h.game_rewards?{gameRewards:h.game_rewards}:{})}});
  }
  let head=initialHead();const players={};
  for(const row of records.filter(r=>r.eventType==='game_arcade').sort((a,b)=>a.gameRound-b.gameRound)){
    if(!Number.isSafeInteger(row.gameRound)||row.gameRound<1||row.id!==roundId(row.gameRound)||!Number.isSafeInteger(row.bank)||row.bank<0||!map(row.actors)||!map(row.player)||typeof row.userUid!=='string'||!Number.isSafeInteger(row.player.net))throw fail('invalid-game-ledger',409);
    if(row.gameRound<=head.gameRound)throw fail('duplicate-game-round',409);head=row;players[row.userUid]={...row.player,_round:row.gameRound};
  }
  return {records,adjustments,head,players};
}
export async function readGames(pool,uid,ws=WS){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const actor=await serviceActor(client,uid,null,{lock:false});
    const data=await gameData(client,ws);
    if(actor.role!=='admin')data.adjustments=data.adjustments.filter(r=>r.targetUid===uid);
    data.records=data.records.map(gameTransferRecord);
    await client.query('COMMIT');return {format:'samosval-games',version:1,source:'synology',workspaceId:ws,...data};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export function submitGame(pool,uid,input,ws=WS){
  const op=normalizeGame(input);
  return serviceCommand(pool,uid,op,ws,(client,user)=>serviceActor(client,user,null,{admin:op.type==='game.grant'}),async(client,actor)=>{
    const data=await gameData(client,ws),now=Date.now();
    const author={userUid:uid,userEmail:actor.email,createdByEmail:actor.email,userName:actor.display_name,timestamp:now,timeStr:new Date(now).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})};
    if(op.type==='game.grant'){
      const target=await serviceActor(client,op.targetUid);const entry={...author,eventType:'game_coin_adjustment',amount:op.amount,targetUid:target.uid,targetEmail:target.email,targetName:target.display_name,reason:op.reason,createdByUid:uid,text:'Начисление +'+op.amount+' монет: '+op.reason};
      await client.query("INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES ($1,$2,'coinTransactions',$3)",[ws,'coin_grant_'+op.id,entry]);
      return {result:{id:'coin_grant_'+op.id,amount:op.amount,targetUid:target.uid},after:entry};
    }
    const policy=(await client.query('SELECT payload FROM workspace_settings WHERE workspace_id=$1 FOR SHARE',[ws])).rows[0]?.payload;
    if(!policy)throw fail('settings-not-ready',409);
    const a={...op.action},kind=a.kind==='finish'?'mario':a.kind,flags=policy.testReviewFlags||{};
    if(flags.game_mode===false)throw fail('game-disabled',403);
    if(kind!=='purchase'){
      if(flags.arcade_enabled===false||flags['arcade_'+kind]===false)throw fail('game-disabled',403);
      if(!(await client.query("SELECT 1 FROM shifts WHERE workspace_id=$1 AND is_active=true AND payload->>'closing' IS DISTINCT FROM 'true' FOR SHARE",[ws])).rowCount)throw fail('open-shift-required',409);
    }else if(actor.role==='viewer')throw fail('shop-not-available',403);
    const own=data.records.filter(r=>r.eventType==='game_purchase'&&r.userUid===uid&&r.id===purchaseId(uid,r.itemId)&&Object.hasOwn(themePrices,r.itemId)&&r.price===themePrices[r.itemId]);
    if(kind==='purchase'&&own.some(r=>r.itemId===a.itemId))return {result:{noop:true,reason:'owned',delta:0}};
    const earned=calculate(data.records).find(r=>r.user===actor.email.trim().toLowerCase())?.coins||0;
    const player={...(data.players[uid]||initialPlayer(uid,actor.email,actor.display_name)),name:actor.display_name,email:actor.email};
    const grants=data.adjustments.filter(r=>r.targetUid===uid&&Number.isSafeInteger(r.amount)&&r.amount>0).reduce((n,r)=>n+r.amount,0);
    const funds=earned+(actor.role==='admin'?10000:0)+player.net+grants-own.reduce((n,r)=>n+r.price,0);
    if(kind==='purchase')a.price=themePrices[a.itemId];if(kind==='slot')a.roll=randomInt(10000);
    let outcome;try{outcome=settle(data.head,player,a,funds,dayKey(now));}catch(e){throw fail(e.message,409);}
    if(outcome.noop)return {result:{noop:true,reason:outcome.reason,delta:0}};
    const round=data.head.gameRound+1,state={gameRound:round,bank:outcome.head.bank,totalStakes:outcome.head.totalStakes,totalPayouts:outcome.head.totalPayouts,actors:{...data.head.actors,[uid]:round},player:outcome.player};
    const final={delta:outcome.delta,cost:outcome.cost||0,payout:outcome.payout||0,result:outcome.result||{},kind:a.kind,level:a.level||null,coin:a.coin??null,round};
    const entry={...author,...state,...(kind==='slot'&&final.payout>final.cost?{gameWinRound:round}:{}),eventType:'game_arcade',kind:a.kind,cost:final.cost,payout:final.payout,delta:final.delta,result:final.result,requestId:op.id,text:'🎮 '+({slot:'Вращение автомата',mario:'Монета Марио',finish:'Уровень Марио',purchase:'Покупка темы'}[a.kind])};
    await client.query("INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES ($1,$2,'audit',$3)",[ws,roundId(round),entry]);
    if(kind==='purchase')await client.query("INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES ($1,$2,'audit',$3)",[ws,purchaseId(uid,a.itemId),{...author,eventType:'game_purchase',itemId:a.itemId,price:a.price,text:'🛍 Куплена тема: '+a.itemId}]);
    return {result:{...final,confirmedHead:{...entry,id:roundId(round)}},after:entry};
  });
}
