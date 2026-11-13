
(function(){
'use strict';
const A=window.RoadArcade,C=window.RoadArcadeCore,E=escapeHtml;
let view='home',rankMode='slot',dialogOwner='',viewStamp='',run=null,raf=0,lastFrame=0,slotBusy=false,slotTimer=null,slotMessage='',slotSymbols=['🍒','⭐','💎'],audio=null,sound=true,musicOn=true,invites=true,seenOwner='',lastShiftId='',notice='',levelBusy=false,lastDay=C.dayKey(),coinFx=[],finishSummary=null;
let dinoRun=null,dinoRaf=0,dinoLast=0,dinoBusy=false,dinoBestShown=false,dinoCoinFx=[],dinoResizeObs=null;
const keys=new Set(),pointers=new Map(),f=n=>Number(n||0).toLocaleString('ru-RU');
let joyAxis=0;
const dialog=document.createElement('dialog');dialog.id='arcade-dialog';dialog.setAttribute('aria-labelledby','arcade-title');document.body.append(dialog);
const entry=document.createElement('button');entry.id='arcade-entry';entry.type='button';entry.title='Мини-игры и рейтинг выигрышей';entry.setAttribute('aria-label','Мини-игры и рейтинг выигрышей');entry.textContent='🎮';document.querySelector('#mainHeader .top-row')?.insertBefore(entry,document.querySelector('#mainHeader .gear-btn'));
const mascot=()=>'<div class="slot-mascot" aria-hidden="true"><div class="eyes"><i class="eye"></i><i class="eye"></i></div><div class="smirk"></div><div class="belly">🍒 ⭐</div><i class="lever"></i></div>';
dialog.addEventListener('click',e=>{const b=e.target.closest?.('button');if(b&&!b.closest('#mario-pad'))tone('click');});
const prefKey=()=>['samosval-working-test-arcade-prefs-v1',firebaseConfig.projectId,WORKSPACE_ID,currentUid].join(':');
const inviteKey=()=>prefKey()+':invitations';
function loadPrefs(){try{const p=JSON.parse(localStorage.getItem(prefKey())||'{}');sound=p.sound!==false;musicOn=p.music!==false;invites=p.invites!==false;}catch(e){sound=true;musicOn=true;invites=true;}}
function savePrefs(){try{localStorage.setItem(prefKey(),JSON.stringify({sound,music:musicOn,invites}));}catch(e){}if(!sound){speechSynthesisSafeCancel();}if(!musicOn)musicStop();updateSettings();}
function unlocked(){return Math.min(20,A.me().unlocked||1);}
function unlockSound(){if((!sound&&!musicOn)||appConfig?.testReviewFlags?.game_sound===false)return;try{const Audio=window.AudioContext||window.webkitAudioContext;if(Audio){audio=audio||new Audio();if(audio.state==='suspended')audio.resume().catch(()=>{});}}catch(e){}}
function audioReady(){return sound&&appConfig?.testReviewFlags?.game_sound!==false&&audio?.state==='running';}
function musicReady(){return musicOn&&appConfig?.testReviewFlags?.game_sound!==false&&audio?.state==='running';}
// Звуки 90-х синтезируются здесь же: щелчок барабана, механический «клак»
// остановки, звон монет, сирена и фанфары джекпота. Никаких внешних сэмплов,
// поэтому игра звучит и без сети и не тянет чужие лицензии.
function audioEnv(gain,t,peak,dur,attack){gain.gain.setValueAtTime(.0001,t);gain.gain.linearRampToValueAtTime(peak,t+(attack||.006));gain.gain.exponentialRampToValueAtTime(.0001,t+dur);}
function audioBeep(freq,t,dur,opt){opt=opt||{};const o=audio.createOscillator(),g=audio.createGain();o.type=opt.type||'sine';o.frequency.setValueAtTime(freq,t);if(opt.to)o.frequency.exponentialRampToValueAtTime(Math.max(40,opt.to),t+dur);audioEnv(g,t,opt.peak||.045,dur,opt.attack);o.connect(g);g.connect(audio.destination);o.start(t);o.stop(t+dur+.02);o.onended=()=>{o.disconnect();g.disconnect();};}
function audioNoise(t,dur,opt){opt=opt||{};const len=Math.max(1,Math.floor(audio.sampleRate*dur)),buf=audio.createBuffer(1,len,audio.sampleRate),data=buf.getChannelData(0);for(let i=0;i<len;i++)data[i]=(Math.random()*2-1)*(1-i/len);const src=audio.createBufferSource(),flt=audio.createBiquadFilter(),g=audio.createGain();src.buffer=buf;flt.type='highpass';flt.frequency.value=opt.hp||900;src.connect(flt);flt.connect(g);g.connect(audio.destination);audioEnv(g,t,opt.peak||.05,dur);src.start(t);src.stop(t+dur);src.onended=()=>{src.disconnect();flt.disconnect();g.disconnect();};}
function coinDing(t,peak,base){peak=peak||.05;base=base||2093;audioBeep(base,t,.16,{peak:peak});audioBeep(base*1.26,t+.028,.2,{peak:peak*.7});audioBeep(base*1.5,t+.06,.14,{peak:peak*.45});}
function tone(kind){if(!audioReady())return;
 try{const t=audio.currentTime;
  if(kind==='spin'){audioNoise(t,.03,{peak:.02,hp:2000});audioBeep(2300,t,.022,{type:'square',peak:.011});}
  else if(kind==='lever'){[0,.055,.11].forEach((d,i)=>{audioNoise(t+d,.035,{peak:.03-i*.006,hp:1100});audioBeep(140-i*12,t+d,.025,{type:'triangle',peak:.02});});audioBeep(92,t+.18,.12,{type:'triangle',peak:.045,to:60});}
  else if(kind==='reelstop'){audioNoise(t,.045,{peak:.05,hp:350});audioBeep(150,t,.09,{type:'triangle',peak:.05,to:95});}
  else if(kind==='coin')coinDing(t);
  else if(kind==='win'){[523,659,784,1046].forEach((n,i)=>audioBeep(n,t+i*.11,.22,{type:'square',peak:.035}));coinDing(t+.5,.04);}
  else if(kind==='jackpot'){for(let i=0;i<6;i++){const up=i%2===0;audioBeep(up?640:1180,t+i*.16,.15,{type:'sawtooth',peak:.028,to:up?1180:640});}[523,659,784,1046,1318,1568].forEach((n,i)=>audioBeep(n,t+1.02+i*.1,.26,{type:'square',peak:.04}));for(let i=0;i<14;i++)coinDing(t+1.2+i*.07,.032,1800+(i%3)*220);}
  else if(kind==='jump'){audioBeep(520,t,.075,{type:'square',peak:.05,to:1450});audioBeep(260,t,.05,{type:'triangle',peak:.03,to:760});}
  else if(kind==='jumpRun'){audioBeep(620,t,.07,{type:'square',peak:.05,to:1650});audioBeep(310,t,.05,{type:'triangle',peak:.028,to:900});}
  else if(kind==='jumpBounce'){audioBeep(720,t,.07,{type:'square',peak:.048,to:1800});audioBeep(360,t,.05,{type:'triangle',peak:.026,to:1000});}
  else if(kind==='land'){audioNoise(t,.035,{peak:.024,hp:260});audioBeep(150,t,.055,{type:'triangle',peak:.03,to:80});}
  else if(kind==='score'){[988,1319].forEach((n,i)=>audioBeep(n,t+i*.055,.08,{type:'square',peak:.03}));}
  else if(kind==='click'){audioBeep(1180,t,.028,{type:'square',peak:.018,to:900});}
  else if(kind==='checkpoint'){[659,988].forEach((n,i)=>audioBeep(n,t+i*.09,.11,{type:'square',peak:.032}));}
  else if(kind==='record'){[784,988,1175,1568].forEach((n,i)=>audioBeep(n,t+i*.09,.14,{type:'square',peak:.036}));coinDing(t+.4,.035,1760);}
  else if(kind==='hornHit'){[392,330,262].forEach((n,i)=>audioBeep(n,t+i*.12,.1,{type:'square',peak:.05}));[392,330,262].forEach((n,i)=>audioBeep(n,t+.42+i*.12,.1,{type:'square',peak:.05}));audioNoise(t+.8,.28,{peak:.075,hp:120});audioBeep(110,t+.8,.3,{type:'sine',peak:.07,to:40});}
  else if(kind==='gameover'){[523,494,440,392,330,262,196].forEach((n,i)=>audioBeep(n,t+i*.19,.22,{type:'square',peak:.036}));audioBeep(98,t+1.35,.5,{type:'triangle',peak:.05,to:60});}
  else if(kind==='block'){audioNoise(t,.03,{peak:.03,hp:700});audioBeep(180,t,.07,{type:'square',peak:.04,to:120});}
  else if(kind==='stomp'){audioNoise(t,.04,{peak:.045,hp:400});audioBeep(220,t,.1,{type:'square',peak:.045,to:90});}
  else if(kind==='clear'){[523,659,784,1046,1318,1568,2093].forEach((n,i)=>audioBeep(n,t+i*.12,.2,{type:'square',peak:.04}));}
  else if(kind==='finish'){[659,784,1046,1318].forEach((n,i)=>audioBeep(n,t+i*.1,.22,{type:'triangle',peak:.04}));}
  else if(kind==='hurt')audioBeep(230,t,.28,{type:'sawtooth',peak:.04,to:95});
  else audioBeep(330,t,.12,{peak:.03});
 }catch(e){}
}
function speak(text){if(!sound||appConfig?.testReviewFlags?.game_sound===false||!audio||audio.state!=='running'||!window.speechSynthesis||!window.SpeechSynthesisUtterance)return;try{const u=new SpeechSynthesisUtterance(text);u.lang='ru-RU';u.rate=1.05;u.volume=.55;window.speechSynthesis.speak(u);}catch(e){}}
function speechSynthesisSafeCancel(){try{window.speechSynthesis?.cancel();}catch(e){}}
// Фоновая восьмибитная музыка уровня: своя тема из восьми фраз, цикл ~49 секунд.
// Планировщик ставит ноты заранее по audio.currentTime, поэтому нет рывков и обрыва на стыке.
const MUSIC_STEP=.19;
const MUSIC_ORDER=['A','B','A','C','A','B','C','D'];
const MUSIC_LEAD={
 A:[523,523,0,392,523,659,0,784, 659,0,587,523,0,440,392,0, 523,523,0,392,523,659,784,0, 880,784,659,523,587,0,523,0],
 B:[659,0,659,784,880,0,784,659, 587,0,587,659,523,0,440,0, 659,0,659,784,880,988,880,784, 659,587,523,440,392,0,523,0],
 C:[784,784,880,784,659,0,587,0, 523,587,659,784,880,0,0,0, 1046,880,784,659,587,0,523,0, 440,523,587,659,523,0,0,0],
 D:[392,0,440,0,523,0,587,0, 659,0,784,0,659,0,523,0, 392,0,440,0,523,0,659,0, 784,0,880,0,1046,0,0,0]
};
const MUSIC_BASS={
 A:[131,131,165,165,175,175,196,196],
 B:[131,131,165,165,175,175,196,196],
 C:[175,175,196,196,131,131,165,165],
 D:[131,165,175,196,131,165,175,196]
};
const MUSIC_ARP={
 A:[523,659,784,1046],B:[659,784,988,1175],C:[784,988,1175,1568],D:[523,659,784,988]
};
let musicTimer=0,musicStep=0,musicNext=0;
function musicScheduleStep(i,t){
 const sec=MUSIC_ORDER[Math.floor(i/32)%MUSIC_ORDER.length],s=i%32,lead=MUSIC_LEAD[sec][s];
 if(lead)audioBeep(lead,t,.15,{type:'square',peak:.02,attack:.012});
 if(s%2===1){const arp=MUSIC_ARP[sec];audioBeep(arp[Math.floor(s/2)%arp.length],t,.08,{type:'triangle',peak:.008});}
 if(s%4===0){const bass=MUSIC_BASS[sec][Math.floor(s/4)];audioBeep(bass,t,.3,{type:'triangle',peak:.028});}
 if(s%2===0)audioNoise(t,.02,{peak:.006,hp:4200});
 if(s%8===0)audioBeep(120,t,.09,{type:'triangle',peak:.035,to:60});
 if(s===8||s===24)audioNoise(t,.05,{peak:.016,hp:1500});
}
function musicStart(){
 if(musicTimer||!musicReady())return;
 musicStep=0;musicNext=audio.currentTime+.06;
 const tick=()=>{
  if(!musicReady()||!run||run.paused||run.done||run.over||view!=='mario'||!dialog.open){musicStop();return;}
  while(musicNext<audio.currentTime+.35){musicScheduleStep(musicStep,musicNext);musicStep=(musicStep+1)%(32*MUSIC_ORDER.length);musicNext+=MUSIC_STEP;}
 };
 tick();musicTimer=setInterval(tick,60);
}
function musicStop(){if(musicTimer)clearInterval(musicTimer);musicTimer=0;}
function stopRun(){musicStop();if(raf)cancelAnimationFrame(raf);raf=0;lastFrame=0;keys.clear();pointers.clear();if(run)run.paused=true;stopDino();}
function stopDino(){if(dinoRaf)cancelAnimationFrame(dinoRaf);dinoRaf=0;dinoLast=0;if(dinoResizeObs){try{dinoResizeObs.disconnect();}catch(e){}dinoResizeObs=null;}}
function close(){stopRun();clearInterval(slotTimer);slotTimer=null;stopMatrixIdle();speechSynthesisSafeCancel();hideJackpot();if(dialog.open)dialog.close();}
dialog.addEventListener('close',()=>{stopRun();clearInterval(slotTimer);slotTimer=null;stopMatrixIdle();speechSynthesisSafeCancel();});
function open(next='home'){if(!A.visible())return;unlockSound();hideInvite();if((next==='mario'&&!A.available('mario'))||(next==='slot'&&!A.available('slot'))||(next==='dino'&&!A.available('dino')))next='home';if(view!==next)stopRun();view=next;viewStamp='';dialogOwner=currentUid;if(!dialog.open)dialog.showModal();render(true);}
entry.onclick=()=>open();
function render(force=false){
 if(!dialog.open)return;if(dialogOwner!==currentUid||!A.visible()||!A.available()||(view==='slot'&&!A.available('slot'))||(view==='mario'&&!A.available('mario'))||(view==='dino'&&!A.available('dino'))){close();return;}
 const status=A.status(),player=A.me(),today=player.daily?.day===C.dayKey()?player.daily.claims.length:0;
 const stamp=JSON.stringify([view,rankMode,sound,slotBusy,slotMessage,slotSymbols,status.ready,status.error,A.head().gameRound,unlocked(),view==='ranking'?Object.values(A.players()).map(p=>[p.uid,p._round]):null,view==='ranking'?A.recent().map(r=>r.id):null]);
 if(!force&&stamp===viewStamp){updateNumbers();return;}
 if(view==='mario'&&run&&!force&&dialog.querySelector('#mario-canvas')){updateNumbers();return;}viewStamp=stamp;
 if(view==='dino'&&dinoRun&&!dinoRun.over&&!force&&dialog.querySelector('#dino-canvas')){updateNumbers();return;}
 // UI-1: игры запускаются только с домашнего экрана «Игры»; вкладок две; автомат открывается полноэкранным.
 dialog.classList.toggle('slot-fullscreen',view==='slot');
 dialog.innerHTML='<div class="arcade-head"><h2 id="arcade-title">🎮 Дорожная аркада</h2><button class="arcade-close" aria-label="'+(view==='slot'?'Выйти из автомата':'Закрыть мини-игры')+'">'+(view==='slot'?'Выйти':'×')+'</button></div>'
 +'<div class="arcade-tabs"><button data-view="home" aria-pressed="'+(view==='home')+'">Игры</button><button data-view="ranking" aria-pressed="'+(view==='ranking')+'">Выигрыши</button></div>'
 +'<div class="arcade-balance"><span>Кошелёк <b data-arcade-balance>'+f(A.balance())+'</b> 🪙</span><span>Монеты Марио — в кошелёк в конце уровня</span></div><p class="arcade-note">Только виртуальные монеты приложения. Игры не меняют рабочий рейтинг.</p><div class="arcade-status" id="arcade-status" role="status">'+E(status.error||(!status.ready?'Синхронизируем игровой банк…':notice))+'</div><div id="arcade-content"></div>';
 dialog.querySelector('.arcade-close').onclick=close;dialog.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>open(b.dataset.view));
 const host=dialog.querySelector('#arcade-content');
 if(view==='home'){
  host.innerHTML='<div class="arcade-hub">'+(A.available()?'':'<section class="arcade-game-card"><div class="game-emoji">🎮</div><h3>Игры ждут смены</h3><p class="arcade-note">Мини-игры открываются, когда на линии начата смена: игра идёт во время рабочей смены. Начните смену — и кнопки Марио и автомата появятся здесь.</p></section>')+(A.available('mario')?'<section class="arcade-game-card"><div class="game-emoji">🍄 🚧</div><h3>Марио: дорожное приключение</h3><p class="arcade-note">20 уровней: блоки «?» с монетами, враги, трубы и флажок. Каждый враг и монета — в кошелёк, в конце уровня ещё бонус за высоту прыжка. Дневного лимита нет.</p><button class="arcade-start" data-launch="mario">Играть</button></section>':'')+(A.available('slot')?'<section class="arcade-game-card">'+mascot()+'<h3>Однорукий бандит</h3><p class="arcade-note">Ставка 10 монет. Частые небольшие выплаты и редкий общий джекпот. Выигрыш не гарантирован.</p><button class="arcade-start" data-launch="slot">К автомату</button></section>':'')+(A.available('dino')?'<section class="arcade-game-card"><div class="game-emoji">🦖 🌵</div><h3>Дино-бегун</h3><p class="arcade-note">Как офлайн-игра в Chrome: динозаврик бежит, перепрыгивает кактусы, птицы летят навстречу, скорость растёт. По пути монетки — в кошелёк в конце заезда. Тап по экрану или пробел — прыжок, вниз — пригнуться.</p><button class="arcade-start" data-launch="dino">Играть</button></section>':'')+'</div>';
  host.querySelectorAll('[data-launch]').forEach(b=>b.onclick=()=>open(b.dataset.launch));
 }else if(view==='slot')renderSlot(host);else if(view==='ranking')renderRanking(host);else if(view==='dino')renderDino(host);else renderMario(host);
 updateNumbers();
}
function updateNumbers(){
 const p=A.me(),today=p.daily?.day===C.dayKey()?p.daily.claims.length:0;
 dialog.querySelectorAll('[data-arcade-balance]').forEach(e=>e.textContent=f(A.balance()));dialog.querySelectorAll('[data-mario-daily]').forEach(e=>e.textContent=today);
 dialog.querySelectorAll('[data-slot-bank]').forEach(e=>e.textContent=f(A.head().bank));dialog.querySelectorAll('[data-slot-stakes]').forEach(e=>e.textContent=f(A.head().totalStakes));dialog.querySelectorAll('[data-slot-payouts]').forEach(e=>e.textContent=f(A.head().totalPayouts));
 // Кнопка не должна молча не реагировать: блокируем её только на время вращения,
 // а любую причину отказа объясняем текстом в spin().
 const spin=dialog.querySelector('#slot-spin');if(spin)spin.disabled=slotBusy;
 if(view==='mario'&&run){const el=dialog.querySelector('[data-mario-lives]');if(el)el.innerHTML=hearts(run.lives);const level=dialog.querySelector('[data-mario-level]');if(level)level.textContent=run.map.level;const coins=dialog.querySelector('[data-mario-coins]');if(coins)coins.textContent=run.coins;const score=dialog.querySelector('[data-mario-score]');if(score)score.textContent=run.score;}
 if(view==='dino'&&dinoRun){const coins=dialog.querySelector('[data-dino-coins]');if(coins)coins.textContent=dinoRun.collected;const score=dialog.querySelector('[data-dino-score]');if(score)score.textContent=dinoRun.score;}
}
// Настоящие барабаны: полоса символов прокручивается вертикально с размытием
// на скорости и поочерёдной остановкой с отскоком (ease-out-back).
const REEL_ICONS=['🍒','⭐','💎','🚧','👑','🔔','🍋','7️⃣'];
let reelAnim=null,matrixTimer=null,matrixPhase=0,matrixText='JACKPOT',matrixTint='#ffd166',matrixFlashTimer=0;
function reelCellHeight(){const s=dialog.querySelector('.slot-strip span');return s?s.getBoundingClientRect().height||105:105;}
const bulbs=count=>{let out='';for(let i=0;i<count;i++)out+='<i style="animation-delay:'+(i*.075).toFixed(2)+'s"></i>';return out;};
// Точечное табло в стиле 90-х: буквы «набираются» круглыми лампочками.
function paintDotMatrix(canvas,text,color,phase){if(!canvas||typeof canvas.getContext!=='function')return;const g=canvas.getContext('2d');if(!g||typeof g.getImageData!=='function')return;const W=canvas.width||360,H=canvas.height||84;g.clearRect(0,0,W,H);
 try{
 const off=document.createElement('canvas');off.width=W;off.height=H;const og=off.getContext&&off.getContext('2d');if(!og||typeof og.measureText!=='function')return;og.fillStyle='#fff';og.textAlign='center';og.textBaseline='middle';
 let size=Math.round(H*.62);const font=()=>'900 '+size+'px Arial,Helvetica,sans-serif';og.font=font();
 while(size>8&&og.measureText(text).width>W*.9){size-=2;og.font=font();}
 og.fillText(text,W/2,H/2+1);
 const img=og.getImageData(0,0,W,H);if(!img||!img.data)return;const data=img.data,step=5,r=1.85;
 for(let y=3;y<H;y+=step)for(let x=3;x<W;x+=step){const a=data[(y*W+x)*4+3];g.beginPath();g.arc(x,y,a>110?r:r*.62,0,Math.PI*2);
  if(a>110){g.fillStyle=color;g.globalAlpha=.55+.4*(.5+.5*Math.sin(x*.35+y*.5+phase));}else{g.fillStyle='#241019';g.globalAlpha=.5;}g.fill();}
 g.globalAlpha=1;
 }catch(e){}}
function paintMatrix(){paintDotMatrix(dialog.querySelector('#slot-matrix'),matrixText,matrixTint,matrixPhase);}
function startMatrixIdle(){stopMatrixIdle();const c=dialog.querySelector('#slot-matrix');if(!c)return;matrixText='JACKPOT';matrixTint='#ffd166';paintMatrix();matrixTimer=setInterval(()=>{matrixPhase+=.55;paintMatrix();},110);}
function stopMatrixIdle(){if(matrixTimer)clearInterval(matrixTimer);matrixTimer=null;clearTimeout(matrixFlashTimer);}
function matrixFlash(text,color,ms){if(!dialog.querySelector('#slot-matrix'))return;matrixText=text;matrixTint=color||'#8ef2a8';paintMatrix();clearTimeout(matrixFlashTimer);matrixFlashTimer=setTimeout(()=>{matrixText='JACKPOT';matrixTint='#ffd166';paintMatrix();},ms||2600);}
function coinRain(host){let out='';for(let i=0;i<26;i++){out+='<i style="left:'+Math.round(Math.random()*100)+'%;animation-delay:'+(Math.random()*1.2).toFixed(2)+'s;animation-duration:'+(1.1+Math.random()*1.1).toFixed(2)+'s;font-size:'+(12+Math.round(Math.random()*12))+'px">🪙</i>';}host.innerHTML=out;}
let jackpotTimer=0;
function showJackpot(payout){if(!dialog.open)return;const el=dialog.querySelector('#slot-jackpot');if(!el)return;const sum=el.querySelector('[data-jackpot-sum]');if(sum)sum.textContent=f(payout);const rain=el.querySelector('.slot-coin-rain');if(rain)coinRain(rain);el.hidden=false;el.classList.add('show');const m=el.querySelector('#slot-jackpot-matrix');let phase=0;paintDotMatrix(m,'JACKPOT','#ffe08a',0);clearInterval(jackpotTimer);jackpotTimer=setInterval(()=>{phase+=.8;paintDotMatrix(m,'JACKPOT','#ffe08a',phase);},110);clearTimeout(el._hideTimer);el._hideTimer=setTimeout(()=>hideJackpot(),9000);}
function hideJackpot(){const el=dialog.querySelector('#slot-jackpot');if(!el)return;el.hidden=true;el.classList.remove('show');clearInterval(jackpotTimer);jackpotTimer=0;clearTimeout(el._hideTimer);dialog.querySelector('.slot-shell')?.classList.remove('jackpot');}
function applyReelTransforms(){if(!reelAnim)return;const n=REEL_ICONS.length,cell=reelCellHeight();dialog.querySelectorAll('.slot-reel').forEach((reel,i)=>{const st=reelAnim.reels[i];if(!st)return;const pmod=((st.p%n)+n)%n;const strip=reel.querySelector('.slot-strip');if(strip)strip.style.transform='translateY('+(-(3*n+pmod)*cell)+'px)';});}
// Тик анимации: requestAnimationFrame, а если он не тикает (скрытая вкладка,
// headless), через 150 мс подключается setInterval-тик — тогда spin() никогда
// не зависает и барабаны всё равно доигрывают до остановки.
function startReelSpin(){
 if(matchMedia('(prefers-reduced-motion: reduce)').matches)return null;
 const t0=performance.now();let last=t0,lastTick=0,rafId=0,intervalId=0,rafSeen=0;
 const anim={active:true,p:0,reels:[0,1,2].map(()=>({p:0,landing:false,stopped:false,landT:0,land0:0,landD:0})),symbols:null,targets:null,resolve:null,cancel(){this.active=false;clearInterval(intervalId);}};
 const done=new Promise(r=>anim.resolve=r);
 const step=now=>{
  if(!anim.active){cancelAnimationFrame(rafId);return;}
  rafSeen++;
  const dt=Math.min(.05,((now||performance.now())-last)/1000);last=now||performance.now();const t=(now||performance.now())-t0;let allDone=true,expired=t>8000;
  dialog.querySelectorAll('.slot-reel').forEach((reel,i)=>{const st=anim.reels[i];const prev=st.p;
   if(st.landing){const u=Math.min(1,(t-st.landT)/650),k=1.3,e=1+(k+1)*Math.pow(u-1,3)+k*Math.pow(u-1,2);st.p=st.land0+st.landD*e;reel.classList.toggle('blur',u<.55);if(u>=1){st.p=st.land0+st.landD;reel.classList.remove('blur');if(!st.stopped){st.stopped=true;tone('reelstop');}}else allDone=false;}
   else{st.p+=20*dt;reel.classList.add('blur');allDone=false;
    if(anim.targets&&t>=950+i*480){const n=REEL_ICONS.length,target=anim.targets[i]||0;const cur=((st.p%n)+n)%n;st.landing=true;st.landT=t;st.land0=st.p;st.landD=((target-cur)%n+n)%n+n;}}
   if(t-lastTick>85&&Math.floor(st.p)!==Math.floor(prev)){lastTick=t;tone('spin');}
  });
  applyReelTransforms();
  if(allDone||expired){anim.active=false;clearInterval(intervalId);if(anim.symbols)slotSymbols=anim.symbols.slice();anim.resolve();return;}
  rafId=requestAnimationFrame(step);};
 rafId=requestAnimationFrame(step);
 intervalId=setInterval(()=>{if(anim.active&&rafSeen<2)step(0);else{clearInterval(intervalId);intervalId=0;}},33);
 reelAnim=anim;return done;
}
function renderSlot(host){const strip=icons=>{let cells='';for(let r=0;r<5;r++)for(const s of icons)cells+='<span>'+s+'</span>';return cells;};
 // Окошко (.slot-reel) — фиксированная высота и overflow:hidden: длинная полоса
 // барабана крутится внутри корпуса, снаружи виден только средний символ.
 const reel=(sym,i)=>'<div class="slot-reel" data-reel="'+i+'"'+(slotBusy?'':' data-final="'+E(sym)+'"')+'><div class="slot-strip">'+(slotBusy?strip(REEL_ICONS):'<span>'+E(sym)+'</span>')+'</div></div>';
 host.innerHTML='<section class="slot-shell '+(slotBusy?'spinning':'')+'"><div class="slot-bulbs slot-bulbs-top" aria-hidden="true">'+bulbs(14)+'</div>'
  +'<div class="slot-pot"><canvas id="slot-matrix" width="360" height="84" aria-label="Табло джекпота"></canvas><span class="slot-pot-label">ОБЩИЙ ДЖЕКПОТ</span><strong><span data-slot-bank>'+f(A.head().bank)+'</span> 🪙</strong></div>'
  +mascot()+'<div class="slot-reels" aria-label="Результат барабанов">'+slotSymbols.map((s,i)=>reel(s,i)).join('')+'</div><div class="slot-result" id="slot-result" role="status">'+E(slotMessage||'Стартовый банк — 1 000 монет. Испытаем удачу?')+'</div><button class="slot-spin" id="slot-spin">'+(slotBusy?'Барабаны вращаются…':A.readSpin()?'Проверить незавершённое вращение':'Вращать · 10 🪙')+'</button><div class="slot-bank-details"><span>Внесено игроками: <b data-slot-stakes>'+f(A.head().totalStakes)+'</b></span><span>Выплачено: <b data-slot-payouts>'+f(A.head().totalPayouts)+'</b></span></div>'
  +'<div class="slot-bulbs slot-bulbs-bottom" aria-hidden="true">'+bulbs(14)+'</div>'
  +'<div class="slot-jackpot" id="slot-jackpot" hidden><div class="slot-jackpot-inner"><canvas id="slot-jackpot-matrix" width="420" height="120" aria-label="Джекпот"></canvas><p class="slot-jackpot-sum">+<b data-jackpot-sum>0</b> 🪙</p><p class="slot-jackpot-note">Общий банк автомата теперь ваш. Поздравляем!</p><button type="button" id="slot-jackpot-close">Забрать выигрыш</button><div class="slot-coin-rain" aria-hidden="true"></div></div></div>'
  +'</section><details class="arcade-rules"><summary>Честные правила и шансы</summary><p>Каждое вращение независимо. 34% — выплата 15 монет, 8% — 30 монет, 1,49% — 150 монет, 0,01% (1 из 10 000) — весь текущий банк. В остальных 56,5% выплата равна нулю. Ставка — 10 монет. Выплата ограничена деньгами в банке после добавления ставки.</p><p>Банк общий: 1 000 стартовых монет + все ставки − все выплаты. Он не пополняется заново при обновлении страницы. Уменьшение кошелька и итог игры видны отдельно. Реальных денег и вывода средств нет.</p></details>';
 host.querySelector('#slot-spin').onclick=spin;
 host.querySelector('#slot-jackpot-close')?.addEventListener('click',hideJackpot);
 startMatrixIdle();
}
async function spin(){
 if(slotBusy)return;unlockSound();const user=currentUid,token=dialogOwner;let operation=A.readSpin();
 // Незавершённое вращение проверяем всегда: это возврат долга, а не новая ставка.
 if(!operation&&!A.available('slot')){setStatus('Автомат открывается, когда на линии начата смена. Незавершённое вращение проверится автоматически.');return;}
 if(!operation&&!A.status().ready){setStatus('Игровой банк ещё синхронизируется. Незавершённое вращение проверится автоматически.');return;}
 if(!operation&&A.balance()<C.BET){setStatus('Для вращения нужно 10 монет. Их можно собрать в Марио.');return;}
 try{if(!operation){operation=A.newSpin();A.storeSpin(operation);}}catch(e){slotMessage=e.message;render(true);return;}
 slotBusy=true;slotMessage='Проверяем ставку и вращаем барабаны…';render(true);const started=performance.now();
   tone('lever');
   const spinDonePromise=startReelSpin();
   let lastFlip=0;if(!spinDonePromise)tone('spin');
   let outcomeType='',outcomePayout=0,outcomeCost=C.BET,outcomeProfit=0;
   try{
    // Итоговые символы зависят только от заранее сохранённого броска, поэтому
    // барабаны останавливаются на выпавшем результате, но деньги ещё не двигаются.
    const shown=C.slotOutcome(operation.roll,Number(A.head()?.bank)||0).symbols;
    slotSymbols=shown.slice();
    if(reelAnim&&reelAnim.active){
     reelAnim.symbols=slotSymbols.slice();
     // Целевая позиция каждого барабана — индекс выпавшего символа в REEL_ICONS.
     reelAnim.targets=slotSymbols.map(s=>{let best=0,bd=1e9;REEL_ICONS.forEach((icon,idx)=>{const d=icon===s?0:(icon.replace('️','')===s.replace('️','')?1:1e9);if(d<bd){bd=d;best=idx;}});return best;});
     // Не короче 1.7 с от нажатия, но дожидаемся полной остановки всех барабанов.
     // Страховка 6.5 с: в скрытой вкладке requestAnimationFrame не тикает, и без
     // таймаута кнопка осталась бы в «Барабаны вращаются…» навсегда.
     const minDelay=new Promise(r=>setTimeout(r,Math.max(0,1700-(performance.now()-started))));
     await Promise.race([Promise.all([spinDonePromise,minDelay]),new Promise(r=>setTimeout(r,6500))]);
    }else await new Promise(resolve=>setTimeout(resolve,Math.max(0,1700-(performance.now()-started))));
    if(currentUid!==user)return;
    // Ставка и выплата записываются ОДНОЙ серверной операцией только теперь —
    // после остановки барабанов. Повтор той же операции сервер не задваивает.
    const result=await A.transact(operation);if(currentUid!==user)return;A.storeSpin(null);if(!result.replayed&&result.payout>=result.cost)window.__gameMoneyFlow?.(-result.cost);
    slotSymbols=result.result?.symbols||slotSymbols;
    outcomeType=result.result?.type||'';outcomePayout=Number(result.payout)||0;outcomeCost=Number(result.cost)||C.BET;outcomeProfit=outcomePayout-outcomeCost;
    const profit=outcomeProfit;
    slotMessage=outcomeType==='jackpot'?'ДЖЕКПОТ! Выплата '+f(outcomePayout)+' 🪙 · общий банк ваш':profit>0?'Выплата '+f(outcomePayout)+' 🪙 · выигрыш за вычетом ставки +'+f(profit):profit===0?'Вернулась ставка: '+f(outcomePayout)+' 🪙. Итог 0.':'Выплата '+f(outcomePayout)+' 🪙 · итог −'+f(-profit);
   }catch(e){if(currentUid===user){outcomeType='';slotMessage=(e.message||'Нет связи')+' Ставка не списана. Нажмите «Вращать» ещё раз — повтор не задвоит монеты.';}}
   finally{if(reelAnim){reelAnim.cancel();reelAnim=null;}clearInterval(slotTimer);slotTimer=null;slotBusy=false;
    if(currentUid===user&&dialog.open&&view==='slot'){
     render(true);const shell=dialog.querySelector('.slot-shell');
     if(outcomeType==='jackpot'){shell?.classList.add('winner','jackpot');showJackpot(outcomePayout);tone('jackpot');speak('Джекпот! Поздравляем!');}
     else if(outcomeProfit>0){shell?.classList.add('winner');matrixFlash(outcomeType==='big'?'КРУПНЫЙ ВЫИГРЫШ':'ВЫИГРЫШ',outcomeType==='big'?'#9be7ff':'#8ef2a8');tone(outcomeType==='big'?'win':'coin');speak('Выигрыш '+outcomeProfit+' монет.');}
     else if(outcomeType)tone('hurt');
    }}
  }
// ── «Дино-бегун»: как офлайн-игра в Chrome ───────────────────────────────
function renderDino(host){
 const playing=dinoRun&&!dinoRun.over;
 const bestKey=prefKey()+':dino-best',best=Number(localStorage.getItem(bestKey)||0);
 host.innerHTML='<div class="dino-wrap"><div class="dino-hud"><span>🪙 <b data-dino-coins>'+(dinoRun?.collected||0)+'</b></span><span>⭐ <b data-dino-score>'+(dinoRun?.score||0)+'</b></span><span>Рекорд: <b>'+f(best)+'</b></span></div>'
 +'<div class="dino-field" id="dino-field">'
 +'<canvas id="dino-canvas" aria-label="Дино-бегун: тап или пробел — прыжок, вниз — пригнуться"></canvas>'
 +'<button type="button" class="dino-fab" id="dino-fab" aria-label="Кнопка прыжка: короткое нажатие — прыжок, можно перетащить в удобное место">⤒</button>'
 +'</div>'
 +(playing?'':'<div class="dino-actions"><button type="button" id="dino-start">'+(dinoRun?'Играть снова':'Начать заезд')+'</button></div><p class="arcade-note">Прыжок — тап в любом месте экрана или клавиша пробел/↑. Пригнуться под птицей — ↓ или свайп вниз. Круглую кнопку-пружок можно перетащить в удобное место. Скорость растёт со временем. Собранные монетки зачисляются в кошелёк одним платежом по итогам завершённого заезда (game over); повторная отправка итога не задваивает начисление.</p>')
 +'</div>';
 const field=host.querySelector('#dino-field');
 const canvas=host.querySelector('#dino-canvas');
 const start=host.querySelector('#dino-start');
 if(start)start.onclick=startDino;
 if(field&&canvas){
  dinoFitCanvas(canvas);
  // Отзывчивый ресайз: внутреннее разрешение canvas пересчитывается под
  // фактический размер контейнера (с devicePixelRatio), без «резины».
  try{
   if(dinoResizeObs)dinoResizeObs.disconnect();
   if(typeof ResizeObserver==='function'){
    dinoResizeObs=new ResizeObserver(()=>{dinoFitCanvas(canvas);if(dinoRun&&!dinoRun.over)drawDino();else drawDinoIdle(canvas,best);});
    dinoResizeObs.observe(field);
   }
  }catch(e){dinoResizeObs=null;}
  // Управление: тап по ЛЮБОМУ месту игрового поля — прыжок; удержание — выше;
  // вниз (клавиша/свайп) — пригнуться. Тап по оверлею game over — новый заезд.
  let duckPointer=null,downY=0;
  field.onpointerdown=e=>{
   if(e.target.closest('button'))return; // кнопки (FAB) сами разбирают нажатия
   e.preventDefault();
   if(!dinoRun||dinoRun.over){startDino();return;}
   unlockSound();field.setPointerCapture?.(e.pointerId);
   downY=e.clientY;duckPointer=e.pointerId;dinoInput.jump=true;
  };
  field.onpointermove=e=>{if(duckPointer!==e.pointerId||!dinoInput.jump)return;if(e.clientY-downY>28){dinoInput.jump=false;dinoInput.duck=true;}};
  const up=e=>{if(duckPointer!==e.pointerId)return;duckPointer=null;dinoInput.jump=false;dinoInput.duck=false;};
  field.onpointerup=up;field.onpointercancel=up;
  field.addEventListener('contextmenu',e=>e.preventDefault());
  setupDinoFab(host,field);
 }
 if(!playing)drawDinoIdle(canvas,best);else startDinoLoop();
}
// ── Плавающая кнопка-пружок: перетаскивается, позиция — в долях поля ─────
function dinoFabKey(){return prefKey()+':dino-fab-pos';}
function loadDinoFabPos(){
 try{const p=JSON.parse(localStorage.getItem(dinoFabKey())||'null');
  if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y))return {x:Math.max(0,Math.min(1,p.x)),y:Math.max(0,Math.min(1,p.y))};
 }catch(e){}
 return null; // дефолт — правый нижний угол игрового поля
}
function saveDinoFabPos(p){try{localStorage.setItem(dinoFabKey(),JSON.stringify({x:+p.x.toFixed(4),y:+p.y.toFixed(4)}));}catch(e){}}
function clampDinoFab(fab,field){
 const fw=field.clientWidth||300,fh=field.clientHeight||160,s=fab.offsetWidth||64;
 const x=Math.max(6,Math.min(fw-s-6,parseFloat(fab.style.left||'9999'))),y=Math.max(6,Math.min(fh-s-6,parseFloat(fab.style.top||'9999')));
 fab.style.left=x+'px';fab.style.top=y+'px';
}
function setupDinoFab(host,field){
 const fab=host.querySelector('#dino-fab');if(!fab)return;
 const place=p=>{ // p — доли ширины/высоты поля; дефолт — правый нижний угол
  const fw=field.clientWidth||300,fh=field.clientHeight||160,s=fab.offsetWidth||64;
  const x=p?p.x*(fw-s):fw-s-12,y=p?p.y*(fh-s):fh-s-12;
  fab.style.left=x+'px';fab.style.top=y+'px';
 };
 place(loadDinoFabPos());
 let pid=null,sx=0,sy=0,ox=0,oy=0,dragged=false;
 fab.addEventListener('pointerdown',e=>{
  e.preventDefault();e.stopPropagation(); // тап по кнопке не должен прыгать дважды
  pid=e.pointerId;dragged=false;sx=e.clientX;sy=e.clientY;
  ox=parseFloat(fab.style.left||'0');oy=parseFloat(fab.style.top||'0');
  fab.classList.add('dragging');fab.setPointerCapture?.(pid);
 });
 fab.addEventListener('pointermove',e=>{
  if(pid!==e.pointerId)return;e.preventDefault();e.stopPropagation();
  const dx=e.clientX-sx,dy=e.clientY-sy;
  if(!dragged&&Math.hypot(dx,dy)>8){dragged=true;dinoInput.jump=false;} // перетаскивание ≠ прыжок
  if(dragged){fab.style.left=(ox+dx)+'px';fab.style.top=(oy+dy)+'px';clampDinoFab(fab,field);}
 });
 const done=e=>{
  if(pid!==e.pointerId)return;pid=null;fab.classList.remove('dragging');
  if(dragged){ // фиксируем позицию в долях поля — переживает ресайз
   const fw=field.clientWidth||300,fh=field.clientHeight||160,s=fab.offsetWidth||64;
   clampDinoFab(fab,field);
   saveDinoFabPos({x:(parseFloat(fab.style.left)/(fw-s)),y:(parseFloat(fab.style.top)/(fh-s))});
  }else{ // короткий тап — прыжок
   if(!dinoRun||dinoRun.over)startDino();
   else{unlockSound();dinoInput.jump=true;setTimeout(()=>{if(!pid)dinoInput.jump=false;},180);}
  }
 };
 fab.addEventListener('pointerup',done);
 fab.addEventListener('pointercancel',done);
 fab.addEventListener('contextmenu',e=>e.preventDefault());
}
const dinoInput={jump:false,duck:false};
const dinoKeyMap={Space:'jump',ArrowUp:'jump',ArrowDown:'duck',KeyW:'jump',KeyS:'duck'};
document.addEventListener('keydown',e=>{if(!dialog.open||view!=='dino'||/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))return;const k=dinoKeyMap[e.code];if(k){e.preventDefault();dinoInput[k]=true;unlockSound();if(!dinoRun||dinoRun.over)startDino();}});
document.addEventListener('keyup',e=>{const k=dinoKeyMap[e.code];if(k)dinoInput[k]=false;});
function startDino(){if(!A.available('dino')||dinoBusy)return;stopDino();unlockSound();dinoRun=C.createDinoRun();dinoBestShown=false;dinoCoinFx.length=0;notice='';render(true);startDinoLoop();}
function startDinoLoop(){if(!dinoRaf&&dialog.open&&view==='dino'&&dinoRun&&!dinoRun.over)dinoRaf=requestAnimationFrame(tickDino);}
function tickDino(now){
 dinoRaf=0;if(!dinoRun||!dialog.open||view!=='dino'||!A.available('dino'))return;
 if(document.hidden){drawDino();startDinoLoop();return;}
 if(!dinoLast)dinoLast=now;const dt=(now-dinoLast)/1000;dinoLast=now;
 C.advanceDinoRun(dinoRun,{jump:dinoInput.jump,duck:dinoInput.duck},dt,onDinoEvent);
 for(const fx of dinoCoinFx){fx.t+=dt;fx.y+=fx.vy*dt;fx.vy+=900*dt;}
 if(dinoCoinFx.length)dinoCoinFx=dinoCoinFx.filter(fx=>fx.t<fx.life);
 drawDino();updateNumbers();
 startDinoLoop();
}
function onDinoEvent(event){
 if(event.type==='jump'){tone('jump');return;}
 if(event.type==='land'){tone('land');return;}
 if(event.type==='coin'){tone('coin');dinoCoinFx.push({x:70,y:80,vy:-230,t:0,life:.7});return;}
 if(event.type==='gameover'){tone('gameover');stopDino();void creditDino(event);return;}
}
// Монеты — ТОЛЬКО по факту завершённого заезда, одной серверной операцией с
// уникальным requestId (id заезда). Повтор того же id сервер не задваивает.
async function creditDino(event){
 const session=dinoRun;if(!session||dinoBusy)return;
 dinoBusy=true;const user=currentUid,bestKey=prefKey()+':dino-best';
 const isRecord=event.score>Number(localStorage.getItem(bestKey)||0);
 if(isRecord){try{localStorage.setItem(bestKey,String(event.score));}catch(e){}}
 setStatus('Заезд окончен: очки '+f(event.score)+'. Сохраняем монеты…');
 try{
  // Сервер принимает итог заезда максимум с 99 монетами (антидублирование
  // и лимиты кошелька), поэтому пересылаем собранное с ограничением.
  const coins=Math.max(0,Math.min(99,event.coins|0));
  const result=await A.transact({id:'dino_'+session.startedAt+'_'+session.runId,kind:'dino',coins,score:event.score});
  if(currentUid!==user)return;
  tone('coin');
  setStatus((result.replayed?'Итог заезда уже был учтён. ':'')+'Зачислено в кошелёк: '+(Number(result.payout)||0)+' 🪙'+(isRecord?' · НОВЫЙ РЕКОРД!':''));
 }catch(e){if(currentUid===user)setStatus('Монеты пока не зачислены: '+(e.message||'нет связи')+'. Итог можно безопасно повторить — двойного начисления не будет.');}
 finally{dinoBusy=false;if(dinoRun===session)render(true);}
}
// Внутреннее разрешение canvas — под фактический размер контейнера, с
// devicePixelRatio. Мир игры остаётся в логических координатах 1000x210,
// а отрисовка масштабируется контекстом (scale) — физика в core не меняется.
const DINO_WORLD={W:1000,H:210};
function dinoFitCanvas(canvas){
 try{
  const rect=canvas.parentElement?.getBoundingClientRect();
  const w=Math.max(120,Math.round(rect?.width||canvas.clientWidth||600));
  const h=Math.max(90,Math.round(rect?.height||canvas.clientHeight||220));
  const dpr=Math.max(1,Math.min(3,(window.devicePixelRatio||1)));
  const pw=Math.round(w*dpr),ph=Math.round(h*dpr);
  if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;}
 }catch(e){}
}
// Общий вход в рисование: пересчёт разрешения + масштаб мира под фактический
// canvas. Любая ошибка (нет 2d-контекста, самодельный DOM в смоук-тестах)
// глушится — игра не должна падать из-за рисования.
function dinoDrawWorld(canvas,painter){
 if(!canvas)return;
 dinoFitCanvas(canvas);
 try{
  const g=canvas.getContext&&canvas.getContext('2d');if(!g||typeof g.fillRect!=='function')return;
  const cw=canvas.width||600,ch=canvas.height||200;
  const scale=Math.min(cw/DINO_WORLD.W,ch/DINO_WORLD.H);
  g.setTransform(1,0,0,1,0,0);
  g.clearRect(0,0,cw,ch);
  g.save();
  g.translate((cw-DINO_WORLD.W*scale)/2,(ch-DINO_WORLD.H*scale)/2);
  g.scale(scale,scale);
  g.beginPath();g.rect(0,0,DINO_WORLD.W,DINO_WORLD.H);g.clip();
  painter(g,scale);
  g.restore();
 }catch(e){}
}
// roundRect с fallback на обычный path для старых движков/заглушек.
function dinoRoundRect(g,x,y,w,h,r){
 try{
  if(typeof g.roundRect==='function'){g.beginPath();g.roundRect(x,y,w,h,r);return;}
 }catch(e){}
 r=Math.min(r,w/2,h/2);g.beginPath();
 g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);
 g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath();
}
function drawDinoIdle(canvas,best){
 dinoDrawWorld(canvas,g=>{
  drawDinoSky(g,0);
  g.textAlign='center';g.textBaseline='middle';
  g.fillStyle='#20456b';g.font='900 30px Arial Black,Arial,sans-serif';
  g.fillText('ДИНО-БЕГУН',500,58);
  g.fillStyle='#3a6b96';g.font='bold 15px Arial,sans-serif';
  g.fillText('Прыжок — тап по экрану или пробел · пригнуться — ↓ или свайп вниз',500,92);
  g.fillStyle='#7ba7c9';g.font='bold 14px Arial,sans-serif';
  g.fillText('Рекорд: '+f(best||0),500,118);
  drawDinoPlayer(g,{dino:{y:0,ducking:false,grounded:true},speed:0},(typeof performance!=='undefined'&&performance.now?performance.now()/1000:0));
 });
}
// Мягкий градиент неба + далёкие холмы и облака — фон прокручивается со скоростью мира.
function drawDinoSky(g,t){
 const sky=g.createLinearGradient?g.createLinearGradient(0,0,0,210):null;
 if(sky){sky.addColorStop(0,'#bfe6f7');sky.addColorStop(.7,'#e8f6fd');sky.addColorStop(1,'#f6fbf4');g.fillStyle=sky;}else g.fillStyle='#dff2fb';
 g.fillRect(0,0,1000,210);
 // облака (два слоя параллакса)
 g.fillStyle='#ffffffb8';
 for(let i=0;i<4;i++){const x=((i*300-t*.25)%1200+1200)%1200-100;g.beginPath();g.arc(x,42+(i%2)*16,16,0,Math.PI*2);g.arc(x+20,36+(i%2)*16,20,0,Math.PI*2);g.arc(x+42,44+(i%2)*16,14,0,Math.PI*2);g.fill();}
 // холмы
 const hill=g.createLinearGradient?g.createLinearGradient(0,90,0,152):null;
 if(hill){hill.addColorStop(0,'#bfe3b2');hill.addColorStop(1,'#9ed18d');g.fillStyle=hill;}else g.fillStyle='#bfe3b2';
 for(let i=0;i<5;i++){const x=((i*260-t*.5)%1300+1300)%1300-150;g.beginPath();g.arc(x,176,46,Math.PI,0);g.fill();}
 // земля
 const ground=g.createLinearGradient?g.createLinearGradient(0,150,0,210):null;
 if(ground){ground.addColorStop(0,'#e7d9a8');ground.addColorStop(1,'#cdb87e');g.fillStyle=ground;}else g.fillStyle='#e0d09e';
 g.fillRect(0,150,1000,60);
 g.strokeStyle='#8f7a4d';g.lineWidth=2;g.beginPath();g.moveTo(0,151);g.lineTo(1000,151);g.stroke();
 g.fillStyle='#b9a36b';
 for(let i=0;i<10;i++){const x=((i*137-t*0.9)%1060+1060)%1060-30;dinoRoundRect(g,x,160+(i%3)*14,12,3,2);g.fill();}
}
function drawDinoGround(g,t){drawDinoSky(g,t);}
// Детализированный динозавр: тело с объёмным градиентом, гребень, хвост,
// голова с глазом/ноздрей/пастью, фазы бега и позы прыжка/пригибания.
function drawDinoPlayer(g,run,t){
 const D=C.DINO,x=54,h=run.dino.ducking?D.H*.55:D.H,y=D.GROUND_Y-h-run.dino.y;
 const duck=!!run.dino.ducking,air=!run.dino.grounded;
 const body=g.createLinearGradient?g.createLinearGradient(0,y,0,y+h):null;
 if(body){body.addColorStop(0,'#7ec86f');body.addColorStop(.55,'#4fa843');body.addColorStop(1,'#35802e');}
 const FILL=body||'#4fa843',DARK='#2c6b28',LIGHT='#a5dd8f';
 g.save();g.translate(x,y);
 if(duck)g.translate(-4,0);
 const stride=run.dino.grounded&&run.speed>0?Math.sin(t*22):0;
 // хвост
 g.fillStyle=FILL;g.beginPath();
 g.moveTo(10,duck?4:12);g.quadraticCurveTo(-14,duck?-2:2,-20,duck?8:14);
 g.quadraticCurveTo(-10,duck?14:22,10,duck?16:26);g.closePath();g.fill();
 // тело
 g.fillStyle=FILL;dinoRoundRect(g,8,duck?2:8,28,duck?16:26,9);g.fill();
 // светлая брюшина — объём
 g.fillStyle=LIGHT;dinoRoundRect(g,12,duck?10:24,20,duck?7:9,5);g.fill();
 // гребень на спине
 g.fillStyle=DARK;
 for(let i=0;i<3;i++){const cx=14+i*8;g.beginPath();g.moveTo(cx,duck?2:8);g.quadraticCurveTo(cx+2,duck?-4:0,cx+5,duck?2:8);g.closePath();g.fill();}
 // голова
 g.fillStyle=FILL;dinoRoundRect(g,24,duck?-4:0,20,15,6);g.fill();
 // пасть
 g.fillStyle=DARK;dinoRoundRect(g,34,duck?5:9,9,3.5,1.5);g.fill();
 g.fillStyle='#fff';dinoRoundRect(g,35,duck?3.4:7.4,7,1.6,1);g.fill(); // зубы
 // глаз + ноздря
 g.fillStyle='#fff';g.beginPath();g.arc(38,duck?1:5,3.4,0,Math.PI*2);g.fill();
 g.fillStyle='#1d2b1b';g.beginPath();g.arc(39,duck?1:5,1.7,0,Math.PI*2);g.fill();
 g.fillStyle=DARK;g.beginPath();g.arc(42,duck?6:10,1,0,Math.PI*2);g.fill();
 // лапы: бег — перебирают, прыжок — поджаты, пригибание — короткие
 g.fillStyle=FILL;
 if(air){ // поза прыжка: лапы поджаты под тело
  dinoRoundRect(g,9,duck?14:26,11,8,4);g.fill();
  dinoRoundRect(g,24,duck?14:26,11,8,4);g.fill();
 }else if(duck){
  dinoRoundRect(g,10,16,10,8,4);g.fill();
  dinoRoundRect(g,24,16,10,8,4);g.fill();
 }else{
  dinoRoundRect(g,10,32+Math.max(0,stride)*1.4,9,13-Math.max(0,stride),4);g.fill();
  dinoRoundRect(g,24,32+Math.max(0,-stride)*1.4,9,13-Math.max(0,-stride),4);g.fill();
 }
 g.restore();
}
// Кактус: скруглённый ствол с продольными рёбрами и мягкими отростками.
function drawDinoCactus(g,q){
 const body=g.createLinearGradient?g.createLinearGradient(q.x,0,q.x+q.w,0):null;
 if(body){body.addColorStop(0,'#2f8f57');body.addColorStop(.5,'#43ab6b');body.addColorStop(1,'#267346');}
 g.fillStyle=body||'#2f8f57';
 dinoRoundRect(g,q.x+q.w/2-4,q.y,8,q.h,4);g.fill();
 g.fillStyle='#f6fbf4';dinoRoundRect(g,q.x+q.w/2-2,q.y+4,1.6,q.h-8,1);g.fill(); // блик
 g.fillStyle=body||'#2f8f57';
 dinoRoundRect(g,q.x,q.y+q.h*.3,8,q.h*.45,4);g.fill();
 dinoRoundRect(g,q.x+q.w-8,q.y+q.h*.2,8,q.h*.5,4);g.fill();
 dinoRoundRect(g,q.x+q.w/2-4-5,q.y+q.h*.3-3,5,4,2);g.fill();
 dinoRoundRect(g,q.x+q.w-3,q.y+q.h*.2-3,5,4,2);g.fill();
 g.fillStyle='#f6fbf455';dinoRoundRect(g,q.x+q.w/2-4,q.y+q.h-5,8,2,1);g.fill();
}
// Птица: тело с клювом и машущими крыльями (два положения через синус).
function drawDinoBird(g,q,t){
 const flap=Math.sin(t*10)>0;
 g.save();g.translate(q.x+q.w/2,q.y+q.h/2);
 g.fillStyle='#4a5b70';
 dinoRoundRect(g,-16,-4,26,9,5);g.fill(); // тело
 g.fillStyle='#5d7086';dinoRoundRect(g,-22,-6,10,10,4);g.fill(); // голова
 g.fillStyle='#f4a63c';g.beginPath();g.moveTo(-26,-2);g.lineTo(-34,1);g.lineTo(-26,3);g.closePath();g.fill(); // клюв
 g.fillStyle='#fff';g.beginPath();g.arc(-19,-3,2,0,Math.PI*2);g.fill();
 g.fillStyle='#1d2b3b';g.beginPath();g.arc(-19,-3,1,0,Math.PI*2);g.fill();
 g.fillStyle='#3c4c60';g.beginPath(); // крыло
 g.moveTo(-8,0);g.quadraticCurveTo(4,flap?-16:4,16,flap?-10:8);
 g.quadraticCurveTo(4,flap?-4:8,0,4);g.closePath();g.fill();
 g.fillStyle='#4a5b70';dinoRoundRect(g,8,-3,8,3,2);g.fill(); // хвостик
 g.restore();
}
function drawDinoCoin(g,c,t){
 const w=Math.max(.25,Math.abs(Math.cos(t*4+c.x*.02)));
 g.save();g.translate(c.x+c.w/2,c.y+c.h/2);g.scale(w,1);
 const face=g.createRadialGradient?g.createRadialGradient(-3,-3,2,0,0,11):null;
 if(face){face.addColorStop(0,'#ffe98a');face.addColorStop(.7,'#ffd230');face.addColorStop(1,'#d99e12');}
 g.fillStyle=face||'#ffd230';g.beginPath();g.arc(0,0,10,0,Math.PI*2);g.fill();
 g.strokeStyle='#b37b00';g.lineWidth=2;g.stroke();
 g.fillStyle='#fff2a8';dinoRoundRect(g,-2,-5,3,10,1.5);g.fill();
 g.restore();
}
function drawDino(){
 const canvas=dialog.querySelector('#dino-canvas');if(!canvas||!dinoRun)return;
 dinoDrawWorld(canvas,g=>{
  drawDinoGround(g,dinoRun.t*dinoRun.speed);
  for(const q of dinoRun.obstacles){if(q.kind==='bird')drawDinoBird(g,q,dinoRun.t);else drawDinoCactus(g,q);}
  for(const c of dinoRun.coins)drawDinoCoin(g,c,dinoRun.t);
  for(const fx of dinoCoinFx){if(fx.t<fx.life)drawDinoCoin(g,{x:fx.x,y:fx.y,w:22,h:22},dinoRun.t);}
  drawDinoPlayer(g,dinoRun,dinoRun.t);
  g.fillStyle='#00000066';dinoRoundRect(g,10,8,190,26,8);g.fill();
  g.fillStyle='#fff';g.font='bold 15px monospace';g.textAlign='left';g.textBaseline='top';
  g.fillText('🪙 '+dinoRun.collected+'   ⭐ '+dinoRun.score,20,15);
  if(dinoRun.over){
   g.fillStyle='rgba(10,22,38,.5)';g.fillRect(0,0,1000,210);
   g.fillStyle='#fff';g.textAlign='center';g.textBaseline='middle';g.font='900 30px Arial Black,Arial,sans-serif';
   g.fillText('GAME OVER',500,80);g.font='bold 17px Arial,sans-serif';
   g.fillText('Очки '+f(dinoRun.score)+' · монет '+dinoRun.collected,500,115);
   if(!dinoBusy)g.fillText('Тап — новый заезд',500,150);
  }
 });
}
function renderRanking(host){
 const rows=C.leaderboard(A.players(),rankMode),mine=currentUid;
 host.innerHTML='<div class="arcade-tools"><button data-rank="slot">🎰 Автомат</button><button data-rank="mario">🍄 Марио</button></div><h3>'+ (rankMode==='slot'?'Рейтинг выплат автомата':'Рейтинг собранных монет Марио')+'</h3><p class="arcade-note">'+(rankMode==='slot'?'Сортировка по общей сумме выплат за всё время. Итог = выплаты минус ставки; он может быть отрицательным.':'Все монеты, полученные в Марио за всё время. Не влияет на рабочий рейтинг.')+'</p><div style="overflow-x:auto"><table class="arcade-ranking"><thead><tr><th>Игрок</th><th>'+ (rankMode==='slot'?'Выплаты':'Монеты')+'</th>'+(rankMode==='slot'?'<th>Ставки</th><th>Итог</th><th>Джекпоты</th>':'')+'</tr></thead><tbody>'+rows.map((p,i)=>'<tr class="'+(p.uid===mine?'me':'')+'"><td>'+(['🥇','🥈','🥉'][i]||i+1)+' '+E(resolveUserDisplayName(p.email,p.name))+(p.uid===mine?' · вы':'')+'</td><td>'+f(rankMode==='slot'?p.payouts:p.marioCoins)+'</td>'+(rankMode==='slot'?'<td>'+f(p.stakes)+'</td><td>'+(p.payouts-p.stakes>0?'+':'')+f(p.payouts-p.stakes)+'</td><td>'+p.jackpots+'</td>':'')+'</tr>').join('')+'</tbody></table></div>'+(!rows.length?'<p class="arcade-note">Пока никто не сыграл. Здесь появятся результаты участников.</p>':'')+'<div class="arcade-recent"><h3>Последние выигрыши</h3><p class="arcade-note">Последние 20 выигрышей всех игроков. Суммарный рейтинг включает всю историю.</p>'+A.recent().map(r=>'<div class="arcade-recent-row"><span>'+E(resolveUserDisplayName(r.userEmail,r.userName))+(r.result?.type==='jackpot'?' 👑 Джекпот':'')+'<small>'+E(new Date(r.timestamp).toLocaleString('ru-RU'))+'</small></span><b>+'+f(r.payout-r.cost)+' 🪙</b></div>').join('')+(!A.recent().length?'<p class="arcade-note">Выигрышей в последних событиях пока нет.</p>':'')+'</div>';
 host.querySelectorAll('[data-rank]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.rank===rankMode));b.onclick=()=>{rankMode=b.dataset.rank;render(true);};});
}
function hearts(n){n=Math.max(0,Math.min(3,Number(n)||0));return '❤️'.repeat(n)+'🖤'.repeat(3-n);}
function marioIsImmersive(){return dialog.classList.contains('mario-immersive');}
let marioAutoFs=false; // UI-1: fullscreen включён автоматически поворотом экрана
async function enterMarioFullscreen(){
  if(typeof dialog==='undefined'||!dialog)return;
  try{if(typeof dialog.requestFullscreen==='function')await dialog.requestFullscreen({navigationUI:'hide'});}catch(e){}
  try{if(screen.orientation&&typeof screen.orientation.lock==='function')await screen.orientation.lock('landscape');}catch(e){}
  dialog.classList.add('mario-immersive');
  // Экранные кнопки не должны тянуть игру в прокрутку страницы.
  document.documentElement.style.overscrollBehavior='none';
  render(true);
}
async function exitMarioFullscreen(){
  if(typeof dialog==='undefined'||!dialog)return;
  dialog.classList.remove('mario-immersive');
  document.documentElement.style.overscrollBehavior='';
  try{if(screen.orientation&&typeof screen.orientation.unlock==='function')screen.orientation.unlock();}catch(e){}
  try{if(document.fullscreenElement&&typeof document.exitFullscreen==='function')await document.exitFullscreen();}catch(e){}
  render(true);
}
if(typeof document!=='undefined'){
  document.addEventListener('fullscreenchange',()=>{
    // Выход из системного полноэкранного режима должен возвращать обычный вид.
     if(!document.fullscreenElement&&typeof dialog!=='undefined'&&dialog&&dialog.classList.contains('mario-immersive')){dialog.classList.remove('mario-immersive');document.documentElement.style.overscrollBehavior='';marioAutoFs=false;render(true);}
  });
  window.addEventListener('orientationchange',()=>setTimeout(()=>{if(typeof run!=='undefined'&&run&&marioIsImmersive())drawMario();},250));
  // UI-1: поворот телефона в landscape во время игры Марио сам разворачивает игру
  // на весь экран. Fullscreen API без жеста может отклонить запрос — тогда остаётся
  // CSS-полноэкранный режим (класс mario-immersive). Игра не перезапускается и
  // прогресс не теряется: stopRun не вызывается, canvas перерисовывает drawMario.
  const marioLandscape=matchMedia('(orientation: landscape)');
  marioLandscape.addEventListener?.('change',()=>{
    if(!dialog.open||view!=='mario'){marioAutoFs=false;return;}
    if(marioLandscape.matches&&!marioIsImmersive()){marioAutoFs=true;enterMarioFullscreen();}
    else if(!marioLandscape.matches&&marioAutoFs){marioAutoFs=false;exitMarioFullscreen();}
  });
}
function renderMario(host){
 // HUD теперь живёт внутри игровой области (поверх canvas). В полноэкранном
 // режиме добавляются джойстик слева и зона прыжка справа. Внешних кнопок
 // управления (отдельной панели arcade-tools для Mario) больше нет — всё
 // встроено в интерфейс игры, как в обычных играх.
 const isImmersive=marioIsImmersive();
 const firstRunKey=prefKey()+':mario-first-run-shown';
  const firstRunShown=localStorage.getItem(firstRunKey)==='1';
  const showFirstRun=isImmersive&&!firstRunShown,resumeAfterHint=!!(run&&!run.paused&&!run.done&&!run.over);
  if(showFirstRun&&run){run.paused=true;musicStop();}
  const showActions=!run||run.paused||run.done||run.over;
  host.innerHTML='<div class="mario-game-wrapper'+(showActions?' mario-awaiting-action':'')+'">'
  +'<div class="mario-ingame-hud" aria-label="Панель игры">'
  +'<div class="mig-left">'
  +'<span class="mig-stat">Ур. <b data-mario-level>'+(run?.map.level||1)+'</b>/20</span>'
  +'<span class="mig-stat" data-mario-lives>'+hearts(run?.lives??3)+'</span>'
  +'</div>'
  +'<div class="mig-center">'
  +'<span class="mig-stat">🪙 <b data-mario-coins>'+(run?.coins||0)+'</b></span>'
  +'<span class="mig-stat">⭐ <b data-mario-score>'+(run?.score||0)+'</b></span>'
  +'</div>'
  +'<div class="mig-right">'
  +'<button type="button" class="mig-btn" id="mario-pause" aria-label="Пауза">⏸</button>'
  +'<button type="button" class="mig-btn" id="mario-sound" aria-pressed="'+sound+'" aria-label="Звуки">'+(sound?'🔔':'🔕')+'</button>'
  +'<button type="button" class="mig-btn" id="mario-music" aria-pressed="'+musicOn+'" aria-label="Музыка">'+(musicOn?'🎵':'🚫')+'</button>'
  +(!isImmersive?'<button type="button" class="mig-btn" id="mario-fs" aria-label="Во весь экран">⛶</button>':'')
  +'</div>'
  +'</div>'
  +'<canvas id="mario-canvas" width="960" height="540" aria-label="Марио: движение джойстиком слева, прыжок — касанием правой половины экрана"></canvas>'
   +'<div id="mario-fs-controls">'
  +'<div class="mic-joystick" id="mario-joystick" aria-label="Джойстик движения: зажмите и ведите влево или вправо"><div class="mic-joystick-base"></div><div class="mic-joystick-thumb"></div></div>'
  +'<div class="mic-jump-zone" id="mario-jump-zone" aria-label="Зона прыжка: коснитесь в любом месте правой половины экрана"></div>'
  +'<div class="mic-jump-hint" id="mario-jump-hint"><b>ПРЫЖОК</b>коснитесь здесь</div>'
   +'</div>'
   +'<button type="button" class="mic-exit" id="mario-fs-exit" aria-label="Выйти из полноэкранного режима">✕</button>'
   +(showActions?'<div class="mario-ingame-actions" role="group" aria-label="Действия игры"><div class="mia-card">'
    +(!run?'<div id="mario-welcome-controls"><select id="mario-level" aria-label="Выбор уровня">'+Array.from({length:20},(_,i)=>'<option value="'+(i+1)+'" '+(i+1>unlocked()?'disabled':'')+'>Уровень '+(i+1)+(i+1>unlocked()?' · закрыт':'')+'</option>').join('')+'</select><button type="button" id="mario-start">Начать уровень</button></div>':'')
    +(run?.paused&&!run.done&&!run.over?'<button type="button" id="mario-pause-resume">Продолжить</button>':'')
    +(run?.done&&run.map.level<20&&run.map.level<unlocked()?'<button type="button" id="mario-next">Следующий уровень →</button>':'')
    +(run?'<button type="button" id="mario-restart">'+(run.over?'Играть снова':'Заново')+'</button>':'')
    +'</div></div>':'')
   +'</div>'
  +'<p class="arcade-note">Встроенное управление: слева — джойстик движения, справа — прыжок по касанию. Также работают клавиши ←/→, A/D, пробел, W, ↑. Пауза, звуки и музыка — в верхней панели.</p>';
 const canvas=host.querySelector('#mario-canvas');
 if(canvas&&!isImmersive){canvas.onclick=()=>enterMarioFullscreen();}
 // Кнопки HUD
 const pauseBtn=host.querySelector('#mario-pause');
  if(pauseBtn){pauseBtn.disabled=!run||run.done||run.over;pauseBtn.setAttribute('aria-pressed',String(!!run?.paused));pauseBtn.onclick=()=>{if(!run||run.done||run.over)return;run.paused=!run.paused;keys.clear();joyAxis=0;pointers.clear();lastFrame=0;if(run.paused)musicStop();render(true);startLoop();};}
  const resumeBtn=host.querySelector('#mario-pause-resume');
  if(resumeBtn)resumeBtn.onclick=()=>{if(!run||run.done||run.over)return;run.paused=false;lastFrame=0;render(true);startLoop();};
 host.querySelector('#mario-sound').onclick=()=>{sound=!sound;savePrefs();unlockSound();tone('click');render(true);};
 host.querySelector('#mario-music').onclick=()=>{musicOn=!musicOn;savePrefs();unlockSound();tone('click');if(musicOn)musicStart();render(true);};
 const fsBtn=host.querySelector('#mario-fs');
 if(fsBtn)fsBtn.onclick=()=>enterMarioFullscreen();
 const exitBtn=host.querySelector('#mario-fs-exit');
 if(exitBtn)exitBtn.onclick=()=>exitMarioFullscreen();
 const startBtn=host.querySelector('#mario-start');
 if(startBtn)startBtn.onclick=()=>{unlockSound();if(!run||run.done||run.lives<=0||run.map.level!==Number(host.querySelector('#mario-level').value))startLevel(Number(host.querySelector('#mario-level').value));else{run.paused=false;lastFrame=0;startLoop();}};
 const restartBtn=host.querySelector('#mario-restart');
  if(restartBtn){restartBtn.disabled=levelBusy;restartBtn.onclick=()=>startLevel(Number(host.querySelector('#mario-level')?.value||(run?.map.level||1)));}
 const nextBtn=host.querySelector('#mario-next');
  if(nextBtn){nextBtn.disabled=levelBusy;nextBtn.onclick=()=>{if(run?.done&&run.map.level<20&&run.map.level<unlocked())startLevel(run.map.level+1);};}
  host.querySelectorAll('.mario-ingame-actions button,.mig-btn,.mic-exit').forEach(b=>{b.addEventListener('pointerdown',e=>e.preventDefault());b.addEventListener('contextmenu',e=>e.preventDefault());});
  host.querySelector('.mario-ingame-actions')?.addEventListener('contextmenu',e=>e.preventDefault());
 // Джойстик: горизонтальное перетаскивание без отрыва пальца.
 // Ось axis ∈ [-1, 1] — пропорциональна смещению thumb от центра.
 const joy=host.querySelector('#mario-joystick');
 if(joy){
   const thumb=joy.querySelector('.mic-joystick-thumb');
   let joyPointerId=null,joyStartX=0,joyRadius=0;
   joyAxis=0;
   const onDown=e=>{
     e.preventDefault();unlockSound();
     joyPointerId=e.pointerId;joyStartX=e.clientX;
     const rect=joy.getBoundingClientRect();joyRadius=rect.width/2;
     joy.classList.add('active');joy.setPointerCapture?.(e.pointerId);
     updateThumb(e.clientX);
   };
   const onMove=e=>{if(joyPointerId!==e.pointerId)return;e.preventDefault();updateThumb(e.clientX);};
   const updateThumb=cx=>{
     const dx=cx-joyStartX;const max=joyRadius*.85;
     const clamped=Math.max(-max,Math.min(max,dx));
     thumb.style.transform='translate(calc(-50% + '+clamped+'px),-50%)';
     joyAxis=max>0?clamped/max:0;
     if(joyAxis<-0.15){pointers.set('joy','left');pointers.delete('joyR');}
     else if(joyAxis>0.15){pointers.set('joyR','right');pointers.delete('joy');}
     else{pointers.delete('joy');pointers.delete('joyR');}
   };
   const onEnd=e=>{if(joyPointerId!==e.pointerId)return;joyPointerId=null;joyAxis=0;joy.classList.remove('active');thumb.style.transform='translate(-50%,-50%)';pointers.delete('joy');pointers.delete('joyR');};
   joy.onpointerdown=onDown;joy.onpointermove=onMove;joy.onpointerup=onEnd;joy.onpointercancel=onEnd;joy.onlostpointercapture=onEnd;
   joy.addEventListener('contextmenu',e=>e.preventDefault());
 }
 // Зона прыжка: касание → прыжок + ripple + вспышка (тактильная отдача).
 // Удержание пальца продолжает держать jump (физика прыжка учитывает это).
 const jumpZone=host.querySelector('#mario-jump-zone');
 const jumpHint=host.querySelector('#mario-jump-hint');
 if(jumpZone){
   let jumpPointerId=null,jumpPressTimer=null;
   const spawnRipple=(x,y)=>{
     const r=document.createElement('div');r.className='mic-ripple';
     const rect=jumpZone.getBoundingClientRect();
     r.style.left=(x-rect.left)+'px';r.style.top=(y-rect.top)+'px';
     r.style.width=r.style.height='140px';
     jumpZone.appendChild(r);setTimeout(()=>r.remove(),600);
   };
   const spawnFlash=(x,y)=>{
     const f=document.createElement('div');f.className='mic-jump-flash';
     const rect=jumpZone.getBoundingClientRect();
     f.style.setProperty('--fx-x',((x-rect.left)/rect.width*100)+'%');
     f.style.setProperty('--fx-y',((y-rect.top)/rect.height*100)+'%');
     jumpZone.appendChild(f);setTimeout(()=>f.remove(),400);
   };
   jumpZone.onpointerdown=e=>{
     e.preventDefault();unlockSound();
     jumpPointerId=e.pointerId;jumpZone.setPointerCapture?.(e.pointerId);
     spawnRipple(e.clientX,e.clientY);spawnFlash(e.clientX,e.clientY);
     pointers.set(e.pointerId,'jump');
     if(jumpHint&&!jumpHint.classList.contains('hidden'))jumpHint.classList.add('hidden');
     // Короткая виброотдача (если поддерживается)
     try{navigator.vibrate&&navigator.vibrate(18);}catch(_){}
   };
   const onUp=e=>{if(jumpPointerId!==e.pointerId)return;jumpPointerId=null;pointers.delete(e.pointerId);clearTimeout(jumpPressTimer);};
   jumpZone.onpointerup=onUp;jumpZone.onpointercancel=onUp;jumpZone.onlostpointercapture=onUp;
   jumpZone.addEventListener('contextmenu',e=>e.preventDefault());
 }
 // Оверлей первого запуска: объясняет управление один раз.
  if(showFirstRun){
   try{localStorage.setItem(firstRunKey,'1');}catch(_){}
   const ov=document.createElement('div');ov.className='mario-first-run';ov.setAttribute('role','dialog');ov.setAttribute('aria-label','Подсказка управления');
   ov.innerHTML='<div class="mfr-card"><h3>Как играть</h3>'
    +'<div class="mfr-row"><div class="mfr-icon joy" aria-hidden="true"></div><div><span class="mfr-tap">Слева — джойстик.</span><br>Зажмите центр пальцем и ведите влево/вправо, не отрывая палец.</div></div>'
    +'<div class="mfr-row"><div class="mfr-icon jump" aria-hidden="true">↑</div><div><span class="mfr-tap">Справа — прыжок.</span><br>Коснитесь в любом месте правой половины экрана — пойдёт прыжок. Держите дольше — прыгнет выше.</div></div>'
    +'<div class="mfr-row" style="font-size:13px;opacity:.85">Сверху — уровень, жизни, монеты, пауза, звуки. Кнопка ✕ — выход.</div>'
    +'<button type="button" id="mario-first-run-ok">Понятно, играть</button></div>';
    host.querySelector('.mario-game-wrapper').appendChild(ov);
    ov.querySelector('#mario-first-run-ok').onclick=()=>{if(resumeAfterHint&&run&&!run.done&&!run.over)run.paused=false;lastFrame=0;render(true);startLoop();};
 }
 if(!run)drawWelcome();else drawMario();
}
function startLevel(level){if(!A.available('mario')||level>unlocked())return;stopRun();unlockSound();run=C.createRun(level);notice='';levelBusy=false;finishSummary=null;coinFx.length=0;render(true);speak('Уровень '+level);startLoop();}
function startLoop(){if(!raf&&dialog.open&&view==='mario'&&run&&!run.paused&&!run.done)raf=requestAnimationFrame(tickMario);if(run&&!run.paused&&!run.done)musicStart();else musicStop();}
function tickMario(now){raf=0;if(!run||!dialog.open||view!=='mario'||!A.available('mario'))return;if(document.hidden){run.paused=true;keys.clear();pointers.clear();joyAxis=0;musicStop();drawMario();return;}if(!lastFrame)lastFrame=now;const dt=(now-lastFrame)/1000;const input=new Set([...keys,...pointers.values()]);const axisFromKeys=(input.has('right')?1:0)-(input.has('left')?1:0);const axis=axisFromKeys!==0?axisFromKeys:joyAxis;C.advanceRun(run,{axis,jump:input.has('jump')},dt,event=>onMario(event,run));for(const fx of coinFx){fx.t+=dt;fx.y+=fx.vy*dt;fx.vy+=900*dt;}if(coinFx.length)coinFx=coinFx.filter(fx=>fx.t<fx.life);lastFrame=now;drawMario();updateNumbers();startLoop();}
async function onMario(event,session){
 if(event.type==='jump'){tone(Math.abs(session.player.vx)>10?'jumpRun':'jump');return;}
 if(event.type==='land'){tone('land');return;}
 if(event.type==='checkpoint'){tone('checkpoint');return;}
 if(event.type==='bump'){tone('block');return;}
 if(event.type==='blockCoin'){tone('coin');for(let i=0;i<event.coins;i++)coinFx.push({x:event.x,y:event.y-12,vy:-260-i*45,t:0,life:.85});setStatus('+'+event.coins+' 🪙 из блока · всего '+session.coins);return;}
 if(event.type==='coin'){tone('coin');coinFx.push({x:event.x,y:event.y,vy:-230,t:0,life:.7});setStatus('+1 🪙 · всего '+session.coins);return;}
 if(event.type==='stomp'){tone('stomp');coinFx.push({x:event.x,y:event.y,vy:-250,t:0,life:.8});setStatus('+1 🪙 за врага · всего '+session.coins);return;}
 if(event.type==='hurt'){tone('hornHit');setStatus('Ой, рога! Осталось жизней: '+event.lives);return;}
 if(event.type==='gameover'){tone('gameover');musicStop();notice='Игра окончена. Нажмите «Играть снова».';setStatus(notice);if(run===session){finishSummary=null;render(true);}return;}
 if(event.type==='finish'&&!levelBusy){
  levelBusy=true;const bestKey=prefKey()+':mario-best-'+session.map.level,prevBest=Number(localStorage.getItem(bestKey)||0),isRecord=event.score>prevBest;if(isRecord){try{localStorage.setItem(bestKey,String(event.score));}catch(e){}}
  tone(isRecord?'record':'clear');finishSummary={coins:event.coins,bonus:event.bonus,score:event.score,record:isRecord,credited:false};
   if(run===session)render(true);
   const user=currentUid;
  try{
   const result=await A.transact({id:'mario_finish_'+session.map.level+'_'+Date.now(),kind:'finish',level:session.map.level,coins:event.coins,score:event.score,jumpBonus:event.bonus});
   if(currentUid!==user)return;finishSummary.credited=true;finishSummary.creditedCoins=Number(result.payout)||event.coins;
   setStatus('Уровень пройден: '+event.coins+' 🪙 перечислены в кошелёк');
   speak('Уровень пройден! '+event.coins+' монет в кошельке.');
   if(run===session){render(true);const next=dialog.querySelector('#mario-next');if(next){next.hidden=session.map.level>=20;next.disabled=false;}}
  }catch(e){finishSummary.credited=false;setStatus('Монеты пока не перечислены: '+e.message);}
   finally{levelBusy=false;if(run===session)render(true);}
 }
}
function setStatus(text){notice=text;const el=dialog.querySelector('#arcade-status');if(el)el.textContent=text;}
function drawWelcome(){const canvas=dialog.querySelector('#mario-canvas');if(!canvas)return;const g=canvas.getContext('2d');if(!g)return;
 g.fillStyle='#5c94fc';g.fillRect(0,0,960,540);
 g.fillStyle='#3fa63f';for(let i=-1;i<5;i++){g.beginPath();g.arc(i*260+120,440,110,Math.PI,0);g.fill();}
 g.fillStyle='#c84c0c';g.fillRect(0,440,960,100);g.fillStyle='#4caf50';g.fillRect(0,440,960,12);
 g.fillStyle='#fff';g.font='900 46px Arial Black,Arial,sans-serif';g.textAlign='center';g.fillText('САМОСВАЛ · МАРИО',480,200);
 g.font='bold 20px monospace';g.fillText('20 уровней · монеты из блоков, за врагов и за прыжок на флаге',480,248);
 g.fillText('Все монеты в конце уровня уходят в кошелёк',480,278);
 g.fillStyle='#ffe066';g.fillText('Нажмите «Начать уровень»',480,340);
}
function drawCloud(g,x,y){g.fillStyle='#ffffff';g.beginPath();g.arc(x,y,22,0,Math.PI*2);g.arc(x+24,y-8,26,0,Math.PI*2);g.arc(x+52,y,22,0,Math.PI*2);g.fill();}
function drawCoinSprite(g,x,y,t,scale){const w=Math.max(.25,Math.abs(Math.cos(t*4+x*.02)));g.save();g.translate(x,y);g.scale(w*(scale||1),scale||1);g.fillStyle='#ffd230';g.beginPath();g.arc(0,0,9,0,Math.PI*2);g.fill();g.strokeStyle='#b37b00';g.lineWidth=2;g.stroke();g.fillStyle='#fff2a8';g.fillRect(-2,-5,3,10);g.restore();}
function drawGoomba(g,e,t){const x=e.x,y=e.y;g.fillStyle='#8a4b17';g.beginPath();g.ellipse(x+e.w/2,y+e.h*.55,e.w*.5,e.h*.55,0,0,Math.PI*2);g.fill();g.fillStyle='#f2d3a6';g.fillRect(x+5,y+e.h*.45,e.w-10,6);g.fillStyle='#fff';g.beginPath();g.arc(x+9,y+9,4,0,Math.PI*2);g.arc(x+e.w-9,y+9,4,0,Math.PI*2);g.fill();g.fillStyle='#231f20';g.beginPath();g.arc(x+9,y+9,2,0,Math.PI*2);g.arc(x+e.w-9,y+9,2,0,Math.PI*2);g.fill();g.fillStyle='#3b2410';g.fillRect(x+2,y+e.h-4,9,4);g.fillRect(x+e.w-11,y+e.h-4,9,4);}
function drawPlayerSprite(g,p,t){const x=Math.round(p.x),y=Math.round(p.y),walk=p.grounded&&Math.abs(p.vx)>.1,stride=walk?Math.sin(t*20)*2:0;
 g.fillStyle='#e52521';g.fillRect(x+3,y,22,7);g.fillRect(x,y+6,28,4);
 g.fillStyle='#fdc38a';g.fillRect(x+6,y+10,18,10);g.fillStyle='#6b3410';g.fillRect(x+4,y+9,5,8);g.fillRect(x+17,y+9,3,3);g.fillRect(x+21,y+12,6,4);g.fillStyle='#2b1b10';g.fillRect(x+19,y+11,4,4);
 g.fillStyle='#e52521';g.fillRect(x+3,y+20,22,10);g.fillStyle='#2a5bb7';g.fillRect(x+8,y+22,12,12);g.fillRect(x+6,y+20,4,8);g.fillRect(x+19,y+20,4,8);
 g.fillStyle='#ffd230';g.fillRect(x+10,y+24,2,2);g.fillRect(x+17,y+24,2,2);
 g.fillStyle='#6b3410';g.fillRect(x+4,y+33+stride,10,4);g.fillRect(x+17,y+33-stride,10,4);
}
function drawMario(){
 const canvas=dialog.querySelector('#mario-canvas');if(!canvas||!run)return;const g=canvas.getContext('2d');if(!g)return;
 const m=run.map,p=run.player,cam=run.camera,night=m.level%4===0;
 g.fillStyle=night?'#0b1a33':'#5c94fc';g.fillRect(0,0,960,540);
 g.fillStyle=night?'#17304f':'#3fa63f';for(let i=-1;i<7;i++){const x=i*300-(cam*.22)%300;g.beginPath();g.arc(x+120,440,110,Math.PI,0);g.fill();}
 for(let i=0;i<6;i++)drawCloud(g,i*250+70-(cam*.12)%250,70+(i%2)*40);
 g.save();g.translate(-cam,0);
 for(const q of m.platforms){if(q.x+q.w<cam-40||q.x>cam+1000)continue;
  g.fillStyle='#c84c0c';g.fillRect(q.x,q.y,q.w,q.h);g.fillStyle='#e45c10';for(let tx=q.x;tx<q.x+q.w-4;tx+=32)for(let ty=q.y+14;ty<q.y+q.h-4;ty+=32)g.fillRect(tx+2,ty+2,28,28);
  g.fillStyle='#4caf50';g.fillRect(q.x,q.y,q.w,12);g.fillStyle='#6ee06e';g.fillRect(q.x,q.y,q.w,4);}
 for(const q of m.pipes){if(q.x+q.w<cam-40||q.x>cam+1000)continue;g.fillStyle='#00a800';g.fillRect(q.x+6,q.y+16,q.w-12,q.h-16);g.fillStyle='#00d800';g.fillRect(q.x,q.y,q.w,18);g.fillStyle='#007000';g.fillRect(q.x+q.w-10,q.y+20,8,q.h-20);g.strokeStyle='#005000';g.lineWidth=2;g.strokeRect(q.x+6,q.y+16,q.w-12,q.h-16);}
 for(const b of m.blocks){if(b.x+b.w<cam-40||b.x>cam+1000)continue;
  if(b.kind==='question'&&!b.used){g.fillStyle='#c27c00';g.fillRect(b.x,b.y,b.w,b.h);g.fillStyle='#fbc02d';g.fillRect(b.x+3,b.y+3,b.w-6,b.h-6);g.fillStyle='#7a4a00';g.font='900 28px monospace';g.textAlign='center';g.textBaseline='middle';g.fillText('?',b.x+b.w/2,b.y+b.h/2+2);}
  else{g.fillStyle='#9c4a00';g.fillRect(b.x,b.y,b.w,b.h);g.fillStyle='#c86a1a';for(let ry=0;ry<2;ry++)for(let rx=0;rx<2;rx++)g.fillRect(b.x+3+rx*19,b.y+3+ry*19,18,18);g.fillStyle='#5c2c00';g.fillRect(b.x,b.y+b.h-4,b.w,4);}
 }
 for(const c of m.coins){if(run.collected.has(c.id)||c.x<cam-30||c.x>cam+990)continue;drawCoinSprite(g,c.x,c.y,run.time,1);}
 for(const e of m.enemies){if(!e.alive||e.x+e.w<cam-40||e.x>cam+1000)continue;drawGoomba(g,e,run.time);}
 const fx=m.flag;g.fillStyle='#9bd0a0';g.fillRect(fx,150,6,290);g.fillStyle='#ffd700';g.beginPath();g.arc(fx+3,146,8,0,Math.PI*2);g.fill();g.fillStyle='#e52521';g.beginPath();g.moveTo(fx+6,160);g.lineTo(fx+6,215);g.lineTo(fx+64,187);g.closePath();g.fill();
 g.fillStyle='#7a4a00';g.fillRect(fx-16,436,44,8);
 if(!(run.invuln>0&&Math.floor(run.time*14)%2))drawPlayerSprite(g,p,run.time);
 g.restore();
 for(const fx2 of coinFx){if(fx2.t<fx2.life)drawCoinSprite(g,fx2.x-cam,fx2.y,run.time,1-fx2.t/fx2.life*.4);}
 // Счётчик монет в углу — как в настоящей игре.
 g.fillStyle='#00000088';g.fillRect(12,10,170,38);g.fillStyle='#ffd230';g.font='bold 24px monospace';g.textAlign='left';g.textBaseline='top';g.fillText('🪙 × '+run.coins,22,17);
 g.fillStyle='#ffffff';g.font='bold 15px monospace';g.fillText('УРОВЕНЬ '+m.level,205,18);g.fillText('ОЧКИ '+run.score,205,36);
 if(run.paused||run.done){
  g.fillStyle='#06101de0';g.fillRect(0,0,960,540);
  g.textAlign='center';g.textBaseline='middle';g.fillStyle='#ffd230';g.font='900 34px Arial Black,Arial,sans-serif';
  g.fillText(run.over?'ИГРА ОКОНЧЕНА':run.done?'УРОВЕНЬ ПРОЙДЕН!':'ПАУЗА',480,215);
  g.font='bold 20px monospace';g.fillStyle='#fff';
  if(run.done&&finishSummary){
   g.fillText('Монет за уровень: '+finishSummary.coins+'  ·  бонус за прыжок: +'+finishSummary.bonus+(finishSummary.record?'  ·  НОВЫЙ РЕКОРД!':''),480,262);
   g.fillStyle=finishSummary.credited?'#8ef2a8':'#ffb86b';
   g.fillText(finishSummary.credited?'Перечислено в кошелёк: '+finishSummary.coins+' 🪙':'Сохраняем монеты…',480,296);
  }else g.fillText(run.over?'Нажмите «Играть снова» — вернутся все три сердца':run.done?'Нажмите «Следующий уровень»':'Нажмите «Продолжить»',480,262);
 }
}
const keyMap={ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right',ArrowUp:'jump',KeyW:'jump',Space:'jump'};
document.addEventListener('keydown',e=>{if(!dialog.open||view!=='mario'||/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))return;const k=keyMap[e.code];if(k){e.preventDefault();keys.add(k);unlockSound();}});
document.addEventListener('keyup',e=>{const k=keyMap[e.code];if(k)keys.delete(k);});
function pauseMarioOnBlur(){keys.clear();pointers.clear();joyAxis=0;if(run&&!run.done&&!run.over){run.paused=true;musicStop();if(view==='mario')render(true);}}
window.addEventListener('blur',pauseMarioOnBlur);document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseMarioOnBlur();});
const settings=document.createElement('div');settings.className='form-group';settings.innerHTML='<label>🎮 Мини-игры</label><button type="button" class="btn btn-secondary" data-open-arcade>Открыть игры и рейтинг</button><label style="display:block;margin-top:10px"><input type="checkbox" data-arcade-sound> Звуки и голос мини-игр</label><label style="display:block;margin-top:10px"><input type="checkbox" data-arcade-invites> Иногда приглашать в мини-игры</label><p class="arcade-note">Личные настройки для этого аккаунта в браузере.</p>';document.querySelector('#settingsModal .modal-body')?.append(settings);settings.querySelector('[data-open-arcade]').onclick=()=>{closeSettingsModal();open();};settings.querySelector('[data-arcade-sound]').onchange=e=>{sound=e.target.checked;savePrefs();unlockSound();};settings.querySelector('[data-arcade-invites]').onchange=e=>{invites=e.target.checked;savePrefs();if(!invites)hideInvite();};
function updateSettings(){settings.querySelector('[data-arcade-sound]').checked=sound;settings.querySelector('[data-arcade-invites]').checked=invites;settings.querySelector('[data-open-arcade]').disabled=!A.available();}
const admin=document.createElement('details');admin.className='admin-settings-group';admin.id='arcade-admin';admin.innerHTML='<summary>🎮 Мини-игры · доступ и приглашения</summary><div class="form-card">'+[['arcade_enabled','Показывать мини-игры всем, включая наблюдателей'],['arcade_mario','Марио'],['arcade_slot','Однорукий бандит'],['arcade_invites','Редкие приглашения в мини-игры']].map(([id,title])=>'<div class="settings-row"><label for="'+id+'">'+title+'</label><label class="toggle-switch"><input id="'+id+'" type="checkbox" data-arcade-flag="'+id+'"><span class="toggle-slider"></span></label></div>').join('')+'<p class="arcade-note">Выключение скрывает игру, закрывает открытый экран и запрещает новые ставки или награды. Балансы, открытые уровни и рейтинг сохраняются. Звук также учитывает общий переключатель игровых звуков.</p></div>';document.getElementById('admin-game-settings-slot')?.append(admin);
const savingFlags=new Set(),recentFlags=new Map();admin.querySelectorAll('[data-arcade-flag]').forEach(input=>input.onchange=async()=>{if(!canAdmin())return;const id=input.dataset.arcadeFlag,value=input.checked,previous=appConfig?.testReviewFlags?.[id]!==false;savingFlags.add(id);recentFlags.set(id,value);appConfig.testReviewFlags={...(appConfig?.testReviewFlags||{}),[id]:value};input.disabled=true;syncUI();try{if(isNasRuntime())await nasSaveSettings({testReviewFlags:{[id]:value}});else await appConfigRef.set({testReviewFlags:{[id]:value}},{merge:true});window.dispatchEvent(new Event('review-flags-changed'));}catch(e){recentFlags.delete(id);appConfig.testReviewFlags={...(appConfig?.testReviewFlags||{}),[id]:previous};showError('Не удалось сохранить настройку: '+(e.message||'проверьте доступ и соединение'));}finally{savingFlags.delete(id);syncUI();}});
const invite=document.createElement('aside');invite.id='arcade-invite';invite.hidden=true;invite.setAttribute('aria-label','Приглашение в мини-игры');document.body.append(invite);let actionCount=0,lastInvite=Date.now(),inviteTimer=null;
function hideInvite(){invite.hidden=true;clearTimeout(inviteTimer);}
function invitation(){
 if(!A.available()||appConfig?.testReviewFlags?.arcade_invites===false||!invites||document.hidden||actionCount<30||Date.now()-lastInvite<12*60000||document.querySelector('dialog[open],.modal.open,.holding,#game-rank-celebration')||!document.getElementById('road-joke-toast')?.hidden)return;
 let record={day:C.dayKey(),count:0};try{const saved=JSON.parse(localStorage.getItem(inviteKey())||'null');if(saved?.day===record.day)record=saved;}catch(e){}if(record.count>=2)return;record.count++;try{localStorage.setItem(inviteKey(),JSON.stringify(record));}catch(e){}
 const kind=A.available('slot')?'slot':A.available('mario')?'mario':null;if(!kind)return;lastInvite=Date.now();actionCount=0;invite.hidden=false;
 invite.innerHTML=(kind==='slot'?mascot():'<div style="font-size:48px">🍄</div>')+'<b>Минутка отдыха?</b><p>'+(kind==='slot'?'Испытаем удачу? Общий джекпот — '+f(A.head().bank)+' виртуальных монет. Выигрыш не гарантирован.':'Дорожное приключение ждёт! Редкие монетки, прыжки и 20 уровней.')+'</p><div class="arcade-tools"><button data-play>Открыть игру</button><button data-later>Не сейчас</button><button data-never>Не приглашать</button></div>';
 invite.querySelector('[data-play]').onclick=()=>open(kind);invite.querySelector('[data-later]').onclick=hideInvite;invite.querySelector('[data-never]').onclick=()=>{invites=false;savePrefs();hideInvite();};inviteTimer=setTimeout(hideInvite,16000);if(kind==='slot')speak('Минутка отдыха? Испытаем удачу? Только виртуальные монеты.');
}
document.addEventListener('click',e=>{if(e.isTrusted&&!e.target.closest('#arcade-dialog,#arcade-invite'))actionCount++;},true);
function syncUI(){
 const today=C.dayKey();if(today!==lastDay){lastDay=today;if(run)run.collected.clear();}
 if(seenOwner!==currentUid){seenOwner=currentUid;loadPrefs();hideInvite();actionCount=0;lastInvite=Date.now();if(dialog.open)close();run=null;dinoRun=null;stopDino();slotMessage='';}
 const shiftId=state.shift?.id||'';if(lastShiftId&&shiftId!==lastShiftId&&dialog.open)close();lastShiftId=shiftId;
 entry.hidden=!A.visible();settings.hidden=!A.visible();admin.hidden=!canAdmin();admin.querySelectorAll('[data-arcade-flag]').forEach(input=>{const id=input.dataset.arcadeFlag;if(!savingFlags.has(id)){const recent=recentFlags.get(id);input.checked=recent!==undefined?recent:appConfig?.testReviewFlags?.[id]!==false;}input.disabled=!canAdmin()||savingFlags.has(id);});updateSettings();
 if(!A.available()||appConfig?.testReviewFlags?.arcade_invites===false||!invites)hideInvite();
 if(dialog.open)render();
}
A.subscribe(syncUI);window.addEventListener('review-flags-changed',syncUI);window.addEventListener('storage',e=>{if(e.key===prefKey()){loadPrefs();syncUI();}});setInterval(()=>{syncUI();invitation();},1000);syncUI();window.openRoadArcade=open;
})();
