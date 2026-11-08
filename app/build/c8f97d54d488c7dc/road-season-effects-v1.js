
(function(){
  'use strict';
  const seasonForTheme=id=>({'season-winter':'winter','season-autumn':'autumn','season-summer':'summer','season-spring':'spring'})[id]||'';
  function createParticles(season,w,h,random=Math.random){
    const count=season==='winter'?(w<600?24:36):season==='autumn'?(w<600?10:16):season==='spring'?(w<600?14:20):0;
    return Array.from({length:count},(_,i)=>({x:random()*w,y:random()*h,phase:random()*Math.PI*2,angle:random()*Math.PI*2,
      size:season==='winter'?1.2+random()*2:season==='autumn'?6+random()*4:3+random()*2,
      speed:season==='winter'?14+random()*17:season==='autumn'?12+random()*12:16+random()*15,
      drift:(random()-.5)*12,opacity:season==='winter'?.35+random()*.4:.35+random()*.3,
      color:i%3,drop:season==='spring'&&i%4===0}));
  }
  function advanceParticles(particles,dt,w,h,random=Math.random){
    const step=Math.max(0,Math.min(.08,dt));
    for(const p of particles){p.phase+=step*.7;p.angle+=step*.45;p.y+=p.speed*step;p.x+=(p.drift+Math.sin(p.phase)*7)*step;
      if(p.y>h+16){p.y=-16;p.x=random()*w;}if(p.x<-20)p.x=w+20;if(p.x>w+20)p.x=-20;}
  }
  function sunOpacity(seconds){const phase=((seconds%24)+24)%24;return phase<2?phase/2:phase<6?1:phase<9?(9-phase)/3:0;}
  window.__seasonEffectsCore={seasonForTheme,createParticles,advanceParticles,sunOpacity};
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let owner='',preference=true,season='',frame=0,syncFrame=0,previous=0,start=0,width=0,height=0,particles=[],active=false;
  const sessionPreferences=new Map();
  const key=()=>['samosval-season-effects-v1',firebaseConfig.projectId,WORKSPACE_ID,owner].join(':');
  const root=document.createElement('div');root.id='road-season-layer';root.setAttribute('aria-hidden','true');root.inert=true;
  const canvas=document.createElement('canvas');root.append(canvas);const ctx=canvas.getContext('2d');
  function readPreference(){try{const saved=localStorage.getItem(key());return saved===null?(sessionPreferences.get(key())??true):saved!=='0';}catch(e){return sessionPreferences.get(key())??true;}}
  function savePreference(value){preference=!!value;sessionPreferences.set(key(),preference);try{localStorage.setItem(key(),preference?'1':'0');}catch(e){showError('Сезонные эффекты переключены до закрытия страницы: браузер не разрешил сохранить настройку.');}sync();}
  function control(id){const row=document.createElement('div');row.className='road-season-setting';row.innerHTML='<div class="settings-row"><label for="'+id+'">🌦 Сезонные украшения</label><label class="toggle-switch"><input type="checkbox" id="'+id+'"><span class="toggle-slider"></span></label></div><p data-season-note></p>';row.querySelector('input').onchange=e=>savePreference(e.target.checked);return row;}
  const settingsControl=control('road-season-enabled');document.querySelector('#settingsModal .modal-body')?.append(settingsControl);
  function updateControls(){
    const preview=document.querySelector('#road-shop-dialog[open] .shop-preview-tools');
    if(preview&&!preview.querySelector('.road-season-setting'))preview.append(control('road-season-preview-enabled'));
    document.querySelectorAll('.road-season-setting').forEach(row=>{const input=row.querySelector('input');if(input.checked!==preference)input.checked=preference;input.disabled=!owner;
      const note=!owner?'Войдите, чтобы выбрать украшения.':appConfig?.testReviewFlags?.game_effects===false?'Общие игровые эффекты выключены администратором. Ваш личный выбор сохранён.':motion.matches?'В системе включено уменьшение движения: падающие частицы и солнце не анимируются. Снег на кнопках остаётся.':'Снег, листья, солнце и весенние лепестки. Выключатель убирает и движение, и снег с кнопок. Личный выбор для аккаунта в этом браузере.';
      const label=row.querySelector('[data-season-note]');if(label.textContent!==note)label.textContent=note;
    });
  }
  function decorateSnow(){
    if(season!=='winter'||!active)return;
    const targets='.truck-card,.form-card,.btn,.nav-btn,[data-road-sample="season-winter"] .sample-card,[data-road-sample="season-winter"] .sample-btn';
    document.querySelectorAll(targets).forEach(el=>{
      if(/^(INPUT|IMG|CANVAS|BR)$/.test(el.tagName))return;
      if(!el.classList.contains('season-snow-surface'))el.classList.add('season-snow-surface');
      if(!el.querySelector(':scope > .season-snow-cap')){const cap=document.createElement('span');cap.className='season-snow-cap';cap.setAttribute('aria-hidden','true');el.append(cap);}
    });
  }
  function clearSnow(){document.querySelectorAll('.season-snow-cap').forEach(el=>el.remove());document.querySelectorAll('.season-snow-surface').forEach(el=>el.classList.remove('season-snow-surface'));delete document.body.dataset.roadSeason;}
  function resize(){if(!ctx)return;const w=Math.max(1,innerWidth),h=Math.max(1,innerHeight);if(w===width&&h===height)return;width=w;height=h;const scale=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);ctx.setTransform(scale,0,0,scale,0,0);particles=createParticles(season,w,h);}
  function stopAnimation(){if(frame)cancelAnimationFrame(frame);frame=0;previous=0;root.remove();if(ctx)ctx.clearRect(0,0,width,height);}
  function drawParticle(p){
    ctx.save();ctx.globalAlpha=p.opacity;ctx.translate(p.x,p.y);
    if(season==='winter'){ctx.fillStyle='#f1faff';ctx.beginPath();ctx.arc(0,0,p.size,0,Math.PI*2);ctx.fill();}
    else if(season==='autumn'){ctx.rotate(p.angle);ctx.fillStyle=['#edc451','#e5a635','#cc832c'][p.color];ctx.beginPath();ctx.moveTo(0,-p.size);ctx.quadraticCurveTo(p.size*1.2,-p.size*.15,0,p.size);ctx.quadraticCurveTo(-p.size*.8,0,0,-p.size);ctx.fill();ctx.strokeStyle='#85562b';ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(0,-p.size*.65);ctx.lineTo(0,p.size*1.25);ctx.stroke();}
    else if(p.drop){ctx.strokeStyle='#69aab9';ctx.lineWidth=1.2;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(-1,p.size*1.6);ctx.stroke();}
    else {ctx.rotate(p.angle);ctx.fillStyle=['#e9b7ce','#93be97','#f5d2df'][p.color];ctx.beginPath();ctx.ellipse(0,0,p.size*.55,p.size,Math.PI/5,0,Math.PI*2);ctx.fill();}
    ctx.restore();
  }
  function drawSun(seconds){
    const opacity=sunOpacity(seconds);if(!opacity)return;
    const header=document.getElementById('mainHeader')?.getBoundingClientRect();const y=Math.min(height*.35,Math.max(54,(header?.bottom||0)+48));const x=Math.max(40,width-45);
    ctx.save();ctx.translate(x,y);ctx.globalAlpha=opacity*.7;
    const halo=ctx.createRadialGradient(0,0,15,0,0,43);halo.addColorStop(0,'#f9ca5a55');halo.addColorStop(1,'#f9ca5a00');ctx.fillStyle=halo;ctx.beginPath();ctx.arc(0,0,43,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.rotate(seconds*.035);ctx.strokeStyle='#dc9a27';ctx.lineWidth=2;ctx.lineCap='round';for(let i=0;i<10;i++){ctx.rotate(Math.PI/5);ctx.beginPath();ctx.moveTo(0,-25);ctx.lineTo(0,-31);ctx.stroke();}ctx.restore();
    ctx.fillStyle='#f2b943';ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.fill();ctx.fillStyle='#8c6424';ctx.beginPath();ctx.arc(-5,-2,1.2,0,Math.PI*2);ctx.arc(5,-2,1.2,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#8c6424';ctx.lineWidth=1.1;ctx.beginPath();ctx.arc(0,2,5,.15,Math.PI-.15);ctx.stroke();ctx.restore();
  }
  function tick(now){
    frame=0;if(!active||motion.matches||document.hidden||!ctx)return;
    if(!root.isConnected){queueSync();return;}
    if(!previous)previous=now;if(!start)start=now;
    if(now-previous>=32){const dt=(now-previous)/1000;previous=now;ctx.clearRect(0,0,width,height);
      if(season==='summer')drawSun((now-start)/1000);else{advanceParticles(particles,dt,width,height);for(const p of particles)drawParticle(p);}}
    frame=requestAnimationFrame(tick);
  }
  function sync(){
    const user=permissionsLoaded&&currentUserStatus==='active'?String(currentUid||''):'';
    if(user!==owner){stopAnimation();clearSnow();owner=user;preference=owner?readPreference():true;season='';active=false;start=0;}
    const next=seasonForTheme(window.RoadShop?.getAppliedTheme?.());
    const allow=!!owner&&preference&&appConfig?.testReviewFlags?.game_mode!==false&&appConfig?.testReviewFlags?.game_effects!==false&&!!next;
    const changed=season!==next||active!==allow;
    if(changed){stopAnimation();clearSnow();season=next;active=allow;start=0;particles=createParticles(season,width||innerWidth,height||innerHeight);}
    updateControls();
    if(!active){stopAnimation();return;}
    if(season==='winter'){document.body.dataset.roadSeason='winter';decorateSnow();}
    if(document.hidden||motion.matches||!ctx){stopAnimation();return;}
    // A native dialog is in the browser's top layer. Host the same canvas there
    // during shop previews so the selected season is actually visible.
    const host=document.querySelector('#road-shop-dialog[open]')||document.body;if(root.parentNode!==host)host.append(root);
    resize();if(!frame)frame=requestAnimationFrame(tick);
  }
  function queueSync(){if(!syncFrame)syncFrame=requestAnimationFrame(()=>{syncFrame=0;sync();});}
  new MutationObserver(changes=>{if(changes.some(c=>c.target!==root&&c.target!==canvas))queueSync();}).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('road-theme-changed',sync);window.addEventListener('review-flags-changed',sync);
  window.addEventListener('storage',e=>{if(owner&&e.key===key()){preference=readPreference();sync();}});
  window.addEventListener('resize',()=>{width=0;queueSync();});document.addEventListener('visibilitychange',sync);
  if(motion.addEventListener)motion.addEventListener('change',sync);else motion.addListener(sync);
  window.addEventListener('pagehide',()=>{stopAnimation();if(syncFrame)cancelAnimationFrame(syncFrame);syncFrame=0;});window.addEventListener('pageshow',sync);
  setInterval(sync,500);sync();
})();
