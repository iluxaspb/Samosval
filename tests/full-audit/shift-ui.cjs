const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {fixture}=require('./shift-harness.cjs');

function installUI(env,{animated=true,tabs=['line','report','archive'],actions=null}={}){
  const nodes=new Map(),ctx=env.ctx,errors=[];
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.style={setProperty(){}};this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.textContent='';this.innerHTML='';this.parentElement=null;const classes=new Set();this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value),toggle:(value,force)=>force?classes.add(value):classes.delete(value)};}
    set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
    append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}}
    appendChild(item){this.append(item);return item;}
    prepend(item){item.parentElement=this;this.children.unshift(item);}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(item=>item!==this);nodes.delete(this.id);this.parentElement=null;}
    setAttribute(key,value){this.attributes[key]=value;}
    querySelectorAll(){return [];}
    querySelector(){return null;}
    addEventListener(){}
    getBoundingClientRect(){return {top:0};}
  }
  const container=new Element(),head=new Element('head');
  const ids=['tab-line','tab-report','startShiftContainer','activeShiftContainer','changeObjBtn','selectTrucksBtn','closeShiftBtn','startShiftBtn','trucksLineList','archiveRestoreBtn','archiveDeleteBtn','archiveModal','modalArchiveTitle','modalArchiveBody','shiftDate','headerObject','activeLineCount','totalTrips','totalVolume'];
  for(const id of ids){const item=new Element(id.endsWith('Btn')?'button':'div');item.id=id;container.append(item);}
  const doc={head,createElement:tag=>new Element(tag),getElementById:id=>nodes.get(id)||null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
  Object.assign(ctx,ctx.window);ctx.window=ctx;ctx.document=doc;ctx.settings={cycleMinutes:15,holdLoad:0};ctx.isScrolling=false;
  ctx.hasTabAccess=tab=>tabs.includes(tab);ctx.hasPermission=action=>!actions||actions.includes(action);ctx.requireEdit=ctx.hasPermission;
  ctx.getLogs=()=>ctx.state.logs.filter(log=>log.shiftId===ctx.state.shift?.id);ctx.getActiveLineIds=()=>Object.keys(ctx.state.truckStatus).filter(id=>ctx.state.truckStatus[id].shiftId===ctx.state.shift?.id&&ctx.state.truckStatus[id].onLine);
  ctx.findTruck=()=>null;ctx.escapeHtml=value=>String(value);ctx.resolveUserDisplayName=(email,name)=>name||email||'';
  ctx.localStorage={getItem:()=>null,setItem(){}};ctx.setInterval=()=>1;ctx.clearInterval=()=>{};ctx.setTimeout=()=>1;ctx.clearTimeout=()=>{};
  ctx.MutationObserver=class{observe(){}disconnect(){}};ctx.offlinePendingForTruck=()=>false;
  ctx.console={error:(...args)=>errors.push(args),warn(){},log(){}};
  vm.runInContext(fs.readFileSync('test-app/src/core/21-line-ui.js','utf8'),ctx);
  const baseRender=ctx.renderLine;
  if(animated){vm.runInContext(fs.readFileSync('test-app/src/features/animation-speeds.js','utf8'),ctx);vm.runInContext(fs.readFileSync('test-app/src/features/offline-feedback.js','utf8'),ctx);}
  ctx.renderAll=()=>{ctx.renderHeaderStats();if(ctx.hasTabAccess('line'))ctx.renderLine();};
  env.options.afterCommit=()=>ctx.renderAll();
  const ui={ctx,nodes,container,baseRender,errors,node:id=>nodes.get(id),flag:(name,value)=>vm.runInContext(name+'='+JSON.stringify(value),ctx)};
  return ui;
}
const setupRestore=()=>{
  const env=fixture({active:false});env.seed('archive','a1',{sourceShiftId:'old',objectName:'Object',objectId:'o1',date:'25.10.2026',logs:[{id:'old0',truckId:'t1',truckName:'Truck',volume:12,timestamp:10000,timeStr:'12:00',createdBy:'Author'}],activeLineIds:['t1'],ttnStatus:{t1:'pending'}});env.sync();return env;
};

(async()=>{
  for(const animated of [false,true]){
    const env=fixture(),ui=installUI(env,{animated});ui.ctx.renderAll();assert.equal(ui.node('shiftLifecycleNotice').hidden,true);assert.equal(ui.node('selectTrucksBtn').disabled,false);
    env.seed('shift','current',{...env.read('shift','current'),isActive:false,closing:true});env.sync();ui.ctx.__lineAnimating=true;ui.ctx.renderAll();
    assert.equal(ui.node('shiftLifecycleNotice').hidden,false);assert.match(ui.node('shiftLifecycleTitle').textContent,/Закрытие смены/);assert.equal(ui.node('trucksLineList').hidden,true);assert.equal(ui.node('selectTrucksBtn').style.display,'none');assert.equal(ui.node('changeObjBtn').style.display,'none');assert.equal(ui.node('startShiftBtn').disabled,true);assert.match(ui.node('closeShiftBtn').textContent,/Продолжить/);assert.equal(ui.node('shiftLifecycleRetry').disabled,false);assert.match(ui.node('shiftDate').textContent,/Закрытие/);
    assert.equal(ui.node('shiftLifecycleNotice').parentElement,ui.node('tab-line').parentElement,'notice remains accessible outside the active tab');
    ui.flag('closeShiftInFlight',true);ui.ctx.renderLine();assert(ui.node('shiftLifecycleRetry').disabled);ui.flag('closeShiftInFlight',false);
    env.seed('shift','current',{id:'restore',isActive:false,restoring:true,restoredFrom:'a1'});env.sync();ui.ctx.renderAll();assert.match(ui.node('shiftLifecycleTitle').textContent,/Восстановление/);assert.match(ui.node('shiftLifecycleRetry').textContent,/восстановление/);assert.equal(ui.node('closeShiftBtn').style.display,'none');assert.match(ui.node('shiftDate').textContent,/Восстановление/);
    env.seed('shift','current',{id:'restore',isActive:true});env.sync();ui.ctx.__lineAnimating=false;ui.ctx.renderAll();assert(ui.node('shiftLifecycleNotice').hidden);assert.equal(ui.node('trucksLineList').hidden,false);assert.equal(ui.node('selectTrucksBtn').disabled,false);assert.equal(ui.node('closeShiftBtn').textContent,'🔄 Закрыть смену');
    env.mutate(env.path('shift','current'));env.sync();ui.ctx.renderAll();assert.equal(ui.node('startShiftContainer').style.display,'block');assert.equal(ui.node('startShiftBtn').disabled,false);assert.equal(ui.node('activeShiftContainer').style.display,'none');
    console.log('PASS shift UI: active/closing/restoring/finished controls and retry in '+(animated?'effective animation + offline wrappers':'base renderer'));
  }
  const env=fixture({failCleanupChunk:1}),ui=installUI(env);ui.ctx.renderAll();await env.close();assert(env.read('shift','current').closing);assert.equal(ui.node('shiftLifecycleRetry').disabled,false,'finally enables retry after failed request');assert.match(ui.node('shiftLifecycleTitle').textContent,/не завершено/);await ui.node('shiftLifecycleRetry').onclick();assert.equal(env.read('shift','current'),undefined);assert(ui.node('shiftLifecycleNotice').hidden);console.log('PASS shift UI: actual close failure leaves visible enabled retry and clicking it completes closure');

  const restored=setupRestore(),restoreUI=installUI(restored,{tabs:['report','archive']});restored.options.failRestoreChunk=1;await restored.restore();assert(restored.read('shift','current').restoring);assert.equal(restoreUI.node('shiftLifecycleRetry').disabled,false);assert.match(restoreUI.node('archiveRestoreBtn').textContent,/Продолжить/);
  // The source archive can be absent from the cache while the server still has it.
  restoreUI.ctx.state.archive=[];await restoreUI.node('shiftLifecycleRetry').onclick();assert.equal(restored.read('shift','current').isActive,true);assert.equal(restored.read('archive','a1'),undefined);assert(restoreUI.node('shiftLifecycleNotice').hidden);console.log('PASS shift UI: actual restore retry works from report access and reloads a missing archive cache');

  const readonly=fixture(),readUI=installUI(readonly,{actions:[]});readonly.seed('shift','current',{id:'s1',isActive:false,closing:true});readonly.sync();readUI.ctx.renderAll();assert(readUI.node('shiftLifecycleRetry').hidden);assert.equal(readUI.node('shiftLifecycleRetry').style.display,'none','inline hiding survives .btn display:flex');assert.equal(readUI.node('closeShiftBtn').style.display,'none');assert.match(readUI.node('shiftLifecycleMessage').textContent,/доступом/);
  let actions=0;readUI.ctx.requireEdit=()=>true;readUI.ctx.executeAction=()=>actions++;readUI.ctx.startHold({currentTarget:readUI.node('selectTrucksBtn')},'load','t1');assert.equal(actions,0,'a stale pointer event cannot act on a frozen shift');console.log('PASS shift UI: permissions hide retry and frozen pointer actions are rejected');

  const missing=fixture({active:false}),missingUI=installUI(missing);missing.seed('shift','current',{id:'restored_missing',isActive:false,restoring:true,restoredFrom:'missing'});missing.sync();missingUI.ctx.renderAll();await missingUI.node('shiftLifecycleRetry').onclick();assert.match(missing.errors.at(-1),/Исходный архив не найден/);assert.equal(missingUI.node('shiftLifecycleRetry').disabled,false);assert(missing.read('shift','current').restoring);console.log('PASS shift UI: absent source reports an error and leaves retry usable without changing data');
  console.log('6/6 shift UI groups passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
