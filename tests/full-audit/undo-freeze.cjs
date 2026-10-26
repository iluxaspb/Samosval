const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const historySource=fs.readFileSync('test-app/src/features/undo-redo.js','utf8');
const historyBlock=historySource.slice(historySource.indexOf('  function allowedHistory'),historySource.indexOf('  function updateLocalState'));
const quickSource=fs.readFileSync('test-app/src/core/25-undo-audit.js','utf8');
const quickBlock=quickSource.slice(0,quickSource.indexOf('  async function addAudit'));
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const ref=path=>({path});
function fixture(shift,{beforeCommit}={}){
  const rows=new Map(),versions=new Map(),commits=[],errors=[];let retries=0;
  const put=(path,value)=>{if(value===undefined)rows.delete(path);else rows.set(path,copy(value));versions.set(path,(versions.get(path)||0)+1);};
  const get=path=>copy(rows.get(path));
  put('shift/current',shift);
  const run=async callback=>{
    for(let attempt=0;attempt<5;attempt++){
      const reads=new Map(),writes=[];
      const tx={get:async r=>{assert.equal(writes.length,0,'All reads precede writes');reads.set(r.path,versions.get(r.path)||0);const data=get(r.path);return {exists:data!==undefined,data:()=>copy(data)};},set:(r,data)=>writes.push({kind:'set',path:r.path,data:copy(data)}),update:(r,data)=>writes.push({kind:'update',path:r.path,data:copy(data)}),delete:r=>writes.push({kind:'delete',path:r.path})};
      const result=await callback(tx);
      if(beforeCommit)await beforeCommit({attempt,writes,put,get});
      if([...reads].some(([path,version])=>(versions.get(path)||0)!==version)){retries++;continue;}
      for(const write of writes)put(write.path,write.kind==='delete'?undefined:write.kind==='update'?{...get(write.path),...write.data}:write.data);
      if(writes.length)commits.push(copy(writes));return result;
    }
    throw Error('Retry limit');
  };
  const refs={shift:ref('shift/current')};
  for(const name of ['logs','truckStatus','archive','notifications','audit','objects'])refs[name]={doc:id=>ref(name+'/'+id)};
  const ctx={currentUid:'operator',currentUserRole:'admin',currentEmail:'operator@example.test',hasPermission:()=>true,refs,db:{runTransaction:run,collection:name=>({doc:id=>ref(name+'/'+id)})},window:{__historyRawTransaction:run,__gameHistoryPenaltyKey:()=> 'penalty',__gameCoinsCore:{scopeFor:()=>({})},__gamePenaltyKey:()=> 'penalty',__gamePenaltyScope:()=>({}),__gameStagePenalty:async tx=>{await tx.get(ref('penalty'));return ()=>tx.set(ref('penalty'),{charged:true});}}};
  vm.createContext(ctx);vm.runInContext(historyBlock,ctx);
  const seedAction=(op,direction='before')=>{
    const action={id:'h',userEmail:ctx.currentEmail,user:'Operator',description:'fixture',operations:[copy(op)],undone:direction==='after'};
    put('audit/h',{history:action});
    const current=op[direction==='before'?'after':'before'];put(op.collection==='shift'?'shift/current':op.collection+'/'+op.id,current===null?undefined:current);
    return action;
  };
  return {ctx,rows,get,put,commits,errors,seedAction,retries:()=>retries};
}
const active={id:'s',isActive:true};
const closing={...active,isActive:false,closing:true,closeArchiveId:'closed_s'};
const restoring={...active,isActive:false,restoring:true,restoredFrom:'a1'};
const log={shiftId:'s',truckId:'t1',volume:12};
const statusBefore={shiftId:'s',ttnStatus:null,ttnBy:null,ttnLogId:null,ttnRevision:1,cycleRevision:3};
const statusAfter={...statusBefore,ttnStatus:true,ttnBy:'Operator',ttnLogId:'l1',ttnRevision:2};
const tests=[];const test=(name,fn)=>tests.push({name,fn});
async function blocked(shift,op,direction='before'){
  const e=fixture(shift),action=e.seedAction(op,direction);e.put('shift/current',shift);
  const before=copy([...e.rows]);
  await assert.rejects(()=>e.ctx.applyHistoryOperations([op],direction,action),/закрывается или восстанавливается/);
  assert.deepEqual([...e.rows],before);assert.equal(e.commits.length,0);assert.equal(e.get('penalty'),undefined);
}
test('Closing and restoring block undo of current trip creation',async()=>{
  for(const shift of [closing,restoring])await blocked(shift,{collection:'logs',id:'l1',before:null,after:log});
});
test('Restoring blocks redo of a chunk whose current trip is still absent',async()=>{
  await blocked(restoring,{collection:'logs',id:'l1',before:null,after:log},'after');
});
test('Closing blocks both TTN undo and redo without charging a penalty',async()=>{
  const op={collection:'truckStatus',id:'t1',before:statusBefore,after:statusAfter};
  await blocked(closing,op);await blocked(closing,op,'after');
});
test('History cannot undo closing or the workspace reservation used by restore',async()=>{
  await blocked(closing,{collection:'shift',id:'current',before:active,after:closing});
  await blocked(restoring,{collection:'shift',id:'current',before:null,after:restoring});
});
test('Closing protects its deterministic archive; restoring protects the source archive',async()=>{
  await blocked(closing,{collection:'archive',id:'closed_s',before:null,after:{sourceShiftId:'s',logs:[log]}});
  await blocked(restoring,{collection:'archive',id:'a1',before:null,after:{sourceShiftId:'old',logs:[log]}});
  await blocked(restoring,{collection:'archive',id:'a1',before:{sourceShiftId:'old',logs:[log]},after:null});
});
test('A concurrent freeze invalidates history transaction and preserves trip/history/penalty',async()=>{
  let injected=false;
  const e=fixture(active,{beforeCommit:({put})=>{if(!injected){injected=true;put('shift/current',closing);}}});
  const op={collection:'logs',id:'l1',before:null,after:log},action=e.seedAction(op);
  await assert.rejects(()=>e.ctx.applyHistoryOperations([op],'before',action),/закрывается или восстанавливается/);
  assert.equal(e.retries(),1);assert.deepEqual(e.get('logs/l1'),log);assert.equal(e.get('audit/h').history.undone,false);assert.equal(e.get('penalty'),undefined);assert.equal(e.commits.length,0);
});
test('Unrelated archive history still works while a different shift is frozen',async()=>{
  const e=fixture(closing),data={sourceShiftId:'old',logs:[]},op={collection:'archive',id:'unrelated',before:null,after:data},action=e.seedAction(op);
  await e.ctx.applyHistoryOperations([op],'before',action);
  assert.equal(e.get('archive/unrelated'),undefined);assert.equal(e.get('audit/h').history.undone,true);assert.deepEqual(e.get('shift/current'),closing);
});
test('Normal TTN undo and redo preserve cycle revision and independently increment TTN revision',async()=>{
  const e=fixture(active),op={collection:'truckStatus',id:'t1',before:statusBefore,after:statusAfter},action=e.seedAction(op);
  await e.ctx.applyHistoryOperations([op],'before',action);assert.equal(e.get('truckStatus/t1').ttnStatus,null);assert.equal(e.get('truckStatus/t1').ttnRevision,3);assert.equal(e.get('truckStatus/t1').cycleRevision,3);
  await e.ctx.applyHistoryOperations([op],'after',{...action,undone:true});assert.equal(e.get('truckStatus/t1').ttnStatus,true);assert.equal(e.get('truckStatus/t1').ttnRevision,4);assert.equal(e.get('truckStatus/t1').cycleRevision,3);
});
function quickFixture(shift,options){
  const e=fixture(shift,options),notification={id:'n1',type:'ttn',truckId:'t1',createdByEmail:e.ctx.currentEmail,afterStatus:copy(statusAfter),prevTtn:null,prevTtnBy:null,prevTtnLogId:null};
  e.put('truckStatus/t1',statusAfter);e.put('notifications/n1',notification);
  Object.assign(e.ctx,{state:{shift:copy(active),truckStatus:{t1:copy(statusAfter)},logs:[],notifications:[copy(notification)]},lastValidNotification:()=>notification,appConfirm:async()=>true,pendingStart(){},pendingEnd(){},truckStatusWrites:{},truckServerRevisions:{},truckName:()=> 'Truck',signalLineTransition(){},syncState:{errors:{}},saveCache(){},renderAll(){},addAudit:async()=>{},showToastEl(){},escapeHtml:String,reportSyncError(){},showError:message=>e.errors.push(message)});
  vm.runInContext(quickBlock,e.ctx);return e;
}
test('Quick notification undo blocks closing/restoring and does not trust stale active UI',async()=>{
  for(const shift of [closing,restoring]){const e=quickFixture(shift);await e.ctx.undoLastAction();assert.match(e.errors[0],/Смена закрывается/);assert.deepEqual(e.get('truckStatus/t1'),statusAfter);assert(e.get('notifications/n1'));assert.equal(e.commits.length,0);}
});
test('Quick undo races with freeze safely and still works in an active shift',async()=>{
  let injected=false;const e=quickFixture(active,{beforeCommit:({put})=>{if(!injected){injected=true;put('shift/current',restoring);}}});
  await e.ctx.undoLastAction();assert.equal(e.retries(),1);assert.match(e.errors[0],/Смена закрывается/);assert.deepEqual(e.get('truckStatus/t1'),statusAfter);assert(e.get('notifications/n1'));assert.equal(e.commits.length,0);
  const normal=quickFixture(active);await normal.ctx.undoLastAction();assert.deepEqual(normal.errors,[]);assert.equal(normal.get('truckStatus/t1').ttnStatus,null);assert.equal(normal.get('truckStatus/t1').ttnRevision,3);assert.equal(normal.get('notifications/n1'),undefined);
});
(async()=>{let failed=0;for(const {name,fn}of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name,error);}}console.log(`${tests.length-failed}/${tests.length} undo freeze regressions passed`);if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
