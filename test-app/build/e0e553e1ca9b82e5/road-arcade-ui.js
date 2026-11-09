
(function(){
'use strict';
const A=window.RoadArcade,C=window.RoadArcadeCore,E=escapeHtml;
let view='home',rankMode='slot',dialogOwner='',viewStamp='',run=null,raf=0,lastFrame=0,slotBusy=false,slotTimer=null,slotMessage='',slotSymbols=['🍒','⭐','💎'],audio=null,sound=true,invites=true,seenOwner='',notice='',levelBusy=false,lastDay=C.dayKey();
const keys=new Set(),pointers=new Map(),f=n=>Number(n||0).toLocaleString('ru-RU');
const dialog=document.createElement('dialog');dialog.id='arcade-dialog';dialog.setAttribute('aria-labelledby','arcade-title');document.body.append(dialog);
const entry=document.createElement('button');entry.id='arcade-entry';entry.type='button';entry.title='Мини-игры и рейтинг выигрышей';entry.setAttribute('aria-label','Мини-игры и рейтинг выигрышей');entry.textContent='🎮';document.querySelector('#mainHeader .top-row')?.insertBefore(entry,document.querySelector('#mainHeader .gear-btn'));
const mascot=()=>'<div class="slot-mascot" aria-hidden="true"><div class="eyes"><i class="eye"></i><i class="eye"></i></div><div class="smirk"></div><div class="belly">🍒 ⭐</div><i class="lever"></i></div>';
const prefKey=()=>['samosval-arcade-prefs-v1',firebaseConfig.projectId,WORKSPACE_ID,currentUid].join(':');
const inviteKey=()=>prefKey()+':invitations';
function loadPrefs(){try{const p=JSON.parse(localStorage.getItem(prefKey())||'{}');sound=p.sound!==false;invites=p.invites!==false;}catch(e){sound=true;invites=true;}}
function savePrefs(){try{localStorage.setItem(prefKey(),JSON.stringify({sound,invites}));}catch(e){}if(!sound){speechSynthesisSafeCancel();}updateSettings();}
function unlocked(){return Math.min(20,A.me().unlocked||1);}
function unlockSound(){if(!sound||appConfig?.testReviewFlags?.game_sound===false)return;try{const Audio=window.AudioContext||window.webkitAudioContext;if(Audio){audio=audio||new Audio();if(audio.state==='suspended')audio.resume().catch(()=>{});}}catch(e){}}
function audioReady(){return sound&&appConfig?.testReviewFlags?.game_sound!==false&&audio?.state==='running';}
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
  else if(kind==='jump')audioBeep(430,t,.14,{peak:.04,to:820});
  else if(kind==='finish'){[659,784,1046,1318].forEach((n,i)=>audioBeep(n,t+i*.1,.22,{type:'triangle',peak:.04}));}
  else if(kind==='hurt')audioBeep(230,t,.28,{type:'sawtooth',peak:.04,to:95});
  else audioBeep(330,t,.12,{peak:.03});
 }catch(e){}
}
function speak(text){if(!sound||appConfig?.testReviewFlags?.game_sound===false||!audio||audio.state!=='running'||!window.speechSynthesis||!window.SpeechSynthesisUtterance)return;try{const u=new SpeechSynthesisUtterance(text);u.lang='ru-RU';u.rate=1.05;u.volume=.55;window.speechSynthesis.speak(u);}catch(e){}}
function speechSynthesisSafeCancel(){try{window.speechSynthesis?.cancel();}catch(e){}}
function stopRun(){if(raf)cancelAnimationFrame(raf);raf=0;lastFrame=0;keys.clear();pointers.clear();if(run)run.paused=true;}
function close(){stopRun();clearInterval(slotTimer);slotTimer=null;stopMatrixIdle();speechSynthesisSafeCancel();hideJackpot();if(dialog.open)dialog.close();}
dialog.addEventListener('close',()=>{stopRun();clearInterval(slotTimer);slotTimer=null;stopMatrixIdle();speechSynthesisSafeCancel();});
function open(next='home'){if(!A.visible())return;unlockSound();hideInvite();if(next==='mario'&&!A.available('mario')||next==='slot'&&!A.available('slot'))next='home';if(view!==next)stopRun();view=next;viewStamp='';dialogOwner=currentUid;if(!dialog.open)dialog.showModal();render(true);}
entry.onclick=()=>open();
function render(force=false){
 if(!dialog.open)return;if(dialogOwner!==currentUid||!A.visible()||(view==='slot'&&!A.available('slot'))||(view==='mario'&&!A.available('mario'))){close();return;}
 const status=A.status(),player=A.me(),today=player.daily?.day===C.dayKey()?player.daily.claims.length:0;
 const stamp=JSON.stringify([view,rankMode,sound,slotBusy,slotMessage,slotSymbols,status.ready,status.error,A.head().gameRound,unlocked(),view==='ranking'?Object.values(A.players()).map(p=>[p.uid,p._round]):null,view==='ranking'?A.recent().map(r=>r.id):null]);
 if(!force&&stamp===viewStamp){updateNumbers();return;}
 if(view==='mario'&&run&&!force&&dialog.querySelector('#mario-canvas')){updateNumbers();return;}viewStamp=stamp;
 dialog.innerHTML='<div class="arcade-head"><h2 id="arcade-title">🎮 Дорожная аркада</h2><button class="arcade-close" aria-label="Закрыть мини-игры">×</button></div>'
 +'<div class="arcade-tabs"><button data-view="home" aria-pressed="'+(view==='home')+'">Игры</button>'+(A.available('mario')?'<button data-view="mario" aria-pressed="'+(view==='mario')+'">🍄 Марио</button>':'')+(A.available('slot')?'<button data-view="slot" aria-pressed="'+(view==='slot')+'">🎰 Автомат</button>':'')+'<button data-view="ranking" aria-pressed="'+(view==='ranking')+'">🏆 Выигрыши</button><button id="arcade-sound" aria-pressed="'+sound+'">'+(sound?'🔊 Звук':'🔇 Без звука')+'</button></div>'
 +'<div class="arcade-balance"><span>Кошелёк <b data-arcade-balance>'+f(A.balance())+'</b> 🪙</span><span>Марио сегодня <b data-mario-daily>'+today+'</b> / 100</span></div><p class="arcade-note">Только виртуальные монеты приложения. Игры не меняют рабочий рейтинг. Дневной лимит обновляется в 00:00 по Москве.</p><div class="arcade-status" id="arcade-status" role="status">'+E(status.error||(!status.ready?'Синхронизируем игровой банк…':notice))+'</div><div id="arcade-content"></div>';
 dialog.querySelector('.arcade-close').onclick=close;dialog.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>open(b.dataset.view));dialog.querySelector('#arcade-sound').onclick=()=>{sound=!sound;savePrefs();unlockSound();dialog.querySelector('#arcade-sound').textContent=sound?'🔊 Звук':'🔇 Без звука';dialog.querySelector('#arcade-sound').setAttribute('aria-pressed',String(sound));};
 const host=dialog.querySelector('#arcade-content');
 if(view==='home'){
  host.innerHTML='<div class="arcade-hub">'+(A.available()?'':'<section class="arcade-game-card"><div class="game-emoji">🎮</div><h3>Игры ждут смены</h3><p class="arcade-note">Мини-игры открываются, когда на линии начата смена: игра идёт во время рабочей смены. Начните смену — и кнопки Марио и автомата появятся здесь.</p></section>')+(A.available('mario')?'<section class="arcade-game-card"><div class="game-emoji">🍄 🚧</div><h3>Марио: дорожное приключение</h3><p class="arcade-note">20 уровней, препятствия и всего пять монет на уровень. Каждую можно получить один раз в день. Максимум 100 монет за день.</p><button class="arcade-start" data-launch="mario">Играть</button></section>':'')+(A.available('slot')?'<section class="arcade-game-card">'+mascot()+'<h3>Однорукий бандит</h3><p class="arcade-note">Ставка 10 монет. Частые небольшие выплаты и редкий общий джекпот. Выигрыш не гарантирован.</p><button class="arcade-start" data-launch="slot">К автомату</button></section>':'')+'</div>';
  host.querySelectorAll('[data-launch]').forEach(b=>b.onclick=()=>open(b.dataset.launch));
 }else if(view==='slot')renderSlot(host);else if(view==='ranking')renderRanking(host);else renderMario(host);
 updateNumbers();
}
function updateNumbers(){
 const p=A.me(),today=p.daily?.day===C.dayKey()?p.daily.claims.length:0;
 dialog.querySelectorAll('[data-arcade-balance]').forEach(e=>e.textContent=f(A.balance()));dialog.querySelectorAll('[data-mario-daily]').forEach(e=>e.textContent=today);
 dialog.querySelectorAll('[data-slot-bank]').forEach(e=>e.textContent=f(A.head().bank));dialog.querySelectorAll('[data-slot-stakes]').forEach(e=>e.textContent=f(A.head().totalStakes));dialog.querySelectorAll('[data-slot-payouts]').forEach(e=>e.textContent=f(A.head().totalPayouts));
 // Кнопка не должна молча не реагировать: блокируем её только на время вращения,
 // а любую причину отказа объясняем текстом в spin().
 const spin=dialog.querySelector('#slot-spin');if(spin)spin.disabled=slotBusy;
 if(view==='mario'&&run){const el=dialog.querySelector('[data-mario-lives]');if(el)el.textContent='♥'.repeat(Math.max(0,run.lives));const level=dialog.querySelector('[data-mario-level]');if(level)level.textContent=run.map.level;}
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
    const result=await A.transact(operation);if(currentUid!==user)return;A.storeSpin(null);if(!result.replayed&&result.payout>=result.cost)window.__gameMoneyFlow?.(-result.cost);
    slotSymbols=result.result?.symbols||['🚧','🍒','⭐'];
    outcomeType=result.result?.type||'';outcomePayout=Number(result.payout)||0;outcomeCost=Number(result.cost)||C.BET;outcomeProfit=outcomePayout-outcomeCost;
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
    const profit=outcomeProfit;
    slotMessage=outcomeType==='jackpot'?'ДЖЕКПОТ! Выплата '+f(outcomePayout)+' 🪙 · общий банк ваш':profit>0?'Выплата '+f(outcomePayout)+' 🪙 · выигрыш за вычетом ставки +'+f(profit):profit===0?'Вернулась ставка: '+f(outcomePayout)+' 🪙. Итог 0.':'Выплата '+f(outcomePayout)+' 🪙 · итог −'+f(-profit);
   }catch(e){if(currentUid===user){outcomeType='';slotMessage=(e.message||'Нет связи')+' Если ставка уже принята, повторная проверка не спишет монеты ещё раз.';}}
   finally{if(reelAnim){reelAnim.cancel();reelAnim=null;}clearInterval(slotTimer);slotTimer=null;slotBusy=false;
    if(currentUid===user&&dialog.open&&view==='slot'){
     render(true);const shell=dialog.querySelector('.slot-shell');
     if(outcomeType==='jackpot'){shell?.classList.add('winner','jackpot');showJackpot(outcomePayout);tone('jackpot');speak('Джекпот! Поздравляем!');}
     else if(outcomeProfit>0){shell?.classList.add('winner');matrixFlash(outcomeType==='big'?'КРУПНЫЙ ВЫИГРЫШ':'ВЫИГРЫШ',outcomeType==='big'?'#9be7ff':'#8ef2a8');tone(outcomeType==='big'?'win':'coin');speak('Выигрыш '+outcomeProfit+' монет.');}
     else if(outcomeType)tone('hurt');
    }}
  }
function renderRanking(host){
 const rows=C.leaderboard(A.players(),rankMode),mine=currentUid;
 host.innerHTML='<div class="arcade-tools"><button data-rank="slot">🎰 Автомат</button><button data-rank="mario">🍄 Марио</button></div><h3>'+ (rankMode==='slot'?'Рейтинг выплат автомата':'Рейтинг собранных монет Марио')+'</h3><p class="arcade-note">'+(rankMode==='slot'?'Сортировка по общей сумме выплат за всё время. Итог = выплаты минус ставки; он может быть отрицательным.':'Все монеты, полученные в Марио за всё время. Не влияет на рабочий рейтинг.')+'</p><div style="overflow-x:auto"><table class="arcade-ranking"><thead><tr><th>Игрок</th><th>'+ (rankMode==='slot'?'Выплаты':'Монеты')+'</th>'+(rankMode==='slot'?'<th>Ставки</th><th>Итог</th><th>Джекпоты</th>':'')+'</tr></thead><tbody>'+rows.map((p,i)=>'<tr class="'+(p.uid===mine?'me':'')+'"><td>'+(['🥇','🥈','🥉'][i]||i+1)+' '+E(resolveUserDisplayName(p.email,p.name))+(p.uid===mine?' · вы':'')+'</td><td>'+f(rankMode==='slot'?p.payouts:p.marioCoins)+'</td>'+(rankMode==='slot'?'<td>'+f(p.stakes)+'</td><td>'+(p.payouts-p.stakes>0?'+':'')+f(p.payouts-p.stakes)+'</td><td>'+p.jackpots+'</td>':'')+'</tr>').join('')+'</tbody></table></div>'+(!rows.length?'<p class="arcade-note">Пока никто не сыграл. Здесь появятся результаты участников.</p>':'')+'<div class="arcade-recent"><h3>Последние выигрыши</h3><p class="arcade-note">Последние 20 выигрышей всех игроков. Суммарный рейтинг включает всю историю.</p>'+A.recent().map(r=>'<div class="arcade-recent-row"><span>'+E(resolveUserDisplayName(r.userEmail,r.userName))+(r.result?.type==='jackpot'?' 👑 Джекпот':'')+'<small>'+E(new Date(r.timestamp).toLocaleString('ru-RU'))+'</small></span><b>+'+f(r.payout-r.cost)+' 🪙</b></div>').join('')+(!A.recent().length?'<p class="arcade-note">Выигрышей в последних событиях пока нет.</p>':'')+'</div>';
 host.querySelectorAll('[data-rank]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.rank===rankMode));b.onclick=()=>{rankMode=b.dataset.rank;render(true);};});
}
function renderMario(host){
 host.innerHTML='<div class="mario-hud"><span>Уровень <b data-mario-level>'+(run?.map.level||1)+'</b> / 20</span><span>Жизни <b data-mario-lives>'+'♥'.repeat(run?.lives||3)+'</b></span><span>Редких монет: 5 на уровень</span></div><canvas id="mario-canvas" width="960" height="540" aria-label="Марио: движение стрелками или A и D, прыжок пробелом или экранной кнопкой"></canvas><div id="mario-controls"><div class="arrows"><button type="button" data-key="left" aria-label="Идти влево">←</button><button type="button" data-key="right" aria-label="Идти вправо">→</button></div><button type="button" class="jump" data-key="jump">Прыжок ↑</button></div><div class="arcade-tools"><select id="mario-level" aria-label="Выбор уровня">'+Array.from({length:20},(_,i)=>'<option value="'+(i+1)+'" '+(i+1>(unlocked())?'disabled':'')+' '+(run?.map.level===i+1?'selected':'')+'>Уровень '+(i+1)+(i+1>unlocked()?' · закрыт':'')+'</option>').join('')+'</select><button id="mario-start">'+(run&&!run.done&&run.lives>0?'Продолжить':'Начать уровень')+'</button><button id="mario-pause">Пауза</button><button id="mario-restart">Заново</button><button id="mario-next" '+(!run?.done||run.map.level>=20?'hidden':'')+'>Следующий уровень →</button></div><p class="arcade-note">← → / A D — движение; пробел, W или ↑ — прыжок. На врагов можно прыгать сверху. Монеты спрятаны на высоких площадках. Уже полученные сегодня монеты не начисляются повторно. Открытые уровни и дневной лимит сохраняются в аккаунте. Для начисления нужна связь.</p>';
 host.querySelector('#mario-start').onclick=()=>{unlockSound();if(!run||run.done||run.lives<=0||run.map.level!==Number(host.querySelector('#mario-level').value))startLevel(Number(host.querySelector('#mario-level').value));else{run.paused=false;lastFrame=0;startLoop();}};
 host.querySelector('#mario-restart').onclick=()=>startLevel(Number(host.querySelector('#mario-level').value));host.querySelector('#mario-pause').onclick=()=>{if(!run)return;run.paused=!run.paused;keys.clear();pointers.clear();if(!run.paused)startLoop();drawMario();};
 host.querySelector('#mario-next').onclick=()=>{if(run?.done&&run.map.level<20&&run.map.level<unlocked())startLevel(run.map.level+1);};
 host.querySelectorAll('[data-key]').forEach(b=>{b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture?.(e.pointerId);pointers.set(e.pointerId,b.dataset.key);b.setAttribute('aria-pressed','true');unlockSound();};const release=e=>{pointers.delete(e.pointerId);b.setAttribute('aria-pressed','false');};b.onpointerup=release;b.onpointercancel=release;b.onlostpointercapture=release;});
 if(!run)drawWelcome();else drawMario();
}
function startLevel(level){if(!A.available('mario')||level>unlocked())return;stopRun();unlockSound();run=C.createRun(level);notice='';levelBusy=false;const p=A.me();if(p.daily?.day===C.dayKey())for(const key of p.daily.claims){const [l,c]=key.split(':').map(Number);if(l===level)run.collected.add(c);}render(true);speak('Уровень '+level);startLoop();}
function startLoop(){if(!raf&&dialog.open&&view==='mario'&&run&&!run.paused&&!run.done)raf=requestAnimationFrame(tickMario);}
function tickMario(now){raf=0;if(!run||!dialog.open||view!=='mario'||!A.available('mario'))return;if(document.hidden){run.paused=true;keys.clear();pointers.clear();drawMario();return;}if(!lastFrame)lastFrame=now;const input=new Set([...keys,...pointers.values()]);C.advanceRun(run,{axis:(input.has('right')?1:0)-(input.has('left')?1:0),jump:input.has('jump')},(now-lastFrame)/1000,event=>onMario(event,run));lastFrame=now;drawMario();updateNumbers();startLoop();}
async function onMario(event,session){
 if(event.type==='jump'||event.type==='hurt'||event.type==='stomp'){tone(event.type==='stomp'?'coin':event.type);if(event.over){notice='Жизни закончились. Нажмите «Заново» — заработанные монеты сохранятся.';setStatus(notice);}return;}
 const user=currentUid;
 if(event.type==='coin'){
  const day=C.dayKey();try{const result=await A.transact({id:'mario_'+day+'_'+session.map.level+'_'+event.coin,kind:'mario',day,level:session.map.level,coin:event.coin});if(currentUid!==user)return;session.pending.delete(event.coin);session.collected.add(event.coin);if(result.delta>0&&!result.replayed){tone('coin');setStatus('+1 🪙 · Сегодня '+(A.me().daily?.claims.length||0)+' / 100');}else setStatus(result.reason==='limit'?'Дневной лимит 100 монет достигнут. Можно играть дальше без начислений.':'Эта монетка уже получена сегодня.');}catch(e){session.pending.delete(event.coin);setStatus(e.message||'Монета не сохранилась. Попробуйте ещё раз после подключения.');session.paused=true;}return;
 }
 if(event.type==='finish'&&!levelBusy){levelBusy=true;tone('finish');try{await A.transact({id:'mario_finish_'+session.map.level,kind:'finish',level:session.map.level});if(currentUid!==user)return;setStatus(session.map.level===20?'Все 20 уровней пройдены! Отличная работа.':'Уровень пройден! Следующий открыт.');speak('Уровень пройден!');if(run===session){render(true);const next=dialog.querySelector('#mario-next');if(next){next.hidden=session.map.level>=20;next.disabled=false;}}}catch(e){setStatus('Финиш пока не сохранён: '+e.message);session.done=false;session.paused=true;}finally{levelBusy=false;}}
}
function setStatus(text){notice=text;const el=dialog.querySelector('#arcade-status');if(el)el.textContent=text;}
function drawWelcome(){const canvas=dialog.querySelector('#mario-canvas');if(!canvas)return;const g=canvas.getContext('2d');if(!g)return;g.fillStyle='#9bd8ef';g.fillRect(0,0,960,540);g.fillStyle='#18445c';g.font='bold 35px sans-serif';g.textAlign='center';g.fillText('Марио: дорожное приключение',480,215);g.font='20px sans-serif';g.fillText('20 уровней · редкие монеты · максимум 100 за день',480,260);g.fillText('Нажмите «Начать уровень»',480,320);}
function drawMario(){
 const canvas=dialog.querySelector('#mario-canvas');if(!canvas||!run)return;const g=canvas.getContext('2d');if(!g)return;const m=run.map,p=run.player,camera=run.camera,night=m.level%4===0;
 g.fillStyle=night?'#142b4d':m.level%4===2?'#ead3ad':'#9edcf2';g.fillRect(0,0,960,540);g.fillStyle=night?'#243e5c':'#8cb8a3';for(let i=-1;i<6;i++){const x=i*260-(camera*.2)%260;g.beginPath();g.moveTo(x,440);g.lineTo(x+150,190);g.lineTo(x+310,440);g.fill();}
 g.fillStyle=night?'#eee6c4':'#ffffffbb';for(let i=0;i<5;i++){const x=i*270+90-(camera*.12)%270;g.beginPath();g.ellipse(x,80+(i%2)*45,55,16,0,0,Math.PI*2);g.fill();}
 g.save();g.translate(-camera,0);
 for(const q of m.platforms){if(q.x+q.w<camera||q.x>camera+960)continue;g.fillStyle=q.ground?'#805c3a':'#be803c';g.fillRect(q.x,q.y,q.w,q.h);g.fillStyle=q.ground?'#46515b':'#e9bf69';g.fillRect(q.x,q.y,q.w,12);if(q.ground){g.fillStyle='#e5d5a0';for(let x=q.x+20;x<q.x+q.w-15;x+=50)g.fillRect(x,q.y+4,24,3);}else{g.strokeStyle='#80552b';g.strokeRect(q.x,q.y,q.w,q.h);}}
 for(const coin of m.coins){if(coin.x<camera-20||coin.x>camera+980)continue;const claimed=run.collected.has(coin.id),pending=run.pending.has(coin.id);g.globalAlpha=claimed?.2:pending?.45:1;g.fillStyle='#ffd454';g.beginPath();g.ellipse(coin.x,coin.y+Math.sin(run.time*3+coin.id)*3,8,11,0,0,Math.PI*2);g.fill();g.strokeStyle='#b3760b';g.lineWidth=2;g.stroke();g.fillStyle='#fff0b3';g.fillRect(coin.x-1,coin.y-6,2,11);g.globalAlpha=1;}
 for(const e of m.enemies){if(!e.alive||e.x<camera-40||e.x>camera+980)continue;g.fillStyle='#a76d36';g.beginPath();g.ellipse(e.x+14,e.y+10,16,12,0,0,Math.PI*2);g.fill();g.fillStyle='#fff';g.fillRect(e.x+5,e.y+3,7,8);g.fillRect(e.x+17,e.y+3,7,8);g.fillStyle='#252224';g.fillRect(e.x+8,e.y+6,3,5);g.fillRect(e.x+18,e.y+6,3,5);g.fillRect(e.x-1,e.y+19,12,5);g.fillRect(e.x+18,e.y+19,12,5);}
 g.fillStyle='#e1e6eb';g.fillRect(m.flag,260,4,180);g.fillStyle='#55b972';g.beginPath();g.moveTo(m.flag+4,260);g.lineTo(m.flag+68,279);g.lineTo(m.flag+4,298);g.fill();
 // Small original canvas sprite: red cap, moustache, blue overalls.
 const x=Math.round(p.x),y=Math.round(p.y),stride=p.grounded&&p.vx?Math.sin(run.time*18)*2:0;
 g.fillStyle='#dc3438';g.fillRect(x+4,y,18,6);g.fillRect(x+1,y+5,26,4);g.fillStyle='#f4c58e';g.fillRect(x+6,y+9,17,11);g.fillRect(x+21,y+12,5,5);g.fillStyle='#5e3927';g.fillRect(x+5,y+9,5,9);g.fillRect(x+13,y+17,12,3);g.fillStyle='#202023';g.fillRect(x+18,y+10,3,4);g.fillStyle='#d83938';g.fillRect(x+3,y+20,22,9);g.fillStyle='#2e62ad';g.fillRect(x+7,y+20,4,9);g.fillRect(x+19,y+20,4,9);g.fillRect(x+7,y+25,16,7);g.fillStyle='#f5ce52';g.fillRect(x+9,y+24,2,2);g.fillRect(x+19,y+24,2,2);g.fillStyle='#6b422d';g.fillRect(x+4,y+30+stride,10,5);g.fillRect(x+17,y+30-stride,10,5);g.restore();
 if(run.paused||run.done){g.fillStyle='#082033aa';g.fillRect(0,0,960,540);g.fillStyle='#fff';g.textAlign='center';g.font='bold 30px sans-serif';g.fillText(run.done?'Уровень пройден!':run.lives<=0?'Попробуем ещё раз?':'Пауза',480,250);g.font='18px sans-serif';g.fillText(run.done?'Следующий уровень — кнопкой под игрой':run.lives<=0?'Нажмите «Заново»':'Нажмите «Продолжить»',480,290);}
}
const keyMap={ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right',ArrowUp:'jump',KeyW:'jump',Space:'jump'};
document.addEventListener('keydown',e=>{if(!dialog.open||view!=='mario'||/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))return;const k=keyMap[e.code];if(k){e.preventDefault();keys.add(k);unlockSound();}});
document.addEventListener('keyup',e=>{const k=keyMap[e.code];if(k)keys.delete(k);});window.addEventListener('blur',()=>{keys.clear();pointers.clear();if(run)run.paused=true;});document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();pointers.clear();if(run)run.paused=true;}});
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
 if(seenOwner!==currentUid){seenOwner=currentUid;loadPrefs();hideInvite();actionCount=0;lastInvite=Date.now();if(dialog.open)close();run=null;slotMessage='';}
 entry.hidden=!A.visible();settings.hidden=!A.visible();admin.hidden=!canAdmin();admin.querySelectorAll('[data-arcade-flag]').forEach(input=>{const id=input.dataset.arcadeFlag;if(!savingFlags.has(id)){const recent=recentFlags.get(id);input.checked=recent!==undefined?recent:appConfig?.testReviewFlags?.[id]!==false;}input.disabled=!canAdmin()||savingFlags.has(id);});updateSettings();
 if(!A.available()||appConfig?.testReviewFlags?.arcade_invites===false||!invites)hideInvite();
 if(dialog.open)render();
}
A.subscribe(syncUI);window.addEventListener('review-flags-changed',syncUI);window.addEventListener('storage',e=>{if(e.key===prefKey()){loadPrefs();syncUI();}});setInterval(()=>{syncUI();invitation();},1000);syncUI();window.openRoadArcade=open;
})();

