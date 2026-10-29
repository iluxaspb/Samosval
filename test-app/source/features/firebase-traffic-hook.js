/* TEST ONLY — local Firestore telemetry. One reporting day: Pacific (Firebase), displayed in Moscow. */
(function(){
  'use strict';
  if(window.FirebaseTraffic)return;
  const VERSION='1.2.0',FREE={reads:50000,writes:20000,deletes:20000};
  const MAX_EVENTS=10000,MAX_DAYS=180,HOUR=3600000,MSK_OFFSET=3*HOUR;
  const quotaFmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
  function quotaDay(ts){
    const p=Object.fromEntries(quotaFmt.formatToParts(new Date(ts)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    return p.year+'-'+p.month+'-'+p.day;
  }
  const tomorrow=day=>new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const today=()=>quotaDay(Date.now());
  const startCache=new Map();
  function periodStartUTC(day){
    if(startCache.has(day))return startCache.get(day);
    const midnight=Date.parse(day+'T00:00:00Z');
    for(let i=0;i<=12;i++){
      const tick=midnight+i*HOUR;
      if(quotaDay(tick)===day&&quotaDay(tick-HOUR)!==day){
        startCache.set(day,tick);return tick;
      }
    }
    return NaN;
  }
  const periodHours=day=>Math.round((periodStartUTC(tomorrow(day))-periodStartUTC(day))/HOUR);
  const mskTime=ts=>new Date(ts+MSK_OFFSET).toISOString().slice(0,16).replace('T',' ');
  const startMsk=day=>mskTime(periodStartUTC(day))+' МСК — '+mskTime(periodStartUTC(tomorrow(day)))+' МСК';
  const nextQuotaReset=(now=Date.now())=>periodStartUTC(tomorrow(quotaDay(now)));
  const hourInPeriod=(ts,day)=>Math.max(0,Math.min(24,Math.floor((ts-periodStartUTC(day))/HOUR)));
  const fresh=()=>({events:0,calls:0,reads:0,cached:0,writes:0,deletes:0,failed:0,listens:0,unsubscribes:0,snapshots:0,tx:0,batches:0,byType:{},byPath:{},hours:Array.from({length:25},()=>({calls:0,reads:0,writes:0,deletes:0}))});
  const loaded={days:{},events:[],totalEvents:0,active:0,ready:false,persisted:true,notice:''};
  let flushTimer=0,dirtyEvents=[],dbPromise=null,busy=false,enabled=false,started=false;
  const safeNum=x=>Number.isFinite(x)&&x>=0?Math.round(x):0;
  function safePath(ref){
    let path='';
    try{
      if(typeof ref.path==='string')path=ref.path;
      else if(ref._query?.path)path=String(ref._query.path.canonicalString?.()||ref._query.path.toString?.()||'');
      else if(ref._delegate?.path)path=String(ref._delegate.path);
    }catch(_){}
    if(!path)return '(неизвестный путь)';
    return path.replace(/^\/+/,'').split('/').slice(0,10).map((part,i)=>i%2?':id':part.replace(/[^a-zA-Z0-9_а-яА-ЯёЁ-]/g,'_').slice(0,65)).join('/');
  }
  const dispatch=()=>{try{window.dispatchEvent(new CustomEvent('firebase-traffic-change'));}catch(_){}};
  const counters=['calls','reads','cached','writes','deletes','failed'];
  function add(a,b,keys){for(const key of keys)a[key]=(a[key]||0)+(b[key]||0);}
  function mergeStored(stored,live){
    const out=structuredClone(stored);
    add(out,live,[...counters,'events','listens','unsubscribes','snapshots','tx','batches']);
    for(const field of ['byType','byPath']){
      out[field]=out[field]||{};
      for(const [key,values] of Object.entries(live[field]||{})){
        if(!out[field][key])out[field][key]=structuredClone(values);
        else add(out[field][key],values,[...counters,'events']);
      }
    }
    if(!out.hours)out.hours=[];
    for(let i=0;i<(live.hours?.length||0);i++){
      if(!out.hours[i])out.hours[i]={calls:0,reads:0,writes:0,deletes:0};
      add(out.hours[i],live.hours[i],['calls','reads','writes','deletes']);
    }
    return out;
  }
  function record(input){
    if(!enabled || document.body?.getAttribute?.('data-release-admin')!=='1')return;
    try{
      const ts=Date.now(),day=quotaDay(ts);
      const e={ts,day,kind:String(input.kind||'other'),path:String(input.path||'(служебное)'),reads:safeNum(input.reads),cached:safeNum(input.cached),writes:safeNum(input.writes),deletes:safeNum(input.deletes),calls:safeNum(input.calls),failed:input.failed?1:0,ms:safeNum(input.ms),source:input.source||'',code:input.code||''};
      const a=loaded.days[day]||(loaded.days[day]=fresh());a.events++;
      add(a,e,counters);
      if(e.kind==='listen')a.listens++;
      if(e.kind==='unlisten')a.unsubscribes++;
      if(e.kind==='snapshot')a.snapshots++;
      if(e.kind==='transaction')a.tx++;
      if(e.kind==='batch')a.batches++;
      for(const [field,key] of [['byType',e.kind],['byPath',e.path]]){
        const o=a[field][key]||(a[field][key]={calls:0,reads:0,cached:0,writes:0,deletes:0,failed:0,events:0});
        o.events++;add(o,e,counters);
      }
      const h=a.hours[hourInPeriod(ts,day)];
      add(h,e,['calls','reads','writes','deletes']);
      loaded.events.push(e);loaded.totalEvents++;dirtyEvents.push(e);
      if(loaded.events.length>MAX_EVENTS)loaded.events.splice(0,loaded.events.length-MAX_EVENTS);
      prune();schedule();dispatch();
    }catch(_){/* Never change Firestore behavior for telemetry. */}
  }
  function prune(){
    const days=Object.keys(loaded.days).sort();
    for(const k of days.slice(0,Math.max(0,days.length-MAX_DAYS)))delete loaded.days[k];
  }
  function openDB(){
    if(dbPromise)return dbPromise;
    dbPromise=new Promise(resolve=>{
      try{
        const r=indexedDB.open('samosval_firebase_traffic_v1',1);
        r.onupgradeneeded=()=>{const db=r.result;db.createObjectStore('daily',{keyPath:'key'});const store=db.createObjectStore('events',{keyPath:'id',autoIncrement:true});store.createIndex('ts','ts');};
        r.onsuccess=()=>resolve(r.result);
        r.onerror=()=>{loaded.persisted=false;loaded.notice='Не удалось открыть IndexedDB';resolve(null);};
        r.onblocked=()=>{loaded.persisted=false;loaded.notice='IndexedDB заблокирована';resolve(null);};
      }catch(_){loaded.persisted=false;loaded.notice='Локальное хранилище недоступно';resolve(null);}
    });
    return dbPromise;
  }
  async function initStore(){
    const db=await openDB();if(!db){loaded.ready=true;dispatch();return;}
    await new Promise(resolve=>{
      try{
        const tx=db.transaction(['daily','events'],'readonly');
        const daily=tx.objectStore('daily').getAll(),recent=tx.objectStore('events').getAll();
        daily.onsuccess=()=>{
          for(const row of daily.result||[]){
            if(row.kind!=='day')continue;
            loaded.days[row.day]=loaded.days[row.day]?mergeStored(row.data,loaded.days[row.day]):row.data;
          }
          prune();
        };
        recent.onsuccess=()=>{
          const old=(recent.result||[]).slice(-MAX_EVENTS);
          const seen=new Set(loaded.events.map(e=>e.ts+'|'+e.kind+'|'+e.path+'|'+e.ms));
          for(const e of old){const key=e.ts+'|'+e.kind+'|'+e.path+'|'+e.ms;if(!seen.has(key))loaded.events.unshift(e);}
          loaded.events.sort((a,b)=>a.ts-b.ts);
          if(loaded.events.length>MAX_EVENTS)loaded.events.splice(0,loaded.events.length-MAX_EVENTS);
        };
        tx.oncomplete=resolve;tx.onerror=resolve;tx.onabort=resolve;
      }catch(_){resolve();}
    });
    loaded.ready=true;if(dirtyEvents.length)schedule();dispatch();
  }
  function schedule(){
    if(flushTimer)return;
    flushTimer=setTimeout(()=>{flushTimer=0;flush().catch(()=>{});},1800);
  }
  async function flush(){
    if(!loaded.ready){schedule();return;}
    if(busy){schedule();return;}
    busy=true;
    const batch=dirtyEvents.splice(0);
    const days=Object.entries(loaded.days).map(([day,data])=>({key:'day:'+day,kind:'day',day,data:JSON.parse(JSON.stringify(data))}));
    const db=await openDB();
    if(!db){busy=false;return;}
    await new Promise(resolve=>{
      try{
        const tx=db.transaction(['daily','events'],'readwrite'),ds=tx.objectStore('daily'),es=tx.objectStore('events');
        const allowed=new Set(days.map(d=>d.key));
        for(const entry of days)ds.put(entry);
        for(const e of batch)es.add(e);
        ds.getAllKeys().onsuccess=function(){
          for(const key of this.result)if(!allowed.has(key))ds.delete(key);
        };
        es.getAllKeys().onsuccess=function(){
          for(const key of this.result.slice(0,Math.max(0,this.result.length+batch.length-MAX_EVENTS)))es.delete(key);
        };
        tx.oncomplete=resolve;
        tx.onerror=()=>{loaded.persisted=false;loaded.notice='Ошибка сохранения на устройстве';dirtyEvents.unshift(...batch);resolve();};
        tx.onabort=()=>{loaded.persisted=false;loaded.notice='Сохранение прервано';dirtyEvents.unshift(...batch);resolve();};
      }catch(_){dirtyEvents.unshift(...batch);resolve();}
    });
    busy=false;if(dirtyEvents.length)schedule();
  }
  function estimate(snap,first){
    const cache=!!snap?.metadata?.fromCache, pending=!!snap?.metadata?.hasPendingWrites;
    let docs=0,changes=0;
    if(typeof snap?.size==='number'){
      docs=safeNum(snap.size);
      if(first)changes=docs||1;
      else if(typeof snap.docChanges==='function'){
        try{changes=snap.docChanges().filter(c=>c.type!=='removed'||c.doc?.exists).length;}catch(_){changes=0;}
      }
    } else {
      docs=snap?.exists?1:0;
      changes=first||snap?.exists?1:0;
    }
    return {reads:cache||pending?0:changes,cached:cache?docs:0,source:cache?'cache':pending?'pending-local':'server-observed'};
  }
  function timedPromise(result,onOK,onErr){
    if(!result||typeof result.then!=='function')return result;
    return result.then(x=>{try{onOK(x);}catch(_){}return x;},err=>{try{onErr(err);}catch(_){}throw err;});
  }
  function errCode(e){return String(e?.code||'unknown').replace(/[^a-z0-9_-]/gi,'').slice(0,40);}
  const seenWrap=new Set(),wraps=[];
  function wrap(proto,name,id,fn){
    if(!proto||typeof proto[name]!=='function'||seenWrap.has(id))return;
    const original=proto[name];
    try{
      proto[name]=function(...args){return fn.call(this,original,args);};
      if(proto[name]!==original){seenWrap.add(id);wraps.push(id);}
    }catch(_){}
  }
  const F=window.firebase?.firestore;
  const queryProto=F?.Query?.prototype,docProto=F?.DocumentReference?.prototype;
  function reads(proto,kind){
    wrap(proto,'get',kind+'.get',function(original,args){
      const path=safePath(this),begin=performance.now();
      let out;
      try{out=original.apply(this,args);}catch(e){record({kind:kind+'.get',path,calls:1,failed:true,code:errCode(e)});throw e;}
      return timedPromise(out,snap=>record({kind:kind+'.get',path,calls:1,ms:performance.now()-begin,...estimate(snap,true)}),
        e=>record({kind:kind+'.get',path,calls:1,failed:true,code:errCode(e),ms:performance.now()-begin}));
    });
    wrap(proto,'onSnapshot',kind+'.onSnapshot',function(original,args){
      const path=safePath(this),begin=performance.now();
      let first=true,active=false;
      const snapshot=s=>{const stats=estimate(s,first);first=false;record({kind:'snapshot',path,...stats,ms:performance.now()-begin});};
      const error=e=>{record({kind:'listen-error',path,failed:true,code:errCode(e)});};
      const at=args.findIndex(v=>typeof v==='function'||(v&&typeof v==='object'&&typeof v.next==='function'));
      if(at>=0){
        const target=args[at];
        if(typeof target==='function') {
          args[at]=function(s){snapshot(s);return target.apply(this,arguments);};
          if(typeof args[at+1]==='function'){const err=args[at+1];args[at+1]=function(e){error(e);return err.apply(this,arguments);};}
        } else {
          args[at]={...target,next:function(s){snapshot(s);return target.next.apply(target,arguments);},error:function(e){error(e);if(typeof target.error==='function')return target.error.apply(target,arguments);}};
        }
      }
      let stop;
      try{stop=original.apply(this,args);}catch(e){record({kind:'listen-error',path,failed:true,calls:1,code:errCode(e)});throw e;}
      if(typeof stop!=='function')return stop;
      loaded.active++;active=true;record({kind:'listen',path,calls:1});
      return function(){if(active){active=false;loaded.active=Math.max(0,loaded.active-1);record({kind:'unlisten',path});}return stop.apply(this,arguments);};
    });
  }
  reads(queryProto,'query');reads(docProto,'document');
  for(const method of ['set','update','delete']){
    wrap(docProto,method,'document.'+method,function(original,args){
      const path=safePath(this),started=performance.now();
      const vals=method==='delete'?{deletes:1}:{writes:1};
      let out;
      try{out=original.apply(this,args);}catch(e){record({kind:'document.'+method,path,calls:1,failed:true,code:errCode(e)});throw e;}
      return timedPromise(out,()=>record({kind:'document.'+method,path,calls:1,ms:performance.now()-started,...vals}),
        e=>record({kind:'document.'+method,path,calls:1,failed:true,code:errCode(e),ms:performance.now()-started}));
    });
  }
  wrap(F?.CollectionReference?.prototype,'add','collection.add',function(original,args){
    const path=safePath(this),started=performance.now();
    let out;try{out=original.apply(this,args);}catch(e){record({kind:'collection.add',path,calls:1,failed:true,code:errCode(e)});throw e;}
    return timedPromise(out,()=>record({kind:'collection.add',path,calls:1,writes:1,ms:performance.now()-started}),
      e=>record({kind:'collection.add',path,calls:1,failed:true,code:errCode(e)}));
  });
  const batches=new WeakMap();
  for(const method of ['set','update','delete']){
    wrap(F?.WriteBatch?.prototype,method,'batch.'+method,function(original,args){
      const out=original.apply(this,args),count=batches.get(this)||{writes:0,deletes:0};
      count[method==='delete'?'deletes':'writes']++;batches.set(this,count);return out;
    });
  }
  wrap(F?.WriteBatch?.prototype,'commit','batch.commit',function(original,args){
    const count=batches.get(this)||{writes:0,deletes:0},started=performance.now();
    let out;try{out=original.apply(this,args);}catch(e){record({kind:'batch',path:'(batch)',calls:1,failed:true,code:errCode(e)});throw e;}
    return timedPromise(out,()=>record({kind:'batch',path:'(batch)',calls:1,...count,ms:performance.now()-started}),
      e=>record({kind:'batch',path:'(batch)',calls:1,failed:true,code:errCode(e)}));
  });
  const trans=new WeakMap();
  for(const method of ['get','set','update','delete']){
    wrap(F?.Transaction?.prototype,method,'transaction.'+method,function(original,args){
      const stats=trans.get(this)||{reads:0,writes:0,deletes:0};
      if(method==='get'){
        let out=original.apply(this,args);
        return timedPromise(out,s=>{stats.reads+=estimate(s,true).reads;trans.set(this,stats);},()=>{});
      }
      const out=original.apply(this,args);
      stats[method==='delete'?'deletes':'writes']++;trans.set(this,stats);return out;
    });
  }
  wrap(F?.Firestore?.prototype,'runTransaction','firestore.runTransaction',function(original,args){
    const callback=args[0],started=performance.now(),path='(transaction)';
    let latest={reads:0,writes:0,deletes:0};
    if(typeof callback==='function')args[0]=function(tx){latest={reads:0,writes:0,deletes:0};trans.set(tx,latest);return callback.apply(this,arguments);};
    let out;try{out=original.apply(this,args);}catch(e){record({kind:'transaction',path,calls:1,failed:true,code:errCode(e)});throw e;}
    return timedPromise(out,()=>record({kind:'transaction',path,calls:1,writes:latest.writes,deletes:latest.deletes,reads:latest.reads,ms:performance.now()-started}),
      e=>record({kind:'transaction',path,calls:1,failed:true,code:errCode(e)}));
  });
  function enableLocal(){if(document.body?.getAttribute?.('data-release-admin')!=='1')return;enabled=true;if(!started){started=true;initStore().catch(()=>{loaded.ready=true;loaded.persisted=false;dispatch();});}}
  function disableLocal(){enabled=false;}
  const api={enableLocal,disableLocal,version:VERSION,free:FREE,data:loaded,quotaDay,today,periodStartUTC,periodHours,mskTime,nextQuotaReset,startMsk,record,flush,hooks:wraps,refresh:dispatch};
  window.FirebaseTraffic=api;
  document.addEventListener('visibilitychange',()=>{if(enabled&&document.visibilityState==='hidden')flush().catch(()=>{});});
  window.addEventListener('pagehide',()=>{if(enabled)flush().catch(()=>{});});
})();