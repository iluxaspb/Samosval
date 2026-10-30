import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canRead,canWrite,canView,parseKey,validateJob} from '../src/tabel-access.mjs';
import {jobHash} from '../src/tabel-store.mjs';
const actor={uid:'worker',role:'master',status:'active',permissions:['tab_timesheet','timesheet_edit']};
const config={sheetAccess:{one:{roles:{master:true}},two:{users:{other:true}},linked:{users:{worker:true}}}};
test('Tabel denies inactive users and absent tab permissions, including disabled admin',()=>{
  for(const a of [{...actor,status:'disabled'},{...actor,permissions:[]},{...actor,role:'admin',status:'pending'}]) assert.equal(canView(a),false);
});
test('Tabel reads respect role/user sheet grants and linked-day grant',()=>{
  assert.equal(canRead(actor,'site/config',config),true);
  assert.equal(canRead(actor,'site/sheet:one',config),true);
  assert.equal(canRead(actor,'site/sheet:two',config),false);
  assert.equal(canRead(actor,'site/day:2026-10-30:day',config),true);
  assert.equal(canRead(actor,'site/day:2026-10-30:day',{}),false);
  assert.equal(canRead({...actor,uid:'other'},'site/sheet:two',config),true);
});
test('Managers read all sheets; foreman still needs timesheet_edit for writes',()=>{
  for(const role of ['admin','foreman']) assert.equal(canRead({...actor,role,permissions:[]},'site/sheet:two',{}),true);
  assert.equal(canWrite({...actor,role:'foreman',permissions:[]},'site/config',{},null,{}),false);
  assert.equal(canWrite({...actor,role:'admin',permissions:[]},'site/config',{},null,{}),true);
});
test('Non-manager cannot add config, grant access, rename or delete sheets',()=>{
  assert.equal(canWrite(actor,'site/config',config,null,config),false);
  assert.equal(canWrite(actor,'site/config',{...config,currentMaterial:'Гранулят'},config,config),true);
  assert.equal(canWrite(actor,'site/config',{sheetAccess:{}},config,config),false);
  const old={name:'Лист',deleted:false,cells:{}};
  assert.equal(canWrite(actor,'site/sheet:one',{...old,cells:{A1:{raw:'12'}}},old,config),true);
  for(const data of [{...old,name:'Другой'},{...old,deleted:true},{cells:{}}]) assert.equal(canWrite(actor,'site/sheet:one',data,old,config),false);
  assert.equal(canWrite({...actor,permissions:['tab_timesheet']},'site/sheet:one',old,old,config),false);
});
test('Record IDs are path-safe; jobs enforce size and revision limits',()=>{
  assert.equal(parseKey('site/day:2026-10-30:night').recordId,'site~day~2026-10-30~night');
  for(const key of ['site/../../users','site/sheet:x/y','site/day:bad:day',null]) assert.throws(()=>parseKey(key));
  const job={id:'op_1',key:'site/config',data:{},before:{revision:0,data:null}};
  validateJob(job);
  for(const update of [{id:'a/b'},{data:[]},{before:{revision:-1,data:null}},{before:{revision:0,data:{}}},{data:{text:'x'.repeat(350001)}}]) assert.throws(()=>validateJob({...job,...update}));
});
test('Operation hash binds content and base, ignores map order and untrusted actor fields',()=>{
  const job={id:'op',key:'site/config',data:{a:1,b:2},before:{revision:0,data:null}};
  assert.equal(jobHash(job),jobHash({...job,data:{b:2,a:1},author:'spoof'}));
  assert.notEqual(jobHash(job),jobHash({...job,data:{a:2,b:2}}));
  assert.notEqual(jobHash(job),jobHash({...job,before:{revision:1,data:{}}}));
});
test('Server conflict merge remains exactly the tested client implementation',()=>{
  assert.equal(readFileSync(new URL('../src/tabel-merge.mjs',import.meta.url),'utf8'),readFileSync(new URL('../../test-app/tabel-v2/merge-record.mjs',import.meta.url),'utf8'));
});
