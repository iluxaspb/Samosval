import {firestoreRemote} from './store.mjs';
// NAS-hosted providers serve the table through a remote client instead of
// Firestore. Ubuntu replaced the old Synology server but keeps the same shape:
// provider scope is ["<provider>", origin, workspaceId, uid, datasetEpoch?].
export function isNasProvider(provider) {
  return provider === 'synology' || provider === 'ubuntu';
}
export function providerLabel(provider) {
  return provider === 'ubuntu' ? 'Ubuntu' : provider === 'synology' ? 'Synology' : 'Firebase';
}
// Keep the original Firebase database name; NAS never opens that outbox.
export function storageScope(session) {
  if(isNasProvider(session.provider)) {
    let parts;try{parts=JSON.parse(session.providerScope);}catch{throw Error('Не подтверждён источник табеля');}
    if(!Array.isArray(parts)||(parts.length!==4&&parts.length!==5)||parts[0]!==session.provider||parts[2]!==session.workspaceId||parts[3]!==session.uid)throw Error('Не подтверждён источник табеля');
    const url=new URL(parts[1]);if(url.protocol!=='https:'||url.origin!==parts[1])throw Error('Не подтверждён адрес сервера табеля');
    return 'nas:'+session.providerScope;
  }
  if(session.provider&&session.provider!=='firebase')throw Error('Неизвестный сервер табеля');
  return session.projectId+'_'+session.workspaceId+'_'+session.uid;
}
export async function tableRemote(host,guard) {
  storageScope(host.session());
  if(isNasProvider(host.session().provider)) {
    if(typeof host.remoteFactory!=='function')throw Error('Клиент табеля Ubuntu не подключён');
    const remote=await host.remoteFactory(guard);
    if(!remote||!['read','list','commit','watch'].every(key=>typeof remote[key]==='function'))throw Error('Некорректный клиент табеля Ubuntu');
    return remote;
  }
  return firestoreRemote(host,guard);
}
export function sameTableSession(a,b){try{return a.uid===b.uid&&a.projectId===b.projectId&&a.workspaceId===b.workspaceId&&a.runtimeId===b.runtimeId&&storageScope(a)===storageScope(b);}catch{return false;}}
export async function connectTable(host,runtime,prepare,isDisposed=()=>false){
  if(isDisposed())return;
  if(isNasProvider(host.session().provider)){
    // Attaching the outbox cannot wait for a separate catalog request. Otherwise
    // an initially unreachable server leaves the queue disconnected until reload.
    await Promise.all([runtime.connect(),prepare()]);
    if(!isDisposed())await runtime.refresh();return;
  }
  const enabled=await prepare();if(isDisposed())return;
  if(enabled)await runtime.connect();else{await runtime.refresh();runtime.notice('На устройстве: сервер не подключён');}
}
