// Transactional IndexedDB test double. Serializes each store like native IDB.
// Browser QA uses real IndexedDB, including concurrent queue writes/deletes.
module.exports=function(){
  const databases=new Map();
  return {open(name){
    const req={};
    setTimeout(()=>{
      const fresh=!databases.has(name);
      if(fresh)databases.set(name,new Map());
      const stores=databases.get(name);
      req.result={
        createObjectStore:n=>stores.set(n,{data:new Map(),queue:[],running:false}),
        close(){},
        transaction(name,mode){
          const store=stores.get(name),tx={error:null},requests=[];
          let draft,active=false,failed=false,timer;
          function finish(){
            if(requests.length)return pump();
            if(failed){tx.error=Error('Quota exceeded');tx.onabort?.();}
            else {if(mode==='readwrite')store.data=draft;tx.oncomplete?.();}
            store.running=false;
            store.queue.shift();
            store.queue[0]?.();
          }
          function pump(){
            clearTimeout(timer);
            timer=setTimeout(()=>{
              const task=requests.shift();
              if(!task)return finish();
              const {method,value,r}=task;
              try{
                if(method==='get')r.result=structuredClone(draft.get(value));
                if(method==='getAll')r.result=structuredClone([...draft.values()]);
                if(method==='put'){
                  if(global.__failIdbWrites)throw Error('Quota');
                  draft.set(value.id||value.key,structuredClone(value));r.result=value.id||value.key;
                }
                if(method==='delete')draft.delete(value);
                r.onsuccess?.();
              }catch(e){failed=true;r.error=e;r.onerror?.();}
              pump();
            },0);
          }
          tx.objectStore=()=>Object.fromEntries(['get','getAll','put','delete'].map(method=>[method,value=>{
            const r={};requests.push({method,value,r});if(active)pump();return r;
          }]));
          const start=()=>{store.running=true;active=true;draft=new Map(store.data);pump();};
          store.queue.push(start);if(!store.running)start();
          return tx;
        }
      };
      if(fresh)req.onupgradeneeded?.();
      req.onsuccess?.();
    },0);
    return req;
  }};
};
