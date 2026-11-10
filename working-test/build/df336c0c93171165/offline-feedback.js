
// Offline ticker + existing card animations: test-only bridge. Runs AFTER baked patches.
(function(){
  const previousUndo=window.undoLastAction;
  if(typeof previousUndo==='function')window.undoLastAction=function(){
    if(typeof offlineLocalTicker==='function'&&offlineLocalTicker())return undoLastOfflineAction();
    return previousUndo.apply(this,arguments);
  };
  // The original animation handles *reordering*, not a single unchanged-position
  // truck. Preserve the original animation; add a motion fallback only when
  // the old renderer did not start its multi-card animation.
  const originalAnimatedRenderLine=window.renderLine;
  let delayedLoadAnimation=null;
  function playSoloLoad(id){
    const el=document.getElementById('trucksLineList');
    const card=el&&Array.from(el.querySelectorAll('.truck-card[data-truck-id]'))
      .find(x=>x.dataset.truckId===id);
    if(!card)return;
    card.classList.remove('solo-load-animation');
    void card.offsetWidth;
    card.classList.add('solo-load-animation');
    setTimeout(()=>card.classList.remove('solo-load-animation'),1200);
  }
  window.renderLine=function(){
    const loaded=window.__cardJustLoaded;
    const fresh=loaded&&(Date.now()-loaded.time)<5500;
    const priorAnimationRunning=!!window.__lineAnimating;
    if(fresh&&priorAnimationRunning)delayedLoadAnimation={...loaded};
    const result=originalAnimatedRenderLine.apply(this,arguments);
    if(fresh){
      if(priorAnimationRunning){
        // The previous arrival animation must finish before the load can fly.
      }else if(!window.__lineAnimating){
        // No reorder happened: animate the loading card itself.
        delayedLoadAnimation=null;
        playSoloLoad(loaded.id);
        if(window.__cardJustLoaded===loaded)window.__cardJustLoaded=null;
      }
      // Otherwise the existing animation already started, so do not replay it.
    }
    return result;
  };
  setInterval(()=>{
    if(delayedLoadAnimation&&!window.__lineAnimating){
      const loaded=delayedLoadAnimation;
      delayedLoadAnimation=null;
      playSoloLoad(loaded.id);
    }
  },180);
  const list=document.getElementById('trucksLineList');
  if(!list)return;
  function markOfflineCards(){
    list.querySelectorAll('.truck-card[data-truck-id]').forEach(card=>{
      card.classList.toggle('offline-pending',offlinePendingForTruck(card.dataset.truckId));
    });
  }
  new MutationObserver(markOfflineCards).observe(list,{childList:true});
  setInterval(markOfflineCards,1000);
  markOfflineCards();
})();
