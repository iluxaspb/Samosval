import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeEmergencyDeviceEnvelope,createEmergencyDeviceStager} from '../../test-app/synology/emergency-device-staging.mjs';
const scope={projectId:'samosval-offline',workspaceId:'main_workspace',objectId:'site1',shiftId:'shift1'};
const head={sequence:5,hash:'a'.repeat(64)};
const session={uid:'u1',generation:1,status:'active'};
const op=id=>({id,uid:'u1',provider:'synology',...scope,body:{kind:'line.load',truckId:id}});
test('stages actions during a NAS outage without granting Firebase business write authority',async()=>{
  const docs=new Map();
  const s=createEmergencyDeviceStager({
    getSession:()=>session,
    hashBytes:async data=>createHash('sha256').update(data).digest('hex'),
    stageImmutable:async({id,envelope})=>{if(!docs.has(id))docs.set(id,envelope);},
    readBack:async id=>docs.get(id)
  });
  const empty=await s.upload({scope,head,operations:[op('one')]});
  assert.equal(empty.writes,0);
  const a=await s.upload({scope,head,operations:[op('one'),op('two')],nasUnavailable:true});
  const b=await s.upload({scope,head,operations:[op('one'),op('two')],nasUnavailable:true});
  assert.equal(a.id,b.id);
  assert.equal(docs.size,1);
  assert.equal(a.status,'staged-unconfirmed');
  assert.equal(a.readyForSharedWrites,false);
});
test('invalid scope and other operator data are rejected',()=>{
  assert.throws(()=>makeEmergencyDeviceEnvelope({session,scope,head,operations:[{...op('x'),uid:'u2'}]}));
  assert.throws(()=>makeEmergencyDeviceEnvelope({session,scope,head,operations:[op('x'),op('x')]}));
  assert.throws(()=>makeEmergencyDeviceEnvelope({session,scope,head,operations:[]}));
});
