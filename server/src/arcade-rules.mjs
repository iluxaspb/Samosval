// Pure settlement rules mirrored from TEST; parity is checked against the UI source.

const LIMIT=100,BET=10,LEVELS=20,COINS_PER_LEVEL=5;
const dayKey=(time=Date.now())=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time));const pick=t=>parts.find(p=>p.type===t).value;return pick('year')+'-'+pick('month')+'-'+pick('day');};
const roundId=n=>'arcade_v1_'+String(n).padStart(12,'0');
const initialHead=()=>({gameRound:0,bank:1000,totalStakes:0,totalPayouts:0,actors:{}});
const initialPlayer=(uid,email,name)=>({uid,email,name,net:0,payouts:0,stakes:0,spins:0,jackpots:0,marioCoins:0,unlocked:1,daily:{day:'',claims:[]}});
function slotOutcome(roll,bank,opts){
 if(!Number.isInteger(roll)||roll<0||roll>=10000)throw Error('Неверный результат барабанов');
 // Таблица выплат «Джекпот» (решение владельца от 23.11.2026): классические
 // комбинации, деньги в монетах, ставка BET=10. Диапазоны roll 0..9999
 // подобраны под суммарную отдачу около 98% ставки.
 // Железное правило: администратору джекпот не выпадает никогда. Бросок
 // детерминированно выводится из джекпот-диапазона, поэтому барабаны,
 // выплата и журнал всегда согласованы — подмены нет.
 if(opts&&opts.isAdmin)roll=adminSlotRoll(roll);
 const type=roll===0?'jackpot':roll<7?'seven':roll<37?'diamond':roll<107?'cone':roll<267?'lemon':roll<567?'bell':roll<1167?'star':roll<2767?'cherry':roll<5267?'cherry2':'loss';
 const requested=type==='jackpot'?bank+BET:type==='seven'?500:type==='diamond'?150:type==='cone'?70:type==='lemon'?50:type==='bell'?40:type==='star'?30:type==='cherry'?20:type==='cherry2'?5:0;
 // Проигрыш показывает честный разнобой — три РАЗНЫХ символа без вишен:
 // показанные две вишни всегда платят 5, разнобой — никогда.
 const lossSymbols=type==='loss'?slotLossSymbols(roll):null;
 return {type,payout:Math.min(bank+BET,requested),symbols:type==='jackpot'?['👑','👑','👑']:type==='seven'?['7️⃣','7️⃣','7️⃣']:type==='diamond'?['💎','💎','💎']:type==='cone'?['🚧','🚧','🚧']:type==='lemon'?['🍋','🍋','🍋']:type==='bell'?['🔔','🔔','🔔']:type==='star'?['⭐','⭐','⭐']:type==='cherry'?['🍒','🍒','🍒']:type==='cherry2'?twoCherries(roll):lossSymbols};
}
const SLOT_LOSS_FACES=['⭐','🔔','🍋','🚧','💎','7️⃣','👑'];
const SLOT_LOSS_TRIPLES=[];for(let a=0;a<7;a++)for(let b=0;b<7;b++)for(let c=0;c<7;c++)if(a!==b&&b!==c&&a!==c)SLOT_LOSS_TRIPLES.push([a,b,c]);
function slotLossSymbols(roll){
 const t=SLOT_LOSS_TRIPLES[((roll-5267)%SLOT_LOSS_TRIPLES.length+SLOT_LOSS_TRIPLES.length)%SLOT_LOSS_TRIPLES.length];
 return t.map(i=>SLOT_LOSS_FACES[i]);
}
function twoCherries(roll){
 // Ровно две вишни в позициях, зависящих от броска: третья — не вишня.
 const inner=roll-2767,symbols=['🍒','🍒','🍒'];
 symbols[inner%3]=SLOT_LOSS_FACES[inner%7];
 return symbols;
}
// Ремап броска для администратора: единственный джекпот-бросок (0) уводится в
// проигрышный диапазон. Всё остальное без изменений — отдача и таблица те же.
function adminSlotRoll(roll){return roll===0?9999:roll;}
function settle(head,player,action,available,day,opts){
 const h=JSON.parse(JSON.stringify(head)),p=JSON.parse(JSON.stringify(player));let delta=0,cost=0,payout=0,result={};
 if(action.kind==='slot'){
  if(available<BET)throw Error('Для вращения нужно 10 монет. Их можно собрать в Марио.');
  result=slotOutcome(action.roll,h.bank,opts);cost=BET;payout=result.payout;delta=payout-cost;
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
  const coins=Number.isInteger(action.coins)?Math.max(0,Math.min(99,action.coins)):0;
  p.marioCoins+=coins;p.net+=coins;delta=coins;payout=coins;
  if(p.unlocked<=action.level&&action.level<LEVELS)p.unlocked=action.level+1;
  result={type:'mario_finish',coins,score:Number.isInteger(action.score)?action.score:0,bonus:Number.isInteger(action.jumpBonus)?action.jumpBonus:0,unlocked:p.unlocked};
 }else if(action.kind==='dino'){
  const coins=Number.isInteger(action.coins)?Math.max(0,Math.min(99,action.coins)):0;
  p.net+=coins;delta=coins;payout=coins;
  result={type:'dino_run',coins,score:Number.isInteger(action.score)?action.score:0};
 }else if(action.kind==='purchase'){
  if(!Number.isInteger(action.price)||action.price<0||available<action.price)throw Error('Монет пока недостаточно.');cost=action.price;
 }else throw Error('Неизвестное игровое действие');
 return {head:h,player:p,delta,cost,payout,result};
}

export {dayKey,roundId,initialHead,initialPlayer,slotOutcome,settle};
