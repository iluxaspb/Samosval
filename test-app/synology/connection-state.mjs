// The selected mode is not proof that business data uses that backend.
export const modes = Object.freeze({firebase:'Только Firebase',synology:'Только Synology',auto:'Автоматически'});
export function connectionView({backend,online,syncState,signedIn}) {
  if (!signedIn || !online || syncState==='offline') return {letter:'О',source:'offline',label:'Офлайн · данные на устройстве'};
  if (!['firebase','synology'].includes(backend) || !['ok','syncing','error'].includes(syncState)) return {letter:'…',source:'checking',label:'Проверка источника данных'};
  const name=backend==='synology'?'Synology':'Firebase';
  return {letter:backend==='synology'?'S':'F',source:backend,label:name+(syncState==='error'?' · ошибка синхронизации':syncState==='syncing'?' · отправка изменений':' · источник данных')};
}
export function modeAvailability(mode,{clientReady=false,replicaReady=false,pending=0}={}) {
  if (!Object.hasOwn(modes,mode)) return 'Неизвестный режим';
  if (pending) return 'Сначала дождитесь отправки локальных действий.';
  if (mode!=='firebase'&&!clientReady) return 'Подключение всех экранов к Synology ещё не завершено.';
  if (mode==='auto'&&!replicaReady) return 'Автоматический переход станет доступен после проверки синхронизации резерва.';
  return null;
}

const endpoint='https://iluxa.synology.me:18443';
export async function checkSynology({getIdToken,guard=()=>{},fetchImpl=globalThis.fetch,timeoutMs=10000}={}) {
  if (typeof getIdToken!=='function'||typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000) throw TypeError('invalid-check-options');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  async function read(path) {
    for(let attempt=0;attempt<2;attempt++) {
      guard();
      const token=await getIdToken(attempt===1);
      guard();
      if(!token)throw Error('Требуется вход администратора');
      const response=await fetchImpl(endpoint+path,{headers:{Authorization:'Bearer '+token},signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
      guard();
      if(response.status===401&&attempt===0)continue;
      if(!response.ok)throw Object.assign(Error('Synology: HTTP '+response.status),{status:response.status});
      return response.json();
    }
  }
  try {
    const line=await read('/api/v1/line/snapshot');
    if(line?.format!=='samosval-line-snapshot'||line.version!==1||line.source!=='synology'||line.workspaceId!=='main_workspace'||!['trucks','statuses','logs'].every(k=>Array.isArray(line[k])))throw Error('Не подтверждён формат данных линии');
    const tabel=await read('/api/v1/tabel/records?key=_catalog%2Fconfig');
    const record=tabel?.record;
    if(!record||!Number.isSafeInteger(record.revision)||record.revision<0||!(record.data===null||typeof record.data==='object'&&!Array.isArray(record.data)))throw Error('Не подтверждён формат данных табеля');
    guard();
    const normal=line.logs.filter(x=>!x.isGAI);
    return {trucks:line.trucks.length,logs:line.logs.length,normal:normal.length,volume:normal.reduce((n,x)=>n+(Number(x.volume)||0),0)};
  } finally {clearTimeout(timer);}
}
