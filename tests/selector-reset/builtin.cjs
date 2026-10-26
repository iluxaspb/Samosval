'use strict';
// Local function/DOM model; no application startup, network, Firebase or builds.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const expectedPatchIds=['object_summary','summary_colors','standard_crew','mill_directory','equipment_tiles','equipment_frequency','inline_create','hired_single','truck_participation','shift_material','conflict_author','archive_groups','archive_search','archive_fullscreen','archive_no_drawing','archive_no_pdf','archive_png','archive_controls','archive_hold','security_ui','analytics_layout','analytics_workdate','analytics_audit','analytics_methods','user_ranking','game_mode','game_penalties','admin_report','senior_foreman_role','senior_foreman_reset','senior_foreman_crown','admin_tired_icon','shift_cycle','truck_ranking','tables_editor','tables_format','tables_formula','tables_symbols','tables_access','tables_history','offline_integrity','sync_review','weekly_1c'];
const targets=[['TEST','test-app/src/core/15-directory-views.js','test-app/src/shell.html'],['production','index.html','index.html']];
function selectorCode(source){
  const begin=source.indexOf('  function renderSelectorList()'),end=source.indexOf('  function renderGlobalTrucksManage()',begin);
  assert(begin>=0&&end>begin,'Selector functions must exist exactly once');
  assert.equal((source.match(/function openSelectorModal\(/g)||[]).length,1);
  return source.slice(begin,end);
}
function modalMarkup(source){
  const begin=source.indexOf('<div id="selectorModal"'),end=source.indexOf('<div id="editLogModal"',begin);
  assert(begin>=0&&end>begin,'Actual selector markup must exist');return source.slice(begin,end);
}
const trucks=[{id:'first',brand:'КАМАЗ',number:'А111АА',isGAI:false},{id:'second',brand:'МАЗ',number:'В222ВВ',isGAI:true},{id:'third',brand:'VOLVO',number:'С333СС',isGAI:false}];
async function exercise(label,file){
  for(const savedFlag of [false,true,undefined]){
    const events=[],classes=new Set(),input={value:'111'},container={_html:'',get innerHTML(){return this._html;},set innerHTML(value){events.push(['render',input.value]);this._html=value;}},modal={classList:{add:v=>{events.push(['open',input.value]);classes.add(v);},remove:v=>classes.delete(v)}};
    const flags={conflict_author:false,admin_report:true,...(savedFlag===undefined?{}:{selector_reset:savedFlag})};
    let allowed=true,active=['first'];
    const state={shift:{id:'existing-shift',isActive:true},trucks:structuredClone(trucks)};
    const context={state,appConfig:{testReviewFlags:flags},document:{getElementById:id=>({truckSearchInput:input,selectorModal:modal,selectorListContainer:container}[id]||null)},requireEdit:permission=>{events.push(['guard',permission]);return allowed;},hasPermission:()=>allowed,getActiveLineIds:()=>active,escapeHtml:String,renderRussianPlate:String,addTruckToLine:async id=>{active.push(id);},removeTruckFromLine:async id=>{active=active.filter(value=>value!==id);}};
    // Any accidental cloud/config write fails rather than hitting a service.
    context.refs=context.appConfigRef=new Proxy({},{get(){throw Error('Unexpected database access');}});
    vm.createContext(context);vm.runInContext(selectorCode(read(file)),context,{filename:file});
    const before=JSON.stringify({state,flags});
    context.openSelectorModal();assert.equal(input.value,'');assert(classes.has('open'));
    assert.deepEqual(events.slice(0,3),[['guard','edit_line'],['open',''],['render','']]);
    assert.equal((container.innerHTML.match(/class="selector-item"/g)||[]).length,3);
    assert.match(container.innerHTML,/toggleLineTruck\('first'\).*?Убрать/);
    assert.match(container.innerHTML,/toggleLineTruck\('second'\).*?Добавить/);
    // Search still filters normally while open; reopening only resets query.
    input.value='111';context.renderSelectorList();assert.equal((container.innerHTML.match(/class="selector-item"/g)||[]).length,1);assert(!container.innerHTML.includes('В222ВВ'));
    context.closeSelectorModal();assert(!classes.has('open'));assert.equal(input.value,'111');
    context.openSelectorModal();assert.equal(input.value,'');assert.equal((container.innerHTML.match(/class="selector-item"/g)||[]).length,3);
    input.value='111';context.openSelectorModal();assert.equal(input.value,'','Repeated opening must reset too');
    assert.equal(JSON.stringify({state,flags}),before,'Opening/closing must not change shift, directory or stored flags');assert.deepEqual(active,['first']);
    // Authorized state is checked before changing either query or dialog.
    context.closeSelectorModal();input.value='111';allowed=false;events.length=0;const rendered=container.innerHTML;
    context.openSelectorModal();assert.equal(input.value,'111');assert(!classes.has('open'));assert.equal(container.innerHTML,rendered);assert.deepEqual(events,[['guard','edit_line']]);
    allowed=true;state.shift=null;events.length=0;context.openSelectorModal();assert.equal(input.value,'111');assert(!classes.has('open'));assert.deepEqual(events,[['guard','edit_line']]);
    state.shift={id:'existing-shift',isActive:true};context.openSelectorModal();assert.equal(input.value,'');
    // Selection/removal is still immediate and does not clear the current search.
    input.value='111';await context.toggleLineTruck('first');assert.deepEqual(active,[]);assert.equal(input.value,'111');await context.toggleLineTruck('first');assert.deepEqual(active,['first']);assert.equal(input.value,'111');
    allowed=false;await context.toggleLineTruck('first');assert.deepEqual(active,['first']);
  }
  console.log('PASS '+label+': old false/true/missing flag, 111 close/reopen/repeat, permission/shift guards, filtering, unchanged flags and line selection');
}
function registry(){
  const core=require(path.join(root,'test-app/src/features/test-review-core.js'));
  assert.deepEqual(core.patches.map(p=>p.id),expectedPatchIds,'Only the accepted reset patch may disappear');
  assert(!read('test-app/src/features/test-review-core.js').includes('selector_reset'));
  const context={window:{TEST_APP_RELEASE:{label:'Fixture release'}}};vm.runInNewContext(read('test-app/src/features/review-config.js'),context);
  assert.deepEqual(Array.from(context.window.TEST_REVIEW_RELEASE.features),['conflict_author','admin_report','object_summary','summary_colors','analytics_workdate','analytics_audit']);
  assert.equal(core.enabled({testReviewFlags:{conflict_author:false}},'conflict_author'),false,'Unrelated switches retain their behavior');
  console.log('PASS registry: all 43 unrelated patch rows and six release-feature entries remain; no selector_reset toggle');
}
if(require.main===module)(async()=>{for(const [label,file] of targets)await exercise(label,file);registry();})().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={root,read,targets,expectedPatchIds,selectorCode,modalMarkup,trucks};
