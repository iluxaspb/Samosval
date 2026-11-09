
(function(root){
'use strict';
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
function leaderboard(players,mode='slot'){
 return Object.values(players).filter(p=>mode==='mario'?p.marioCoins>0:p.payouts>0||p.stakes>0).sort((a,b)=>mode==='mario'?b.marioCoins-a.marioCoins||a.name.localeCompare(b.name,'ru'):b.payouts-a.payouts||(b.payouts-b.stakes)-(a.payouts-a.stakes)||a.name.localeCompare(b.name,'ru'));
}
function randomFor(seed){let value=seed>>>0;return ()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return (value>>>0)/4294967296;};}
function createLevel(level){
 const random=randomFor(9731+level*4051),platforms=[],enemies=[],coins=[],checkpoints=[];let x=0;
 for(let i=0;i<24;i++){
  const width=250+Math.floor(random()*55),gap=i===23?0:60+Math.floor(random()*Math.min(65,25+level*2));
  platforms.push({x,y:440,w:width,h:110,ground:true});if(i%6===0)checkpoints.push({x:x+20,y:400});
  if([4,8,12,16,20].includes(i)){const px=x+width*.5;platforms.push({x:px-48,y:340,w:96,h:18,ground:false});coins.push({id:coins.length,x:px,y:315});}
  if(i>1&&i%3===0)enemies.push({x:x+width*.35,y:418,w:28,h:22,left:x+24,right:x+width-40,vx:30+level*1.4,alive:true});
  x+=width+gap;
 }
 return {level,width:x,height:540,platforms,enemies,coins,checkpoints,flag:x-90};
}
function intersects(a,b){return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;}
function createRun(level){return {map:createLevel(level),player:{x:35,y:400,w:26,h:34,vx:0,vy:0,grounded:false},lives:3,camera:0,time:0,checkpoint:{x:35,y:400},collected:new Set(),pending:new Set(),done:false,paused:false,jumpHeld:false};}
function advanceRun(run,input,dt,onEvent=()=>{}){
 if(run.paused||run.done)return;const step=Math.max(0,Math.min(.04,dt)),p=run.player,oldY=p.y;run.time+=step;
 p.vx=Math.max(-1,Math.min(1,input.axis||0))*225;
 if(input.jump&&!run.jumpHeld&&p.grounded){p.vy=-560;p.grounded=false;onEvent({type:'jump'});}run.jumpHeld=!!input.jump;
 p.vy=Math.min(850,p.vy+1400*step);p.x=Math.max(0,Math.min(run.map.width-p.w,p.x+p.vx*step));p.y+=p.vy*step;p.grounded=false;
 for(const q of run.map.platforms)if(p.vy>=0&&p.x+p.w>q.x&&p.x<q.x+q.w&&oldY+p.h<=q.y+2&&p.y+p.h>=q.y){p.y=q.y-p.h;p.vy=0;p.grounded=true;}
 for(const e of run.map.enemies){if(!e.alive)continue;e.x+=e.vx*step;if(e.x<e.left){e.x=e.left;e.vx=Math.abs(e.vx);}if(e.x>e.right){e.x=e.right;e.vx=-Math.abs(e.vx);}if(intersects(p,e)){if(p.vy>=0&&oldY+p.h<=e.y+9){e.alive=false;p.vy=-330;onEvent({type:'stomp'});}else{hurt(run,onEvent);break;}}}
 if(p.y>650)hurt(run,onEvent);
 for(const c of run.map.checkpoints)if(p.grounded&&p.x>=c.x&&c.x>run.checkpoint.x)run.checkpoint=c;
 for(const c of run.map.coins)if(!run.collected.has(c.id)&&!run.pending.has(c.id)&&intersects(p,{x:c.x-10,y:c.y-10,w:20,h:20})){run.pending.add(c.id);onEvent({type:'coin',coin:c.id});}
 if(p.x>=run.map.flag&&!run.done){run.done=true;onEvent({type:'finish'});}
 run.camera=Math.max(0,Math.min(run.map.width-960,p.x-260));
}
function hurt(run,onEvent){run.lives--;run.player.x=run.checkpoint.x;run.player.y=run.checkpoint.y;run.player.vx=0;run.player.vy=0;run.player.grounded=false;run.paused=run.lives<=0;onEvent({type:'hurt',over:run.paused});}
root.RoadArcadeCore={LIMIT,BET,LEVELS,COINS_PER_LEVEL,dayKey,roundId,initialHead,initialPlayer,slotOutcome,settle,leaderboard,createLevel,createRun,advanceRun};
})(typeof window!=='undefined'?window:globalThis);

