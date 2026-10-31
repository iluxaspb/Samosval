import {coords} from './table-domain.mjs';
import {nasPresence} from './presence-nas.mjs';
export function userColors(ids) {
  const hues=[], result={};
  for (const id of [...new Set(ids)].sort()) {
    let hash=2166136261;
    for (const ch of id) hash=Math.imul(hash^ch.charCodeAt(0),16777619)>>>0;
    let hue=hash%360;
    for (let i=0;i<360 && hues.some(h=>Math.min(Math.abs(h-hue),360-Math.abs(h-hue))<24);i++) hue=(hue+37)%360;
    hues.push(hue); result[id]=`hsl(${hue} 72% 38%)`;
  }
  return result;
}
export function selectionContains(selection, cell, rowKey, colKey) {
  if(selection.rowKeys && selection.colKeys)return selection.rowKeys.includes(rowKey)&&selection.colKeys.includes(colKey);
  try { const a=coords(selection.a),b=coords(selection.b),p=coords(cell);
    return p.r>=Math.min(a.r,b.r)&&p.r<=Math.max(a.r,b.r)&&p.c>=Math.min(a.c,b.c)&&p.c<=Math.max(a.c,b.c);
  } catch { return false; }
}
// Presence is transient: never saved in the offline operation queue or audit history.
export function presence(s, onChange) {
  if(s.host.session().provider==='synology')return nasPresence(s,onChange);
  const actor=s.host.session(), id=crypto.randomUUID(), objectId=s.object.id;
  let sheetId=null, selection=null, selectionKey=null, stop=null, timer=null, stopped=false, pending=null, generation=0, writing=false, written='', lastWrite=0;
  let peers=[], failure='', again=false;
  const collection=s.remote && s.host.workspace?.collection('tabelNextPresence');
  const ref=collection?.doc(actor.uid+'_'+id);
  // The selected cell stays advertised while the operator switches apps or drops focus:
  // it ends only when they pick another cell, leave the table or the table is dismissed.
  const shown=()=>!s.root.hidden && s.root.isConnected;
  const visible=()=>shown()&&!document.hidden;
  const emit=()=>onChange(peers.filter(p=>Date.now()-p.seen<125000),failure);
  // Closing the table or the tab removes our record; switching to another app only pauses updates.
  const cleared=()=>{peers=[];failure='';emit();};
  function restart(){if(visible()&&!stop)watch(sheetId);}
  function wake(){if(stopped)return;restart();if(shown())void write();}
  async function write() {
    if (writing) { again=true; return; }
    if (stopped || !sheetId || !shown() || navigator.onLine===false || !ref) return;
    const key=JSON.stringify([sheetId,selection]);
    // The same cell is not re-sent within the heartbeat interval, but its timestamp is refreshed.
    if(key===written&&Date.now()-lastWrite<40000)return;
    writing=true;
    try {
      if (!s.sheetVisible(sheetId)) return;
      await ref.set({uid:actor.uid,sessionId:id,name:String(actor.nickname||actor.name||actor.uid).slice(0,160),objectId,sheetId,selection,seen:Date.now()});
      written=key;lastWrite=Date.now();failure='';
    } catch (e) { failure=e.code==='permission-denied' ? 'Присутствие недоступно: нужны правила Firebase 3.4.51' : 'Не удалось обновить присутствие'; }
    finally { writing=false; if(shown())emit(); if(stopped || !shown()) void ref.delete().catch(()=>{}); else if(again){again=false;void write();} }
  }
  function watch(next) {
    generation++;const token=generation;
    stop?.();stop=null;peers=[];failure=''; sheetId=next;
    // A hidden tab keeps its own record but does not keep reading other users.
    if (!visible()) { emit(); return; }
    if (!collection) { failure=actor.provider==='synology'?'Совместное выделение Synology ещё не подключено':'Совместное выделение доступно после подключения Firebase'; emit(); return; }
    try {
      const unsubscribe=collection.where('objectId','==',objectId).where('sheetId','==',sheetId).onSnapshot(snapshot=>{
        if(stopped||token!==generation)return;
        peers=snapshot.docs.map(d=>({...d.data(),id:d.id})).filter(p=>p.uid!==actor.uid && p.objectId===objectId && p.sheetId===sheetId);
        failure='';emit();
      },()=>{if(!stopped&&token===generation){peers=[];failure='Присутствие недоступно: проверьте правила Firebase';emit();}});
      // A snapshot that arrived while the tab was hidden must not keep the stopped listener alive.
      if (stop) unsubscribe?.(); else stop=unsubscribe;
    } catch { failure='Присутствие недоступно'; }
    emit(); void write();
  }
  function leave() { stop?.();stop=null;written='';cleared(); if(navigator.onLine!==false)void ref?.delete().catch(()=>{}); }
  const visibility=()=>{if(shown())wake();else leave();};
  const observer=new MutationObserver(visibility);
  observer.observe(s.root,{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',visibility);
  globalThis.addEventListener('online',visibility);
  globalThis.addEventListener('pagehide',leave);
  timer=setInterval(()=>{if(document.hidden)return;restart();void write();},45000);
  return {
    update(next,a,b,hasSelection,stable={}){
      if(stopped)return;const changed=next!==sheetId;selection=hasSelection?{a,b,...stable}:null;
      if(changed) watch(next);
      else if(visible()){clearTimeout(pending);pending=setTimeout(write,200);}
    },
    wake,
    dispose(){stopped=true;generation++;stop?.();clearInterval(timer);clearTimeout(pending);observer.disconnect();
      document.removeEventListener('visibilitychange',visibility);globalThis.removeEventListener('online',visibility);globalThis.removeEventListener('pagehide',leave);leave();},
  };
}
