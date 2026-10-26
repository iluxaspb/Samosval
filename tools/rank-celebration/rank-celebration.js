  /* RANK CELEBRATION V2 START — presentation only; no score or reward writes. */
  let rankFireworkCanvas=null,rankFireworkFrame=null,rankLifecycleTimer=null,rankAudioBus=null;
  const rankAudioNodes=new Map();
  function stopRankAudio(){
    for(const source of [...applauseSources]){try{source.stop();}catch(e){}try{source.disconnect();}catch(e){}}
    applauseSources.clear();
    for(const nodes of rankAudioNodes.values())for(const node of nodes)try{node.disconnect();}catch(e){}
    rankAudioNodes.clear();
    if(rankAudioBus){for(const node of rankAudioBus.nodes)try{node.disconnect();}catch(e){}rankAudioBus=null;}
  }
  function dismissRankNotice(){
    stopRankFireworks();stopRankAudio();
    clearTimeout(rankLifecycleTimer);rankLifecycleTimer=null;
    clearTimeout(rankNoticeTimer);rankNoticeTimer=null;rankNotice?.remove();rankNotice=null;rankNoticePreview=false;
  }
  function stopRankFireworks(){
    if(rankFireworkFrame!==null)cancelAnimationFrame(rankFireworkFrame);
    rankFireworkFrame=null;rankFireworkCanvas?.remove();rankFireworkCanvas=null;
  }
  // Gentle, self-contained pyrotechnics: shaped noise + a low transient, not applause.
  // Sources and all graph nodes are tracked so close/revocation stops even scheduled sound.
  function rankFireworkSound(preview=false,kind='burst',pan=0,energy=1){
    if(!(preview?canAdmin():enabled())||appConfig?.testReviewFlags?.game_sound===false||!audioContext||audioContext.state!=='running')return;
    try{
      const ac=audioContext,rate=ac.sampleRate,t=ac.currentTime+.008;
      if(!rankAudioBus){
        const input=ac.createGain(),compressor=ac.createDynamicsCompressor(),output=ac.createGain();
        input.gain.value=.42;compressor.threshold.value=-14;compressor.knee.value=12;compressor.ratio.value=5;compressor.attack.value=.004;compressor.release.value=.18;output.gain.value=.6;
        input.connect(compressor);compressor.connect(output);output.connect(ac.destination);
        rankAudioBus={input,nodes:[input,compressor,output]};
      }
      const duration=kind==='launch'?.42:kind==='cue'?.72:1.12,buffer=ac.createBuffer(1,Math.ceil(rate*duration),rate),data=buffer.getChannelData(0);
      let brown=0;
      // A bounded deterministic generator avoids non-repeatable harsh impulses.
      let seed=kind==='launch'?173:827;
      const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1;};
      for(let i=0;i<data.length;i++){
        const age=i/rate,n=noise();brown=(brown+.035*n)/1.035;
        if(kind==='cue'){const envelope=Math.min(1,age/.035)*Math.exp(-age*5)*Math.min(1,(duration-age)/.09);data[i]=(Math.sin(2*Math.PI*523.25*age)*.19+Math.sin(2*Math.PI*659.25*age)*.11+Math.sin(2*Math.PI*783.99*age)*.07)*envelope;}
        else if(kind==='launch')data[i]=n*.11*Math.sin(Math.PI*age/duration)**2;
        else{
          const attack=Math.min(1,age/.009),body=(brown*2.1+n*.13)*Math.exp(-age*6.5),thump=Math.sin(2*Math.PI*(67*age-15*age*age))*.24*Math.exp(-age*13);
          // Uneven late crackles, each with a smooth 2ms onset and soft tail.
          let crackle=0;for(const at of [.17,.235,.31,.41,.54,.67,.81]){const d=age-at;if(d>=0&&d<.045)crackle+=n*.095*Math.min(1,d/.002)*Math.exp(-d*100)*(1-at*.65);}
          data[i]=(body+thump)*attack+crackle;
        }
      }
      const source=ac.createBufferSource(),filter=ac.createBiquadFilter(),gain=ac.createGain(),nodes=[source,filter,gain];
      source.buffer=buffer;filter.type='lowpass';filter.frequency.value=kind==='launch'?1600:2600;filter.Q.value=.45;gain.gain.value=Math.max(.15,Math.min(energy,1));
      source.connect(filter);filter.connect(gain);
      if(typeof ac.createStereoPanner==='function'){const stereo=ac.createStereoPanner();stereo.pan.value=Math.max(-.7,Math.min(.7,pan));gain.connect(stereo);stereo.connect(rankAudioBus.input);nodes.push(stereo);}else gain.connect(rankAudioBus.input);
      applauseSources.add(source);rankAudioNodes.set(source,nodes);
      source.onended=()=>{applauseSources.delete(source);for(const node of rankAudioNodes.get(source)||[])try{node.disconnect();}catch(e){}rankAudioNodes.delete(source);};
      source.start(t);source.stop(t+duration+.02);
    }catch(e){stopRankAudio();/* Audio support is optional and never interrupts work. */}
  }
  function startRankFireworks(preview=false){
    stopRankFireworks();
    if(appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const canvas=document.createElement('canvas');canvas.id='game-rank-fireworks';canvas.setAttribute('aria-hidden','true');
    let ctx;try{ctx=canvas.getContext?.('2d');}catch(e){return;}if(!ctx)return;
    document.body.append(canvas);rankFireworkCanvas=canvas;
    // Four rockets, 264 sparks total; no particle creation inside the animation loop.
    const bursts=[{at:.02,x:-.78,y:-.95,hue:42,count:72,size:1},{at:.43,x:.85,y:-.65,hue:171,count:60,size:.85},{at:.85,x:-.8,y:.8,hue:35,count:60,size:.83},{at:1.21,x:.35,y:-1.1,hue:46,count:72,size:1.03}];
    for(const b of bursts){b.flight=.49+b.size*.07;b.launched=false;b.exploded=false;b.sparks=Array.from({length:b.count},(_,i)=>({angle:Math.PI*2*i/b.count+(Math.random()-.5)*.1,speed:(.48+Math.random()*.55)*b.size,life:.82+Math.random()*.52,width:.7+Math.random()*.85,phase:Math.random()*6.28,depth:.68+Math.random()*.32}));}
    const started=performance.now();let width=0,height=0,dpr=0;
    function frame(now){
      if(!canvas.isConnected||document.hidden||!rankNotice||!(preview?canAdmin():enabled())||appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches){stopRankFireworks();stopRankAudio();return;}
      const elapsed=(now-started)/1000;if(elapsed>3.35){stopRankFireworks();return;}
      const w=window.innerWidth,h=window.innerHeight,pixelRatio=Math.min(window.devicePixelRatio||1,2);
      if(w!==width||h!==height||pixelRatio!==dpr){width=w;height=h;dpr=pixelRatio;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
      ctx.clearRect(0,0,width,height);ctx.globalCompositeOperation='lighter';ctx.lineCap='round';
      const radius=Math.min(width*.39,height*.34,245),spread=Math.min(width*.34,235),vertical=Math.min(height*.27,195);
      for(const b of bursts){
        const rocketAge=elapsed-b.at,age=rocketAge-b.flight;if(rocketAge<0)continue;
        const x=width/2+b.x*spread,y=height/2+b.y*vertical;
        if(!b.launched){b.launched=true;if(rocketAge<.12)rankFireworkSound(preview,'launch',b.x*.55,.48);}
        if(age<0){
          const originY=Math.min(height+12,y+radius*1.6),originX=x-b.x*radius*.28;
          const position=u=>({x:originX+(x-originX)*u,y:originY+(y-originY)*(1-(1-u)**1.55)});
          for(let j=6;j>=0;j--){const u=Math.max(0,Math.min(1,rocketAge/b.flight-j*.025)),p=position(u),q=position(Math.max(0,u-.035));ctx.strokeStyle='rgba(255,211,128,'+((1-j/7)*.85)+')';ctx.lineWidth=j?1.2:2;ctx.beginPath();ctx.moveTo(q.x,q.y);ctx.lineTo(p.x,p.y);ctx.stroke();}
          continue;
        }
        if(!b.exploded){b.exploded=true;if(age<.14)rankFireworkSound(preview,'burst',b.x*.55,b.size);}
        // Small local core only: no screen flash, and sparks fall under gravity.
        if(age<.16){const glow=ctx.createRadialGradient(x,y,0,x,y,22);glow.addColorStop(0,'rgba(255,241,190,'+(.46*(1-age/.16))+')');glow.addColorStop(1,'transparent');ctx.fillStyle=glow;ctx.fillRect(x-22,y-22,44,44);}
        for(const p of b.sparks){
          if(age>p.life)continue;
          const position=t=>{const distance=radius*p.speed*(1-Math.exp(-2.5*t));return {x:x+Math.cos(p.angle)*distance,y:y+Math.sin(p.angle)*distance*p.depth+radius*.25*t*t};};
          const head=position(age),tail=position(Math.max(0,age-.045)),fade=Math.pow(1-age/p.life,1.35),alpha=fade*(.83+.17*Math.sin(age*22+p.phase));
          ctx.strokeStyle='hsla('+b.hue+',85%,'+(70-age*17)+'%,'+alpha+')';ctx.lineWidth=p.width;ctx.beginPath();ctx.moveTo(tail.x,tail.y);ctx.lineTo(head.x,head.y);ctx.stroke();
          if(age<.55){ctx.fillStyle='rgba(255,247,210,'+(alpha*.85)+')';ctx.fillRect(head.x-.6,head.y-.6,1.2,1.2);}
        }
      }
      ctx.globalCompositeOperation='source-over';rankFireworkFrame=requestAnimationFrame(frame);
    }
    rankFireworkFrame=requestAnimationFrame(frame);
  }
  function showRankNotice(milestone,preview=false){
    dismissRankNotice();
    if(document.hidden||!(preview?canAdmin():enabled()))return;
    const el=document.createElement('aside');el.id='game-rank-celebration';el.setAttribute('role','status');el.setAttribute('aria-live','polite');el.setAttribute('aria-atomic','true');
    const effects=appConfig?.testReviewFlags?.game_effects!==false&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.classList.toggle('festive',effects);
    const index=Math.max(0,levels.findIndex(l=>l.at===milestone.at)),numerals=['I','II','III','IV','V','VI'];
    const title=document.createElement('strong');title.className='rank-eyebrow';title.textContent=milestone.at?'НОВЫЙ РАНГ':'ДОБРО ПОЖАЛОВАТЬ';
    const emblem=document.createElement('span');emblem.className='rank-emblem';emblem.setAttribute('aria-hidden','true');
    // Original inline vector artwork; no external image, font, audio or network request.
    emblem.innerHTML='<svg viewBox="0 0 116 100" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="rankGold" x1="30" y1="8" x2="83" y2="85" gradientUnits="userSpaceOnUse"><stop stop-color="#fff1b5"/><stop offset=".45" stop-color="#d4a849"/><stop offset="1" stop-color="#8e682c"/></linearGradient></defs><path d="M30 80C13 69 9 47 20 31M86 80c17-11 21-33 10-49" stroke="#c5a35e" stroke-width="1.4"/><path d="M20 63c-9-2-12-7-12-14 8 1 12 6 12 14Zm-2-15c-7-4-8-10-6-16 7 3 9 8 6 16Zm3-14c-4-6-3-12 1-17 5 6 4 11-1 17ZM25 74c-8 1-14-2-17-8 8-2 14 1 17 8Zm71-11c9-2 12-7 12-14-8 1-12 6-12 14Zm2-15c7-4 8-10 6-16-7 3-9 8-6 16Zm-3-14c4-6 3-12-1-17-5 6-4 11 1 17ZM91 74c8 1 14-2 17-8-8-2-14 1-17 8Z" fill="#c8a45c"/><path d="m58 5 31 18v37L58 88 27 60V23L58 5Z" fill="url(#rankGold)"/><path d="m58 11 25 15v32L58 81 33 58V26l25-15Z" fill="#1c2b36" stroke="#f7dc90" stroke-opacity=".65"/><path d="m58 17 19 11v27L58 73 39 55V28l19-11Z" fill="#e7bd5c" fill-opacity=".1"/><path d="m58 23 2.5 5.4 5.9.7-4.4 4 .9 5.8-4.9-2.8-5 2.8 1-5.8-4.4-4 5.9-.7L58 23Z" fill="#ffe5a0"/><path d="m38 84 20 9 20-9" stroke="#d7b564" stroke-width="1.2"/></svg><span>'+numerals[index]+'</span>';
    const text=document.createElement('p');text.className='rank-name';text.textContent=milestone.name.replace(/^\S+\s+/u,'');
    const message=document.createElement('p');message.className='rank-message';message.textContent=milestone.at?'Отличная работа. Так держать!':'Большой путь начинается с первого шага.';
    const detail=document.createElement('span');detail.className='rank-milestone';
    const tier=document.createElement('span');tier.textContent='РАНГ '+(index+1)+' / '+levels.length;
    const dot=document.createElement('i');dot.setAttribute('aria-hidden','true');
    const threshold=document.createElement('span');threshold.textContent=milestone.at.toLocaleString('ru-RU')+' МОНЕТ';detail.append(tier,dot,threshold);
    const note=document.createElement('small');note.className='rank-footnote';note.textContent=preview?'Предпросмотр · баланс не меняется':'Заслужено работой на линии';
    const close=document.createElement('button');close.className='rank-dismiss';close.type='button';close.textContent='×';close.setAttribute('aria-label','Закрыть поздравление');close.onclick=dismissRankNotice;
    el.append(title,emblem,text,message,detail,note,close);document.body.append(el);rankNotice=el;rankNoticePreview=preview;
    const sessionUid=currentUid,tab=document.querySelector('.tab-content.active')?.id;
    function watch(){
      if(!rankNotice)return;
      if(document.hidden||sessionUid!==currentUid||!(preview?canAdmin():enabled())||tab!==document.querySelector('.tab-content.active')?.id){dismissRankNotice();return;}
      if(appConfig?.testReviewFlags?.game_sound===false)stopRankAudio();
      if(appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches){if(rankFireworkCanvas){stopRankFireworks();stopRankAudio();}el.classList.remove('festive');}
      rankLifecycleTimer=setTimeout(watch,100);
    }
    rankLifecycleTimer=setTimeout(watch,100);
    if(effects)startRankFireworks(preview);
    // Independent sound preference: static card gets one gentle chord, never orphan rockets.
    if(!rankFireworkCanvas)rankFireworkSound(preview,'cue',0,.7);
    rankNoticeTimer=setTimeout(dismissRankNotice,3600);
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&rankNotice)dismissRankNotice();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)dismissRankNotice();});
  for(const event of ['pagehide','popstate','hashchange'])window.addEventListener(event,dismissRankNotice);
  /* RANK CELEBRATION V2 END */
