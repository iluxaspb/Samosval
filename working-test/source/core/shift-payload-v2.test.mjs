import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./15-shifts.js',import.meta.url),'utf8');

function functionSource(name){
  const plainStart=source.indexOf(`function ${name}(`);
  assert.notEqual(plainStart,-1,`${name} must exist`);
  const asyncStart=source.lastIndexOf('async ',plainStart);
  const start=asyncStart>=0&&source.slice(asyncStart,plainStart)==='async '?asyncStart:plainStart;
  const brace=source.indexOf('{',source.indexOf(')',plainStart));
  let depth=0;
  for(let i=brace;i<source.length;i++){
    if(source[i]==='{')depth++;
    if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);
  }
  throw new Error(`unterminated ${name}`);
}

const buildShiftPayloadV2=vm.runInNewContext(`(${functionSource('buildShiftPayloadV2')})`);

function writerHarness(){
  let written,error,notice;
  const context={
    Intl,
    Date:class extends Date {static now(){return 1795453200000;}},
    startShiftInFlight:false,
    requireEdit:()=>true,
    appNotice:message=>{notice=message;},
    state:{},
    offlinePendingCount:()=>0,
    isNasRuntime:()=>false,
    cleanupOldShiftData:async()=>{},
    clearAllNotifications:async()=>{},
    refs:{shift:{set:async payload=>{written=payload;}}},
    tfAwait:promise=>promise,
    currentUid:'firebase-creator',
    getUserName:()=> 'Firebase Creator',
    appConfig:{maxEnabled:false},
    addAudit:async()=>{},
    closeStartShiftModal:()=>{},
    showToastEl:()=>{},
    openTabelShiftForLine:()=>{},
    showError:message=>{error=message;}
  };
  vm.runInNewContext(`${functionSource('buildShiftPayloadV2')}\n${functionSource('startShiftWithObject')}\nglobalThis.buildExpected=buildShiftPayloadV2;\nglobalThis.startWriter=startShiftWithObject;`,context);
  return {context,written:()=>written,error:()=>error,notice:()=>notice};
}

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

test('rejects a frontend workShift outside exact day or night',()=>{
  assert.throws(()=>buildShiftPayloadV2({shiftId:'shift_opaque',object:{id:'object_opaque',name:'Объект'},currentUid:'creator-uid',currentDisplayName:'Создатель',workShift:'morning',startedAt:1795453200000}),/invalid-shift-v2-provenance/);
});

test('Firebase writer executes the shared builder and writes its exact result',async()=>{
  const harness=writerHarness();
  await harness.context.startWriter('Снимок имени объекта','object_opaque','night');
  const expected=harness.context.buildExpected({shiftId:'shift_1795453200000',object:{id:'object_opaque',name:'Снимок имени объекта'},currentUid:'firebase-creator',currentDisplayName:'Firebase Creator',workShift:'night',startedAt:1795453200000});
  assert.deepEqual({...harness.written()},{...expected});
  assert.equal(harness.written().workShift,'night');
  assert.equal(harness.written().startedByUid,'firebase-creator');
});

test('Firebase writer rejects malformed workShift before any write',async()=>{
  const harness=writerHarness();
  await harness.context.startWriter('Объект','object_opaque','morning');
  assert.equal(harness.written(),undefined);
  assert.match(harness.notice(),/Выберите тип смены/);
  assert.equal(harness.error(),undefined);
});
