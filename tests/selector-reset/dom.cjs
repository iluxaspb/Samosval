'use strict';
// Actual markup, event handlers, selector and patch-list renderer in JSDOM.
// Not a real-browser, Firebase, deployment or physical-phone acceptance test.
const assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const {read,targets,expectedPatchIds,selectorCode,modalMarkup,trucks}=require('./builtin.cjs');
(async()=>{
  for(const [label,file,shell] of targets){
    const dom=new JSDOM('<!doctype html><button id="open-selector" onclick="openSelectorModal()">Выбрать машины</button>'+modalMarkup(read(shell))+'<div id="tab-admin"><div class="admin-tabs"><button class="admin-tab-btn" onclick="switchAdminTab(\'patches\',this)">Патчи</button></div><div id="admin-sub-patches" class="admin-section"></div></div>',{runScripts:'dangerously',url:'https://selector-test.invalid/'});
    try{
      const w=dom.window,q=selector=>w.document.querySelector(selector),rows=()=>w.document.querySelectorAll('#selectorListContainer .selector-item'),input=q('#truckSearchInput'),modal=q('#selectorModal'),open=()=>q('#open-selector').click(),isOpen=()=>modal.classList.contains('open');
      const fixture={allowed:true,line:['first'],writes:0};w.fixture=fixture;
      w.state={shift:{id:'existing-shift',isActive:true},trucks:structuredClone(trucks)};w.appConfig={testReviewFlags:{selector_reset:false,conflict_author:false,admin_report:true}};
      w.requireEdit=permission=>{assert.equal(permission,'edit_line');return fixture.allowed;};w.hasPermission=()=>fixture.allowed;w.getActiveLineIds=()=>fixture.line;w.escapeHtml=String;w.renderRussianPlate=String;
      w.addTruckToLine=async id=>fixture.line.push(id);w.removeTruckFromLine=async id=>{fixture.line=fixture.line.filter(x=>x!==id);};w.appConfigRef={set:()=>{fixture.writes++;throw Error('Cloud writes prohibited');}};
      w.eval(selectorCode(read(file)));const before=JSON.stringify({state:w.state,flags:w.appConfig.testReviewFlags,line:fixture.line});
      for(const close of ['cross','done','backdrop']){
        open();assert(isOpen());assert.equal(input.value,'');assert.equal(rows().length,3);
        input.value='111';input.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(rows().length,1);assert.match(rows()[0].textContent,/111/);
        input.click();assert(isOpen(),'A content click must not dismiss the dialog');
        if(close==='backdrop')modal.click();else modal.querySelector(close==='cross'?'.btn-del':'.btn-quick').click();
        assert(!isOpen());assert.equal(input.value,'111');open();assert.equal(input.value,'');assert.equal(rows().length,3);modal.querySelector('.btn-del').click();
      }
      assert.equal(JSON.stringify({state:w.state,flags:w.appConfig.testReviewFlags,line:fixture.line}),before);
      input.value='111';fixture.allowed=false;open();assert(!isOpen());assert.equal(input.value,'111');
      fixture.allowed=true;w.state.shift=null;open();assert(!isOpen());assert.equal(input.value,'111');
      w.state.shift={id:'existing-shift',isActive:true};open();assert(isOpen());assert.equal(input.value,'');
      input.value='111';input.dispatchEvent(new w.Event('input'));rows()[0].querySelector('button').click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fixture.line,[]);assert.equal(input.value,'111');
      rows()[0].querySelector('button').click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fixture.line,['first']);assert.equal(input.value,'111');open();assert.equal(input.value,'');
      if(label==='TEST'){
        w.firebaseConfig={projectId:'samosval-offline'};w.canAdmin=()=>true;w.renderAll=()=>{};w.switchAdminTab=()=>{};w.auth={onAuthStateChanged:callback=>callback()};
        for(const source of ['test-review-core','review-config','work-report'])w.eval(read('test-app/src/features/'+source+'.js'));
        assert.equal(q('[data-review-flag="selector_reset"]'),null);assert.deepEqual([...w.document.querySelectorAll('[data-report-id]')].map(el=>el.dataset.reportId),expectedPatchIds);
        assert.equal(w.document.querySelectorAll('[data-review-flag]').length,42);assert.equal(q('[data-review-flag="conflict_author"]').checked,false);assert.equal(q('[data-review-flag="analytics_workdate"]').disabled,false);
      }
      assert.equal(fixture.writes,0);assert.equal(w.appConfig.testReviewFlags.selector_reset,false);
      console.log('PASS DOM '+label+': actual search/input/selection handlers, cross/Done/backdrop cancellation and reopen, permission/shift guards'+(label==='TEST'?', 43 report cards / 42 non-legacy patch toggles retained':''));
    }finally{dom.window.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
