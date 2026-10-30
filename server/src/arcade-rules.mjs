// Pure settlement rules mirrored from TEST; parity is checked against the UI source.

const LIMIT=100,BET=10,LEVELS=20,COINS_PER_LEVEL=5;
const dayKey=(time=Date.now())=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time));const pick=t=>parts.find(p=>p.type===t).value;return pick('year')+'-'+pick('month')+'-'+pick('day');};
const roundId=n=>'arcade_v1_'+String(n).padStart(12,'0');
const initialHead=()=>({gameRound:0,bank:1000,totalStakes:0,totalPayouts:0,actors:{}});
const initialPlayer=(uid,email,name)=>({uid,email,name,net:0,payouts:0,stakes:0,spins:0,jackpots:0,marioCoins:0,unlocked:1,daily:{day:'',claims:[]}});
function slotOutcome(roll,bank){
 if(!Number.isInteger(roll)||roll<0||roll>=10000)throw Error('Неверный результат барабанов');
 const type=roll===0?'jackpot':roll<100?'big':roll<1100?'medium':roll<4600?'small':'loss';
 const requested=type==='jackpot'?bank+BET:type==='big'?100:type==='medium'?20:type==='small'?12:0;
 return {type,payout:Math.min(bank+BET,requested),symbols:type==='jackpot'?['👑','👑','👑']:type==='big'?['💎','💎','💎']:type==='medium'?['⭐','⭐','⭐']:type==='small'?['🍒','🍒','🍒']:['🚧','🍒','⭐']};
}
function settle(head,player,action,available,day){
 const h=JSON.parse(JSON.stringify(head)),p=JSON.parse(JSON.stringify(player));let delta=0,cost=0,payout=0,result={};
 if(action.kind==='slot'){
  if(available<BET)throw Error('Для вращения нужно 10 монет. Их можно собрать в Марио.');
  result=slotOutcome(action.roll,h.bank);cost=BET;payout=result.payout;delta=payout-cost;
  h.bank+=cost-payout;h.totalStakes+=cost;h.totalPayouts+=payout;p.net+=delta;p.stakes+=cost;p.payouts+=payout;p.spins++;if(result.type==='jackpot')p.jackpots++;
 }else if(action.kind==='mario'){
  if(action.day!==day)throw Error('Наступил новый день. Соберите монетку ещё раз.');
  if(!Number.isInteger(action.level)||action.level<1||action.level>Math.min(LEVELS,p.unlocked)||!Number.isInteger(action.coin)||action.coin<0||action.coin>=COINS_PER_LEVEL)throw Error('Этот уровень пока закрыт.');
  if(p.daily.day!==day)p.daily={day,claims:[]};const id=action.level+':'+action.coin;
  if(p.daily.claims.includes(id))return {head:h,player:p,delta:0,noop:true,reason:'collected'};
  if(p.daily.claims.length>=LIMIT)return {head:h,player:p,delta:0,noop:true,reason:'limit'};
  p.daily.claims.push(id);p.marioCoins++;p.net++;delta=1;payout=1;
 }else if(action.kind==='finish'){
  if(!Number.isInteger(action.level)||action.level<1||action.level>p.unlocked||action.level>LEVELS)throw Error('Этот уровень пока закрыт.');
  if(p.unlocked>action.level||action.level===LEVELS)return {head:h,player:p,delta:0,noop:true,reason:'completed'};
  p.unlocked=action.level+1;
 }else if(action.kind==='purchase'){
  if(!Number.isInteger(action.price)||action.price<0||available<action.price)throw Error('Монет пока недостаточно.');cost=action.price;
 }else throw Error('Неизвестное игровое действие');
 return {head:h,player:p,delta,cost,payout,result};
}

export {dayKey,roundId,initialHead,initialPlayer,settle};
