const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const prefix='workspaces/test/';
const path=(collection,id)=>prefix+collection+'/'+id;
const shiftPath=path('shift','current');

// In-memory optimistic Firestore transactions, including actual history-recorder.js.
// No Firebase credentials, external network, or production files are used.
function fixture(options={}) {
  const rows=new Map(),versions=new Map(),errors=[],commits=[],events=[],contexts=[];
  let cleanupCount=0,restoreCount=0,archiveSets=0,maxCalls=0,confirms=0;
  const mutate=(p,data)=>{if(data===undefined)rows.delete(p);else rows.set(p,clone(data));versions.set(p,(versions.get(p)||0)+1);};
  const seed=(collection,id,data)=>mutate(path(collection,id),data);
  const read=(collection,id)=>clone(rows.get(path(collection,id)));
  const selected=(collection,shiftId)=>[...rows.entries()].filter(([p,data])=>p.startsWith(prefix+collection+'/')&&(!shiftId||data.shiftId===shiftId)).map(([p,data])=>({id:p.split('/').at(-1),...clone(data)}));
  const sync=()=>contexts.forEach(ctx=>{
    ctx.state.shift=clone(rows.get(shiftPath))||null;
    ctx.state.archive=selected('archive');ctx.state.logs=selected('logs');
    ctx.state.truckStatus=Object.fromEntries(selected('truckStatus').map(item=>[item.id,item]));
  });
  let db,env;
  class Ref {
    constructor(p){this.path=p;this.id=p.split('/').at(-1);this.firestore=db;}
    async get(opts){assert.equal(opts?.source,'server');const result=snapshot(this.path);if(options.afterOutsideRead)await options.afterOutsideRead(this.path,env);return result;}
    async set(data){mutate(this.path,data);sync();}
    async update(data){assert(rows.has(this.path));mutate(this.path,{...rows.get(this.path),...data});sync();}
    async delete(){mutate(this.path);sync();}
  }
  const snapshot=p=>{const value=clone(rows.get(p));return {id:p.split('/').at(-1),ref:new Ref(p),exists:rows.has(p),data:()=>clone(value)};};
  class Collection {
    constructor(name){this.name=name;}
    doc(id){return new Ref(path(this.name,id||'auto_'+webcrypto.randomUUID()));}
    async add(data){const ref=this.doc();await ref.set(data);return ref;}
    async get(opts){assert.equal(opts?.source,'server');const docs=[...rows.keys()].filter(p=>p.startsWith(prefix+this.name+'/')).map(snapshot);if(options.afterCollectionRead)await options.afterCollectionRead(this.name,env);return {docs,size:docs.length,forEach:fn=>docs.forEach(fn)};}
  }
  db={
    async runTransaction(callback){
      for(let attempt=0;attempt<8;attempt++){
        const reads=new Map(),readSnapshots=new Map(),writes=[];
        const tx={
          async get(ref){assert.equal(writes.length,0,'Firestore transactions require all reads before writes');if(!reads.has(ref.path)){reads.set(ref.path,versions.get(ref.path)||0);readSnapshots.set(ref.path,snapshot(ref.path));}return readSnapshots.get(ref.path);},
          set(ref,data){writes.push({method:'set',path:ref.path,data:clone(data)});return tx;},
          update(ref,data){writes.push({method:'update',path:ref.path,data:clone(data)});return tx;},
          delete(ref){writes.push({method:'delete',path:ref.path});return tx;}
        };
        const result=await callback(tx);
        if(options.beforeCommit)await options.beforeCommit({reads,writes,attempt},env);
        if([...reads].some(([p,version])=>(versions.get(p)||0)!==version)){events.push('conflict-retry');continue;}
        const business=writes.filter(write=>!write.path.startsWith(prefix+'audit/'));
        const cleanup=business.some(write=>write.method==='delete'&&/\/(logs|truckStatus)\//.test(write.path));
        const restore=business.some(write=>write.method==='set'&&/\/(logs|truckStatus)\//.test(write.path));
        const archive=business.some(write=>write.method==='set'&&write.path.startsWith(prefix+'archive/'));
        const finalRestore=business.some(write=>write.method==='delete'&&write.path.startsWith(prefix+'archive/'));
        if(cleanup&&++cleanupCount===options.failCleanupChunk)throw Error('Injected cleanup interruption');
        if(restore&&++restoreCount===options.failRestoreChunk)throw Error('Injected restore interruption');
        if(archive&&options.failArchive){options.failArchive=false;throw Error('Injected archive failure');}
        if(finalRestore&&options.failFinalRestore){options.failFinalRestore=false;throw Error('Injected final restore failure');}
        assert(writes.length<=500,'Firestore write limit');
        if(options.role!=='admin'&&options.role)assert(business.length<=4,'Non-admin history write limit');
        for(const write of writes){
          if(write.method==='delete')mutate(write.path);
          else if(write.method==='update'){assert(rows.has(write.path));mutate(write.path,{...rows.get(write.path),...write.data});}
          else mutate(write.path,write.data);
        }
        if(archive)archiveSets++;
        if(business.length)commits.push({business:clone(business),history:clone(writes.filter(write=>write.path.startsWith(prefix+'audit/')))});
        if(cleanup)events.push('cleanup');if(archive)events.push('archive');
        if(business.some(write=>write.data?.closing))events.push('freeze');
        if(business.some(write=>write.data?.restoring))events.push('restoring');
        if(finalRestore)events.push('activate');
        sync();if(options.afterCommit)await options.afterCommit({business,writes},env);return result;
      }
      throw Error('Transaction conflict retry limit');
    },
    batch(){const writes=[],batch={set:(...args)=>(writes.push(['set',args]),batch),update:(...args)=>(writes.push(['update',args]),batch),delete:(...args)=>(writes.push(['delete',args]),batch),commit:()=>db.runTransaction(tx=>writes.forEach(([method,args])=>tx[method](...args)))};return batch;}
  };
  const refs=Object.fromEntries(['logs','truckStatus','archive','trucks','objects','audit','trash','notifications'].map(name=>[name,new Collection(name)]));refs.shift=new Ref(shiftPath);
  const log=i=>({shiftId:'s1',truckId:'t1',truckName:'Truck',volume:12,timestamp:10000+i*100,arrivalTimestamp:9990+i*100,timeStr:'12:00',createdBy:'Operator',createdByEmail:'operator@example.test',isGAI:false,comment:''});
  if(options.active!==false){seed('shift','current',{id:'s1',isActive:true,objectName:'Object',objectId:'o1',startDate:'25.10.2026'});for(let i=0;i<(options.count??3);i++)seed('logs','l'+i,log(i));seed('truckStatus','t1',{id:'t1',shiftId:'s1',onLine:true,ttnStatus:'pending',arriveTimestamp:null,arriveStatus:null,lastLoadLogId:'l'+((options.count??3)-1),lastLoadTimestamp:10000+((options.count??3)-1)*100,loadedAfterArrive:true});}
  seed('logs','foreign',{shiftId:'s2',truckId:'foreign',volume:99,timestamp:3000});seed('truckStatus','foreign',{id:'foreign',shiftId:'s2',onLine:true});
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:id,disabled:false,value:'',style:{},classList:{remove(){},add(){}}});return nodes.get(id);};
  const makeContext=()=>{
    const ctx={db,refs,wsRef:{collection:name=>new Collection(name)},currentUserRole:options.role||'admin',currentUid:'operator',currentEmail:'operator@example.test',currentUserStatus:'active',WORKSPACE_ID:'test',
      state:{shift:null,logs:[],truckStatus:{},archive:[],objects:[]},viewingArchiveId:null,window:{},
      isNasRuntime:()=>false,requireEdit:()=>true,hasPermission:()=>true,hasTabAccess:()=>true,offlinePendingCount:()=>options.pending||0,
      document:{getElementById:node},appConfirm:async()=>{confirms++;if(options.onConfirm)await options.onConfirm(env);return options.confirm!==false;},
      getLogs:()=>ctx.state.logs.filter(log=>log.shiftId===ctx.state.shift?.id),tfAwait:promise=>promise,getUserName:()=> 'Operator',nowDateStr:()=> '25.10.2026',
      showError:message=>errors.push(message),appNotice:message=>errors.push(message),showToastEl:message=>events.push(message),
      addAudit:async()=>{},clearAllNotifications:async()=>{},offlineProjectState(){},renderAll(){},
      sendShiftReportToMax:()=>{maxCalls++;return new Promise(()=>{});},enqueueMax(){},appConfig:{maxEnabled:true,maxUrl:'https://unused.invalid',notifyStart:true},
      crypto:webcrypto,TextEncoder,Uint8Array,Blob,console:{error(){},warn(){}},Date,Math,Map,Set,JSON,setTimeout,clearTimeout};
    for(const key of ['ObjectPhotos','__attachArchivePhotos'])Object.defineProperty(ctx.window,key,{get(){throw Error('Removed photo service must not be accessed: '+key);}});
    vm.createContext(ctx);contexts.push(ctx);sync();
    // Install the real wrapper once on this shared mock Firestore instance.
    if(contexts.length===1)vm.runInContext(fs.readFileSync('test-app/src/features/history-recorder.js','utf8'),ctx);
    if(options.shiftSource){
      ctx.__loadMaterials=options.materialLoader;ctx.URL=URL;ctx.document.baseURI='https://example.test/';ctx.firebaseConfig={projectId:'samosval-offline'};
      vm.runInContext(fs.readFileSync(options.shiftSource,'utf8').replace("await import(new URL('./test-app/tabel-v2/material-transfer.mjs',document.baseURI).href)","await __loadMaterials()"),ctx);
    }else vm.runInContext(fs.readFileSync('test-app/src/core/18-shifts.js','utf8'),ctx);
    vm.runInContext(fs.readFileSync('test-app/src/core/14-archive.js','utf8'),ctx);
    return ctx;
  };
  env={rows,options,seed,read,selected,mutate,sync,errors,commits,events,refs,path,log,makeContext,stats:()=>({cleanupCount,restoreCount,archiveSets,maxCalls,confirms}),node};
  env.ctx=makeContext();
  env.run=async(fn)=>{let timer;try{return await Promise.race([fn(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Operation hung')),3000))]);}finally{clearTimeout(timer);}};
  env.close=ctx=>env.run(()=>(ctx||env.ctx).closeShift());
  env.restore=(id='a1',ctx=env.ctx)=>{sync();ctx.viewingArchiveId=id;return env.run(()=>ctx.restoreArchiveToShift());};
  return env;
}
module.exports={fixture,clone,path,shiftPath};
