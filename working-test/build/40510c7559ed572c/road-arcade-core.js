
(function(root){
'use strict';
const LIMIT=100,BET=10,LEVELS=20,COINS_PER_LEVEL=5;
const dayKey=(time=Date.now())=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time));const pick=t=>parts.find(p=>p.type===t).value;return pick('year')+'-'+pick('month')+'-'+pick('day');};
const roundId=n=>'arcade_v1_'+String(n).padStart(12,'0');
const initialHead=()=>({gameRound:0,bank:1000,totalStakes:0,totalPayouts:0,actors:{}});
const initialPlayer=(uid,email,name)=>({uid,email,name,net:0,payouts:0,stakes:0,spins:0,jackpots:0,marioCoins:0,unlocked:1,daily:{day:'',claims:[]}});
function slotOutcome(roll,bank){
 if(!Number.isInteger(roll)||roll<0||roll>=10000)throw Error('Неверный результат барабанов');
 // Выплаты 4.2.9: чаще и заметнее, чем прежние 12/20/100. Суммарная отдача
 // около 98% ставки, поэтому банк автомата не «съедается» за десяток вращений.
 const type=roll===0?'jackpot':roll<150?'big':roll<950?'medium':roll<4350?'small':'loss';
 const requested=type==='jackpot'?bank+BET:type==='big'?150:type==='medium'?30:type==='small'?15:0;
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
  // В конце уровня все собранные монеты перечисляются в кошелёк. Дневного
  // лимита нет; сервер ограничивает только разумный размер одной выплаты.
  const coins=Number.isInteger(action.coins)?Math.max(0,Math.min(99,action.coins)):0;
  p.marioCoins+=coins;p.net+=coins;delta=coins;payout=coins;
  if(p.unlocked<=action.level&&action.level<LEVELS)p.unlocked=action.level+1;
  result={type:'mario_finish',coins,score:Number.isInteger(action.score)?action.score:0,bonus:Number.isInteger(action.jumpBonus)?action.jumpBonus:0,unlocked:p.unlocked};
 }else if(action.kind==='dino'){
  // Заезд «Дино»: ставка не нужна, монеты зачисляются одним платежом только
  // по завершённому заезду (game over). Сервер ограничивает размер выплаты.
  const coins=Number.isInteger(action.coins)?Math.max(0,Math.min(99,action.coins)):0;
  p.net+=coins;delta=coins;payout=coins;
  result={type:'dino_run',coins,score:Number.isInteger(action.score)?action.score:0};
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
 const random=randomFor(9731+level*4051),platforms=[],blocks=[],coins=[],enemies=[],pipes=[],checkpoints=[];let x=0;
 const groundY=440,segments=26;
 for(let i=0;i<segments;i++){
  const width=260+Math.floor(random()*60),gap=i===segments-1?0:70+Math.floor(random()*Math.min(70,30+level*2));
  platforms.push({x,y:groundY,w:width,h:110,ground:true});
  if(i%6===0)checkpoints.push({x:x+20,y:400});
  // Кирпичи и блоки с вопросом: из блока выскакивает монетка.
  if(i>1&&i%2===0){
   const count=3+Math.floor(random()*3),bx=x+60;
   for(let b=0;b<count;b++)blocks.push({id:blocks.length,x:bx+b*46,y:300,w:44,h:44,kind:(b===1||(b===3&&random()<.5))?'question':'brick',used:false,coins:1+(random()<.3?2:0)});
  }
  if(i>3&&i%3===1)blocks.push({id:blocks.length,x:x+width*.55,y:236,w:44,h:44,kind:'brick',used:false,coins:0});
  if(i>2&&i%4===2)pipes.push({x:x+width*.45,y:groundY-96,w:64,h:96});
  if(i>2&&i%2===1){const n=3+Math.floor(random()*3);for(let c=0;c<n;c++)coins.push({id:coins.length,x:x+width*.35+c*34,y:262});}
  if(i>4&&i<segments-2&&i%3===1){const left=x+40,right=x+width-40;enemies.push({x:left+random()*(right-left),y:groundY-26,w:30,h:26,left,right,vx:(random()<.5?-1:1)*(28+level*1.4),alive:true});}
  x+=width+gap;
 }
 return {level,width:x,height:540,groundY,platforms,blocks,coins,enemies,pipes,checkpoints,flag:x-80};
}
function intersects(a,b){return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;}
function createRun(level){return {map:createLevel(level),player:{x:36,y:400,w:28,h:36,vx:0,vy:0,grounded:false},lives:3,invuln:0,over:false,camera:0,time:0,checkpoint:{x:36,y:400},collected:new Set(),pending:new Set(),done:false,paused:false,jumpHeld:false,coins:0,score:0,stomps:0,maxJumpHeight:0};}
function advanceRun(run,input,dt,onEvent=()=>{}){
 if(run.paused||run.done||run.over)return;const step=Math.max(0,Math.min(.04,dt)),p=run.player,m=run.map;run.time+=step;
 if(run.invuln>0)run.invuln=Math.max(0,run.invuln-step);
 p.vx=Math.max(-1,Math.min(1,input.axis||0))*230;
 const wanted=!!input.jump;
 if(wanted&&!run.jumpHeld&&p.grounded){p.vy=-760;p.grounded=false;onEvent({type:'jump'});}
 // Отпущенная рано кнопка прыжка даёт низкий прыжок — как в оригинале.
 if(!wanted&&run.jumpHeld&&p.vy<-260)p.vy*=.42;
 run.jumpHeld=wanted;
 const oldX=p.x,oldY=p.y;
 p.vy=Math.min(900,p.vy+1400*step);
 p.x=Math.max(0,Math.min(m.width-p.w,p.x+p.vx*step));
 for(const q of m.pipes)if(intersects(p,q)&&oldY+p.h>q.y+6){p.x=oldX;break;}
 const wasAir=!p.grounded,impact=p.vy;p.y+=p.vy*step;p.grounded=false;
 for(const q of m.platforms)if(p.vy>=0&&p.x+p.w>q.x&&p.x<q.x+q.w&&oldY+p.h<=q.y+2&&p.y+p.h>=q.y){p.y=q.y-p.h;p.vy=0;p.grounded=true;}
 for(const q of m.pipes)if(p.vy>=0&&p.x+p.w>q.x&&p.x<q.x+q.w&&oldY+p.h<=q.y+2&&p.y+p.h>=q.y){p.y=q.y-p.h;p.vy=0;p.grounded=true;}
 for(const b of m.blocks){
  const hitX=p.x+p.w>b.x+2&&p.x<b.x+b.w-2;if(!hitX)continue;
  if(p.vy>=0&&oldY+p.h<=b.y+2&&p.y+p.h>=b.y&&p.y+p.h<=b.y+b.h){p.y=b.y-p.h;p.vy=0;p.grounded=true;}
  else if(p.vy<0&&oldY>=b.y+b.h-2&&p.y<=b.y+b.h&&p.y+p.h>b.y+b.h-4){
   p.y=b.y+b.h;p.vy=0;
   if(b.kind==='question'&&!b.used){b.used=true;const gain=b.coins||1;run.coins+=gain;run.score+=100*gain;onEvent({type:'blockCoin',block:b,coins:gain,x:b.x+b.w/2,y:b.y});}
   else onEvent({type:'bump',block:b});
  }
 }
 if(wasAir&&p.grounded&&impact>240)onEvent({type:'land',impact:Math.round(impact),x:p.x,y:p.y});
 if(!p.grounded)run.maxJumpHeight=Math.max(run.maxJumpHeight,Math.max(0,m.groundY-(p.y+p.h)));
 for(const e of m.enemies){if(!e.alive)continue;e.x+=e.vx*step;if(e.x<e.left){e.x=e.left;e.vx=Math.abs(e.vx);}if(e.x>e.right){e.x=e.right;e.vx=-Math.abs(e.vx);}if(intersects(p,e)){if(p.vy>0&&oldY+p.h<=e.y+10){e.alive=false;run.coins+=1;run.stomps+=1;run.score+=200;p.vy=-390;p.grounded=false;onEvent({type:'stomp',x:e.x+e.w/2,y:e.y});}else{hurt(run,onEvent);break;}}}
 if(p.y>650)hurt(run,onEvent);
 for(const c of m.checkpoints)if(p.grounded&&p.x>=c.x&&c.x>run.checkpoint.x){run.checkpoint=c;onEvent({type:'checkpoint',x:c.x});}
 for(const c of m.coins)if(!run.collected.has(c.id)&&intersects(p,{x:c.x-10,y:c.y-12,w:20,h:24})){run.collected.add(c.id);run.coins+=1;run.score+=100;onEvent({type:'coin',coin:c.id,x:c.x,y:c.y});}
 if(p.x>=m.flag&&!run.done){
  run.done=true;
  const height=Math.max(0,run.maxJumpHeight);
  const bonus=Math.max(1,Math.min(10,1+Math.floor(Math.max(0,height-24)/9)));
  run.coins+=bonus;run.score+=bonus*100;
  onEvent({type:'finish',bonus,height,coins:run.coins,score:run.score,stomps:run.stomps});
 }
 run.camera=Math.max(0,Math.min(m.width-960,p.x-260));
}
function hurt(run,onEvent){
 if(run.over||run.invuln>0)return;
 const p=run.player;run.lives=Math.max(0,run.lives-1);run.invuln=1.7;
 if(p.y>650){p.x=run.checkpoint.x;p.y=run.checkpoint.y;p.vy=0;}else{p.x=Math.max(0,p.x-44);p.vy=-320;}
 p.vx=0;p.grounded=false;run.maxJumpHeight=0;
 if(run.lives<=0){run.over=true;run.paused=true;run.done=false;onEvent({type:'gameover',lives:0,coins:run.coins,score:run.score});}
 else onEvent({type:'hurt',lives:run.lives,invuln:run.invuln});
}
// ── «Дино»: бесконечный бег с прыжками через кактусы и птиц ──────────────
// Логика отделена от рисования: createDinoRun/advanceDinoRun работают с
// числами и не знают про canvas — поэтому тестируются в node --test.
const DINO={W:44,H:47,GRAVITY:2600,JUMP:-880,START_SPEED:340,MAX_SPEED:760,ACCEL:7,GROUND_Y:150};
function createDinoRun(){
 return {t:0,animT:0,speed:DINO.START_SPEED,dino:{y:0,vy:0,ducking:false,grounded:true},obstacles:[],coins:[],nextSpawn:1.2,nextCoin:.8,collected:0,score:0,over:false,jumpHeld:false,startedAt:Date.now(),runId:Math.floor(Math.random()*1e9)};
}
function dinoBox(run){const d=run.dino;const y=DINO.GROUND_Y-(d.ducking?DINO.H*.55:DINO.H)-d.y;return {x:54,y,w:d.ducking?DINO.W*1.25:DINO.W,h:d.ducking?DINO.H*.55:DINO.H};}
function dinoRect(a,b){return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;}
// Препятствия появляются по «таймеру расстояния», высота/тип — детерминированно
// от счётчика (никакого Math.random в логике — проще повторять в тестах).
function spawnDinoObstacle(run){
 run._spawn=(run._spawn||0)+1;const n=run._spawn;
 const bird=n%4===0&&run.t>14; // птицы только после разгона
 if(bird)return {kind:'bird',x:1000,y:DINO.GROUND_Y-(62+((n>>2)%3)*22),w:46,h:32};
 const tall=n%3===0;return {kind:'cactus',x:1000,y:DINO.GROUND_Y-(tall?58:40),w:tall?26:20,h:tall?58:40};
}
function advanceDinoRun(run,input,dt,onEvent=()=>{}){
 if(run.over)return;const step=Math.max(0,Math.min(.05,dt));run.t+=step;
 // Фаза анимации бега: копится пропорционально скорости и реальному dt —
 // не зависит от fps и замирает на паузе (advance просто не вызывается).
 run.animT=(run.animT||0)+step*(6+run.speed/60);
 run.speed=Math.min(DINO.MAX_SPEED,run.speed+DINO.ACCEL*step);
 const d=run.dino,wantJump=!!input.jump,wantDuck=!!input.duck;
 // Прыжок — с земли, по свежему нажатию; короткое нажатие = низкий прыжок.
 if(wantJump&&!run.jumpHeld&&d.grounded){d.vy=DINO.JUMP;d.grounded=false;onEvent({type:'jump'});}
 if(!wantJump&&run.jumpHeld&&d.vy<-300)d.vy*=.45;
 run.jumpHeld=wantJump;
 d.ducking=d.grounded&&wantDuck;
 d.vy=Math.min(1100,d.vy+DINO.GRAVITY*step);d.y-=d.vy*step;
 if(d.y<=0){if(!d.grounded&&d.vy>200)onEvent({type:'land'});d.y=0;d.vy=0;d.grounded=true;}
 const dx=run.speed*step;run.score+=Math.round(dx/10);
 run.nextSpawn-=step;
 if(run.nextSpawn<=0){run.obstacles.push(spawnDinoObstacle(run));run.nextSpawn=0.85+((run._spawn||0)%5)*0.22;}
 run.nextCoin-=step;
 if(run.nextCoin<=0){run._coin=(run._coin||0)+1;const c=run._coin;run.coins.push({id:c,x:1000,y:DINO.GROUND_Y-(44+(c%4)*30),w:22,h:22});run.nextCoin=1.6+(c%3)*0.7;}
 const me=dinoBox(run);
 for(const q of run.obstacles)q.x-=dx;
 run.obstacles=run.obstacles.filter(q=>q.x+q.w>-20);
 for(const c of run.coins)c.x-=dx;
 run.coins=run.coins.filter(c=>{if(dinoRect(me,c)){run.collected++;run.score+=25;onEvent({type:'coin'});return false;}return c.x+c.w>-20;});
 for(const q of run.obstacles)if(dinoRect(me,q)){run.over=true;onEvent({type:'gameover',score:run.score,coins:run.collected});return;}
}
root.RoadArcadeCore={LIMIT,BET,LEVELS,COINS_PER_LEVEL,dayKey,roundId,initialHead,initialPlayer,slotOutcome,settle,leaderboard,createLevel,createRun,advanceRun,DINO,createDinoRun,advanceDinoRun};
})(typeof window!=='undefined'?window:globalThis);

