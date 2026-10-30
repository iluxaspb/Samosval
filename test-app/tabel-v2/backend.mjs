import {firestoreRemote} from './store.mjs';
// Keep the original Firebase database name; NAS never opens that outbox.
export function storageScope(session) {
  if(session.provider==='synology') {
    let parts;try{parts=JSON.parse(session.providerScope);}catch{throw Error('Не подтверждён источник табеля');}
    if(!Array.isArray(parts)||parts.length!==4||parts[0]!=='synology'||parts[2]!==session.workspaceId||parts[3]!==session.uid)throw Error('Не подтверждён источник табеля');
    const url=new URL(parts[1]);if(url.protocol!=='https:'||url.origin!==parts[1])throw Error('Не подтверждён адрес сервера табеля');
    return 'nas:'+session.providerScope;
  }
  if(session.provider&&session.provider!=='firebase')throw Error('Неизвестный сервер табеля');
  return session.projectId+'_'+session.workspaceId+'_'+session.uid;
}
export async function tableRemote(host,guard) {
  storageScope(host.session());
  if(host.session().provider==='synology') {
    if(typeof host.remoteFactory!=='function')throw Error('Клиент табеля Synology не подключён');
    const remote=await host.remoteFactory(guard);
    if(!remote||!['read','list','commit','watch'].every(key=>typeof remote[key]==='function'))throw Error('Некорректный клиент табеля Synology');
    return remote;
  }
  return firestoreRemote(host,guard);
}
export function sameTableSession(a,b){try{return a.uid===b.uid&&a.projectId===b.projectId&&a.workspaceId===b.workspaceId&&a.runtimeId===b.runtimeId&&storageScope(a)===storageScope(b);}catch{return false;}}
