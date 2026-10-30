// Temporary selections never enter the durable business-operation queue.
export function nasPresence(s,onChange,{doc=globalThis.document,nav=globalThis.navigator,
  events=globalThis,setTimer=setTimeout,clearTimer=clearTimeout,setEvery=setInterval,clearEvery=clearInterval,
  observe=callback=>new MutationObserver(callback),sessionId=()=>crypto.randomUUID(),now=Date.now}={}){
  const actor=s.host.session(),remote=s.host.presenceRemote,id=sessionId(),objectId=s.object.id;
  let sheetId=null,selection=null,sequence=0,generation=0,stopped=false,writing=false,polling=false,again=false,pending=null,peers=[],failure='';
  const visible=()=>!doc.hidden&&!s.root.hidden&&s.root.isConnected;
  const emit=()=>onChange(peers.filter(p=>now()-p.seen<125000),failure);
  const current=()=>{const a=s.host.session();return a.uid===actor.uid&&a.providerScope===actor.providerScope&&a.active!==false&&a.status!=='disabled'&&a.tabAccess!==false&&a.view!==false;};
  async function leave(){
    peers=[];emit();if(!remote||nav.onLine===false)return;
    try{await remote.remove({sessionId:id,sequence:++sequence});}catch{}
  }
  async function write(){
    if(writing){again=true;return;}
    if(stopped||!sheetId||!remote||!visible()||nav.onLine===false||!current())return;
    if(!s.sheetVisible(sheetId))return;
    const token=generation,payload={sessionId:id,sequence:++sequence,objectId,sheetId,selection:selection===null?null:JSON.parse(JSON.stringify(selection))};writing=true;
    try{await remote.write(payload);if(!stopped&&token===generation&&visible()&&current())failure='';}
    catch{if(!stopped&&token===generation){peers=[];failure='Не удалось обновить выделение Synology';}}
    finally{writing=false;if(!stopped&&token===generation)emit();if(stopped||!visible()||!current())void leave();else if(again||token!==generation){again=false;void write();}}
  }
  async function poll(){
    if(stopped||polling||!remote||!sheetId||!visible()||nav.onLine===false||!current())return;
    const token=generation,target=sheetId;polling=true;
    try{const data=await remote.list({objectId,sheetId:target});if(stopped||token!==generation||!visible()||!current())return;
      peers=data.peers.filter(p=>p.uid!==actor.uid&&p.objectId===objectId&&p.sheetId===target);failure='';emit();}
    catch{if(!stopped&&token===generation){peers=[];failure='Совместное выделение Synology недоступно';emit();}}
    finally{polling=false;}
  }
  const visibility=()=>{if(visible()&&current()){void write();void poll();}else void leave();};
  const observer=observe(visibility);observer.observe(s.root,{attributes:true,attributeFilter:['hidden']});
  doc.addEventListener('visibilitychange',visibility);events.addEventListener?.('online',visibility);events.addEventListener?.('pagehide',leave);
  const timer=setEvery(()=>{emit();void poll();},4000),heartbeat=setEvery(()=>{void write();},20000);
  const unregister=s.host.registerPresenceLeave?.(leave);
  return {
    update(next,a,b,hasSelection,stable={}){
      if(stopped)return;selection=hasSelection?{a,b,...stable}:null;
      if(next!==sheetId){generation++;sheetId=next;peers=[];failure=remote?'':'Клиент совместного выделения Synology не подключён';emit();void poll();void write();}
      else{clearTimer(pending);pending=setTimer(()=>{void write();},200);}
    },
    dispose(){if(stopped)return;stopped=true;generation++;clearEvery(timer);clearEvery(heartbeat);clearTimer(pending);observer.disconnect();unregister?.();
      doc.removeEventListener('visibilitychange',visibility);events.removeEventListener?.('online',visibility);events.removeEventListener?.('pagehide',leave);void leave();},
  };
}
