import test from 'node:test';
import assert from 'node:assert/strict';
import {identityClaims,registrationDraft,normalizeIdentityOperation,profileView,roleView} from '../src/identity-rules.mjs';
test('already verified claims expose UID/email only, not token role or client authority',()=>{
  assert.deepEqual(identityClaims({uid:'verified',email:'new@example.test',email_verified:false,role:'admin'}),{uid:'verified',email:'new@example.test',emailVerified:false});
  for(const decoded of [null,{}, {uid:1},{uid:''},{uid:'x'.repeat(129)}])assert.equal(identityClaims(decoded),null);
});
test('registration binds to verified identity and always starts pending/viewer',()=>{
  assert.deepEqual(registrationDraft({uid:'verified',email:'new@example.test'},{uid:'owner',email:'owner@example.test',role:'admin',status:'active',nickname:' Operator '}),{uid:'verified',email:'new@example.test',nickname:'Operator',role:'viewer',status:'pending'});
  assert.equal(registrationDraft({uid:'new',email:'new@example.test'}).nickname,'New');
  assert.throws(()=>registrationDraft({uid:'new',email:null}),{code:'identity-email-required'});
  assert.throws(()=>registrationDraft({uid:'new',email:'new@example.test'},{nickname:'x'.repeat(81)}),{code:'invalid-nickname'});
});
test('permissions normalize deterministically and reject administrative bypass keys',()=>{
  const op={id:'p',type:'permissions.replace',role:'viewer',expectedRevision:1,permissions:{tabs:['report','line','line'],actions:['action_ttn','action_arrive']}};
  const normalized=normalizeIdentityOperation(op);
  assert.deepEqual(normalized.permissions,{tabs:['line','report'],actions:['action_arrive','action_ttn']});
  assert.deepEqual(normalized,normalizeIdentityOperation({...op,permissions:{tabs:['line','report'],actions:['action_arrive','action_ttn']}}));
  for(const patch of [{role:'admin'},{role:'unknown'},{expectedRevision:0},{permissions:{tabs:['admin'],actions:[]}},{permissions:{tabs:[],actions:['admin_only']}}])assert.throws(()=>normalizeIdentityOperation({...op,...patch}));
});
test('profile/admin operations validate observed revisions, roles and stable IDs',()=>{
  const op={id:'op',type:'user.role',uid:'target',expectedRevision:1,role:'viewer'};
  for(const patch of [{id:'register_reserved'},{id:'a/b'},{type:'user.password'},{role:'root'},{expectedRevision:Number.MAX_SAFE_INTEGER},{uid:''}])assert.throws(()=>normalizeIdentityOperation({...op,...patch}));
  assert.deepEqual(normalizeIdentityOperation({id:'reject',type:'registration.reject',uid:'u',expectedRevision:0,expectedProfileRevision:1}).reason,'Заявка отклонена администратором.');
  assert.throws(()=>normalizeIdentityOperation({id:'access',type:'user.access',uid:'u',expectedRevision:1,enabled:1}));
});
test('session profile omits arbitrary imported fields and uses normalized role/status',()=>{
  const row={uid:'u',email:'u@example.test',display_name:'Name',role:'viewer',status:'active',revision:'2',protected:false,profile:{role:'admin',protected:true,maxToken:'private',rejectionReason:{private:true}}};
  const view=profileView(row);assert.equal(view.role,'viewer');assert.equal(view.protected,false);assert.equal(view.revision,2);assert.equal(view.rejectionReason,null);
  assert.equal(JSON.stringify(view).includes('private'),false);
});
test('role view cannot turn a non-admin into an admin through a tab permission',()=>{
  assert.deepEqual(roleView('viewer',[{action:'tab_admin',allowed:true},{action:'tab_line',allowed:true},{action:'action_load',allowed:false}]),{tabs:['line'],actions:[]});
  assert.ok(roleView('foreman',[]).tabs.includes('timesheet'));
  assert.ok(roleView('admin',[]).tabs.includes('admin'));
});
