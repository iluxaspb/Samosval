import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./15-shifts.js',import.meta.url),'utf8');

function functionSource(name){
  const start=source.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} must exist`);
  const brace=source.indexOf('{',source.indexOf(')',start));
  let depth=0;
  for(let i=brace;i<source.length;i++){
    if(source[i]==='{')depth++;
    if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);
  }
  throw new Error(`unterminated ${name}`);
}

const buildShiftPayloadV2=vm.runInNewContext(`(${functionSource('buildShiftPayloadV2')})`);

test('publishes the exact v2 night shift payload',()=>{
  const payload=buildShiftPayloadV2({
    shiftId:'shift_opaque',
    object:{id:'object_opaque',name:'Снимок имени объекта'},
    currentUid:'firebase-uid',
    currentDisplayName:'Снимок отображаемого имени',
    workShift:'night',
    startedAt:1795453200000
  });
  assert.deepEqual({...payload},{
    payloadSchemaVersion:2,
    id:'shift_opaque',
    shiftId:'shift_opaque',
    objectId:'object_opaque',
    objectName:'Снимок имени объекта',
    startDate:'23.11.2026',
    date:'2026-11-23',
    workShift:'night',
    type:'night',
    state:'active',
    isActive:true,
    startedAt:1795453200000,
    startedByUid:'firebase-uid',
    startedBy:'Снимок отображаемого имени'
  });
  assert.deepEqual(Object.keys(payload),['payloadSchemaVersion','id','shiftId','objectId','objectName','startDate','date','workShift','type','state','isActive','startedAt','startedByUid','startedBy']);
});

test('transport sender cannot replace the Firebase session creator',()=>{
  const payload=buildShiftPayloadV2({shiftId:'shift_opaque',object:{id:'object_opaque',name:'Объект'},currentUid:'creator-uid',currentDisplayName:'Создатель',workShift:'day',startedAt:1795410000000,senderUid:'replica-sender',startedByUid:'spoof'});
  assert.equal(payload.startedByUid,'creator-uid');
  assert.equal(payload.startedBy,'Создатель');
  assert.equal('senderUid' in payload,false);
  assert.equal(Object.keys(payload).some(key=>key.startsWith('restored')),false);
});

test('Firebase writer publishes only the shared v2 builder result',()=>{
  const body=functionSource('startShiftWithObject');
  assert.match(body,/refs\.shift\.set\(buildShiftPayloadV2\(\{shiftId:sid,object:\{id:objId\|\|'',name:objName\},currentUid,currentDisplayName:getUserName\(\),workShift,startedAt\}\)\)/);
});
