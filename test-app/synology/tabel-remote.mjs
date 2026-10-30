// Optional NAS backend for the existing durable Tabel Store. No Firebase fallback.
export function createTabelRemote({baseUrl,getIdToken,fetchImpl=globalThis.fetch,guard=()=>{},timeoutMs=20000,pollMs=10000}={}) {
  let base;
  try {base=new URL(baseUrl);} catch {throw TypeError('invalid-api-url');}
  if (base.protocol!=='https:' || base.username || base.password || base.search || base.hash) throw TypeError('invalid-api-url');
  if (typeof getIdToken!=='function' || typeof fetchImpl!=='function' || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120000 || !Number.isSafeInteger(pollMs) || pollMs<1000) throw TypeError('invalid-transport-options');
  const endpoint=base.href.replace(/\/$/,'')+'/api/v1/tabel/records';
  async function request(query,job) {
    guard(job);
    const body=job===undefined?undefined:JSON.stringify({id:job.id,key:job.key,data:job.data,before:{revision:job.before.revision,data:job.before.data},label:job.label});
    const url=endpoint+(query?'?'+new URLSearchParams(query):'');
    for (let attempt=0;attempt<2;attempt++) {
      const token=await getIdToken(attempt===1);
      if (!token) throw Object.assign(Error('Требуется вход'),{code:'unauthenticated'});
      guard(job);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        const response=await fetchImpl(url,{method:body===undefined?'GET':'POST',body,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
        if (response.status===401 && attempt===0)continue;
        if(!response.ok)throw Object.assign(Error('Synology HTTP '+response.status),{code:'api-http-'+response.status,status:response.status});
        const value=await response.json();
        guard(job);
        if(!value || typeof value!=='object' || Array.isArray(value))throw Error('Некорректный ответ Synology');
        return value;
      } finally {clearTimeout(timer);}
    }
  }
  function validRecord(row) {return row && Number.isSafeInteger(row.revision) && row.revision>=0 && (row.data===null || row.data && typeof row.data==='object' && !Array.isArray(row.data));}
  async function pages(objectId,kind='records') {
    const rows=[],cursors=new Set();let cursor='';
    do {
      const page=await request({objectId,kind,cursor});
      if (!Array.isArray(page.rows) || !(page.cursor===null || typeof page.cursor==='string') || page.cursor!==null && (!page.cursor || cursors.has(page.cursor))) throw Error('Некорректная страница Synology');
      rows.push(...page.rows);cursor=page.cursor;if(cursor)cursors.add(cursor);
    } while(cursor);
    return rows;
  }
  const remote={
    async read(key) {const {record}=await request({key});if(!validRecord(record))throw Error('Некорректная запись Synology');return record;},
    async list(objectId) {const rows=await pages(objectId);if(rows.some(r=>!Array.isArray(r)||r.length!==2||typeof r[0]!=='string'||!r[0].startsWith(objectId+'/')||!validRecord(r[1])))throw Error('Некорректный список Synology');return rows;},
    async history(objectId) {return (await pages(objectId,'history')).map(row=>({id:row.id,key:row.key,before:row.before,after:row.after,data:row.after.data,label:row.label,time:row.time,author:{uid:row.author,name:row.after.authorName},confirmed:row.time}));},
    async commit(job) {
      const result=await request(null,job);
      if(result.conflict===true ? !validRecord(result.current) : !validRecord(result)||result.operationId!==job.id||result.key!==job.key)throw Error('Нет корректного подтверждения Synology; локальная очередь сохранена');
      return result;
    },
    watch(objectId,from,to,onData,onError) {
      let stopped=false,busy=false;
      const poll=async()=>{if(stopped||busy)return;busy=true;try{
        const rows=await remote.list(objectId);
        for(const key of ['_catalog/config','_defaults/config']){const row=await remote.read(key);if(row.data)rows.push([key,row]);}
        if(!stopped)onData(rows);
      }catch(e){if(!stopped)onError?.(e);}finally{busy=false;}};
      const timer=setInterval(poll,pollMs);poll();
      return ()=>{stopped=true;clearInterval(timer);};
    }
  };
  return Object.freeze(remote);
}
