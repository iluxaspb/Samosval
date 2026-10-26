'use strict';
// Isolated real-browser UI harness: actual selector functions/markup and TEST
// patch-list renderer. No whole-app startup, Firebase, emulator or live traffic.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {read,targets,expectedPatchIds,selectorCode,modalMarkup,trucks}=require('./builtin.cjs');
(async()=>{
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.SELECTOR_BROWSER?{executablePath:process.env.SELECTOR_BROWSER}:{})});
  try{
    for(const [label,file,shell] of targets)for(const width of [390,1280]){
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      const requested=[];await context.route('**/*',route=>{requested.push(route.request().url());return route.abort();});
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.setContent('<!doctype html><meta charset="utf-8"><style>.modal{display:none;position:fixed;inset:40px 0 0;background:#ddd}.modal.open{display:block}.modal-content{max-width:600px;padding:16px;background:white}button,input{min-height:35px}</style><button id="open-selector" onclick="openSelectorModal()">Выбрать машины</button>'+modalMarkup(read(shell))+'<div id="tab-admin"><div class="admin-tabs"><button class="admin-tab-btn" onclick="switchAdminTab(\'patches\',this)">Патчи</button></div><div id="admin-sub-patches" class="admin-section"></div></div>');
      await page.evaluate(trucks=>{
        window.fixture={allowed:true,line:['first'],writes:0,guardCalls:[]};
        window.state={shift:{id:'existing-shift',isActive:true},trucks};
        window.appConfig={testReviewFlags:{selector_reset:false,conflict_author:false,admin_report:true}};
        window.requireEdit=permission=>{fixture.guardCalls.push(permission);return fixture.allowed;};window.hasPermission=()=>fixture.allowed;window.getActiveLineIds=()=>fixture.line;
        window.escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.renderRussianPlate=escapeHtml;
        window.addTruckToLine=async id=>fixture.line.push(id);window.removeTruckFromLine=async id=>{fixture.line=fixture.line.filter(x=>x!==id);};
        window.appConfigRef={set:()=>{fixture.writes++;throw Error('Cloud writes prohibited');}};
        window.firebaseConfig={projectId:'samosval-offline'};window.canAdmin=()=>true;window.renderAll=()=>{};window.switchAdminTab=()=>{};window.auth={onAuthStateChanged:callback=>callback()};
      },trucks);
      await page.addScriptTag({content:selectorCode(read(file))});
      const input=page.locator('#truckSearchInput'),modal=page.locator('#selectorModal'),rows=page.locator('#selectorListContainer .selector-item');
      const before=await page.evaluate(()=>JSON.stringify({state,flags:appConfig.testReviewFlags,line:fixture.line}));
      for(const close of ['cross','done','backdrop']){
        await page.locator('#open-selector').click();assert(await modal.isVisible());assert.equal(await input.inputValue(),'');assert.equal(await rows.count(),3);
        await input.fill('111');assert.equal(await rows.count(),1);assert.match(await rows.first().innerText(),/111/);
        assert(await modal.isVisible(),'Typing within content must not dismiss modal');
        if(close==='backdrop')await modal.dispatchEvent('click');else await modal.locator('button').filter({hasText:close==='cross'?'✕':'Готово'}).click();
        assert(!(await modal.isVisible()));assert.equal(await input.inputValue(),'111','Dismissal itself must not change query');
        await page.locator('#open-selector').click();assert.equal(await input.inputValue(),'');assert.equal(await rows.count(),3);await modal.locator('button').filter({hasText:'✕'}).click();
      }
      assert.equal(await page.evaluate(()=>JSON.stringify({state,flags:appConfig.testReviewFlags,line:fixture.line})),before);
      await page.evaluate(()=>{document.getElementById('truckSearchInput').value='111';fixture.allowed=false;});
      await page.locator('#open-selector').click();assert(!(await modal.isVisible()));assert.equal(await input.inputValue(),'111');
      await page.evaluate(()=>{fixture.allowed=true;state.shift=null;});await page.locator('#open-selector').click();assert(!(await modal.isVisible()));assert.equal(await input.inputValue(),'111');
      await page.evaluate(()=>{state.shift={id:'existing-shift',isActive:true};});await page.locator('#open-selector').click();assert.equal(await input.inputValue(),'');
      await input.fill('111');await rows.first().locator('button').click();assert.equal(await input.inputValue(),'111');assert.deepEqual(await page.evaluate(()=>fixture.line),[]);await rows.first().locator('button').click();assert.deepEqual(await page.evaluate(()=>fixture.line),['first']);
      // Repeated programmatic open uses the same button target function.
      await page.evaluate(()=>openSelectorModal());assert.equal(await input.inputValue(),'');await modal.locator('button').filter({hasText:'Готово'}).click();
      if(label==='TEST'){
        for(const source of ['test-review-core','review-config','work-report'])await page.addScriptTag({content:read('test-app/src/features/'+source+'.js')});
        assert.equal(await page.locator('[data-review-flag="selector_reset"]').count(),0);
        assert.deepEqual(await page.locator('[data-report-id]').evaluateAll(els=>els.map(el=>el.dataset.reportId)),expectedPatchIds);
        assert.equal(await page.locator('[data-review-flag]').count(),42,'All non-legacy unrelated patch toggles must remain');
        assert.equal(await page.locator('[data-review-flag="conflict_author"]').isChecked(),false);
        assert.equal(await page.locator('[data-review-flag="analytics_workdate"]').isEnabled(),true);
      }
      assert.equal(await page.evaluate(()=>fixture.writes),0);assert.deepEqual(requested,[]);assert.deepEqual(errors,[]);
      console.log('PASS browser '+label+' '+width+'px: saved false flag, 111 filtering, cross/Done/backdrop/reopen, repeated open, permission/shift denial, selection preserved'+(label==='TEST'?', all unrelated patch rows remain':''));
      await context.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
