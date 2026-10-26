'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../../test-app/src/features/timesheet-core.js');
const errors=[],buttons=new Map();
const ctx={currentUserStatus:'active',currentUserRole:'viewer',permissionsLoaded:true,permissionsConfig:{viewer:{tabs:['line'],actions:[]},master:{tabs:['line','timesheet'],actions:['timesheet_edit']}},FORCED_ADMIN_EMAIL:'owner@example.com',ALL_TABS:['line','archive','timesheet','admin'],showError:s=>errors.push(s),document:{getElementById:id=>{if(!buttons.has(id))buttons.set(id,{style:{},classList:{add(){},remove(){}}});return buttons.get(id);}}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('test-app/src/core/04-permissions.js','utf8'),ctx);
let count=0;
for(const role of ['admin','master','viewer','missing'])for(const status of ['active','pending','blocked','rejected']){
 ctx.currentUserRole=role;ctx.currentUserStatus=status;
 assert.equal(ctx.hasPermission('timesheet_edit'),status==='active'&&['admin','master'].includes(role));
 assert.equal(ctx.hasTabAccess('timesheet'),status==='active'&&['admin','master'].includes(role));
 assert.equal(ctx.canAdmin(),status==='active'&&role==='admin');count+=3;
}
ctx.currentUserStatus='active';ctx.currentUserRole='master';ctx.permissionsLoaded=false;
assert.equal(ctx.hasPermission('timesheet_edit'),false);assert.equal(ctx.hasTabAccess('timesheet'),false);assert.equal(ctx.hasTabAccess('line'),true);
ctx.permissionsLoaded=true;ctx.permissionsConfig.master={tabs:[],actions:[]};
assert.equal(ctx.hasTabAccess('timesheet'),false);assert.equal(ctx.requireEdit('timesheet_edit'),false);assert.equal(errors.length,1);
ctx.updateNavUI();assert.equal(buttons.get('nav-timesheet').style.display,'none');assert.equal(buttons.get('nav-admin').style.display,'none');
assert.equal(ctx.isForcedAdminEmail('OWNER@EXAMPLE.COM'),true);assert.equal(ctx.canAdmin(),false);
(async()=>{
 const op={id:'existing',uid:'u',scope:'catalog',label:'Create',createdAt:1,status:'queued',changes:[{collection:'timesheetPeople',id:'person',baseRevision:0,data:{name:'Person',group:'worker',deleted:false}}]};
 const ws={collection:name=>({doc:id=>({path:name+'/'+id})})};let writes=0;
 const run=owner=>fn=>fn({get:async ref=>({exists:ref.path==='timesheetChanges/existing',data:()=>({uid:owner})}),set:()=>writes++});
 await assert.rejects(()=>C.commitOperation({},ws,op,{uid:'u',name:'User'},run('other')),e=>e.code==='wrong-account');
 assert.equal(writes,0);
 assert.equal((await C.commitOperation({},ws,op,{uid:'u',name:'User'},run('u'))).duplicate,true);
 assert.equal(writes,0);
 console.log('PASS permissions: '+count+' role/status decisions, unloaded and explicitly empty grants, navigation, no email-only elevation; ledger receipt belongs to its actor');
})().catch(e=>{console.error(e);process.exitCode=1;});
