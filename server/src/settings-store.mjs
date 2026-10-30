import {fail,map} from './tabel-access.mjs';
import {serviceActor,serviceCommand,validId} from './service-command.mjs';
const WS=process.env.WORKSPACE_ID||'main_workspace';
const flags=new Set(['game_mode','game_sound','game_effects','arcade_enabled','arcade_slot','arcade_mario','arcade_invites']);
const switches=new Set(['maxEnabled','notifyStart','notifyArrive','notifyLoad','notifyTtn','notifyLineStart','notifyLineEnd']);
const strings=new Set(['maxUrl','maxToken','maxChatId']);
const rates=x=>map(x)&&Object.keys(x).length===3&&['load','arrive','ttn'].every(k=>Number.isInteger(x[k])&&x[k]>=0&&x[k]<=10000);
export function normalizeSettings(input){
  if(!map(input)||!validId(input.id)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw fail('invalid-settings-operation');
  if(input.type==='settings.rewards'){
    if(!rates(input.values))throw fail('invalid-reward-rates');
    return {id:input.id,type:input.type,expectedRevision:input.expectedRevision,values:{load:input.values.load,arrive:input.values.arrive,ttn:input.values.ttn}};
  }
  if(input.type!=='settings.patch'||!map(input.patch)||!Object.keys(input.patch).length)throw fail('invalid-settings-operation');
  const patch={};
  for(const key of Object.keys(input.patch).sort()){
    const value=input.patch[key];
    if(key==='cycleMinutes'){if(!Number.isInteger(value)||value<15||value>10080)throw fail('invalid-cycle-minutes');}
    else if(key==='testReviewFlags'){
      if(!map(value)||!Object.keys(value).length||Object.entries(value).some(([k,v])=>!flags.has(k)||typeof v!=='boolean'))throw fail('invalid-review-flags');
    }else if(switches.has(key)){if(typeof value!=='boolean')throw fail('invalid-setting');}
    else if(strings.has(key)){
      if(typeof value!=='string'||value.length>(key==='maxUrl'?2000:500))throw fail('invalid-setting');
      if(key==='maxUrl'&&value){let url;try{url=new URL(value);}catch{throw fail('invalid-notification-url');}if(url.protocol!=='https:'||url.username||url.password)throw fail('invalid-notification-url');}
    }else throw fail('unsupported-setting');
    patch[key]=key==='testReviewFlags'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value;
  }
  return {id:input.id,type:input.type,expectedRevision:input.expectedRevision,patch};
}
export function settingsView(payload,admin){
  if(admin)return {...payload};
  return {cycleMinutes:payload.cycleMinutes,testReviewFlags:payload.testReviewFlags||{},gameRewardSchedule:payload.gameRewardSchedule||[]};
}
export async function readSettings(pool,uid,ws=WS){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor=await serviceActor(client,uid,null,{lock:false});
    const row=(await client.query('SELECT payload,revision FROM workspace_settings WHERE workspace_id=$1',[ws])).rows[0];
    if(!row)throw fail('settings-not-ready',409);
    await client.query('COMMIT');return {format:'samosval-settings',version:1,source:'synology',workspaceId:ws,revision:Number(row.revision),data:settingsView(row.payload,actor.role==='admin')};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export function submitSettings(pool,uid,input,ws=WS){
  const op=normalizeSettings(input);
  return serviceCommand(pool,uid,op,ws,(client,user)=>serviceActor(client,user,null,{admin:true}),async(client)=>{
    const row=(await client.query('SELECT payload,revision FROM workspace_settings WHERE workspace_id=$1 FOR UPDATE',[ws])).rows[0];
    if(!row||Number(row.revision)!==op.expectedRevision)throw fail('settings-changed',409);
    const before=row.payload;let after;
    if(op.type==='settings.rewards'){
      const schedule=Array.isArray(before.gameRewardSchedule)?before.gameRewardSchedule:[];
      if(schedule.length>=1000)throw fail('reward-history-full',409);
      after={...before,gameRewardSchedule:[...schedule,{effectiveAt:Math.max(Date.now(),Number(schedule.at(-1)?.effectiveAt||0)+1),...op.values}]};
    }else after={...before,...op.patch,...(op.patch.testReviewFlags?{testReviewFlags:{...before.testReviewFlags,...op.patch.testReviewFlags}}:{})};
    const revision=Number(row.revision)+1;
    if(op.patch?.cycleMinutes!==undefined)await client.query('UPDATE workspaces SET cycle_minutes=$2 WHERE id=$1',[ws,op.patch.cycleMinutes]);
    await client.query('UPDATE workspace_settings SET payload=$2,revision=$3 WHERE workspace_id=$1',[ws,after,revision]);
    return {before,after,result:{data:after,revision}};
  });
}
