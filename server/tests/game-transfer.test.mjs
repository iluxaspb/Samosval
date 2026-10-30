import test from 'node:test';
import assert from 'node:assert/strict';
import {gameTransferRecord} from '../src/game-transfer.mjs';
import {calculate} from '../src/game-economy.mjs';
test('compact game history preserves every calculator result across scopes and undo while discarding report/table bytes',()=>{
  const huge='x'.repeat(500000),user='one@example.test',shiftId='shift',scope={shiftId,objectId:'site',objectName:'Site'},author={userEmail:user,userName:'One',...scope};
  const shift={id:shiftId,objectId:'site',objectName:'Site',reportHtml:huge};
  const status={shiftId,lastLoadTimestamp:1000,arriveTimestamp:2000,ttnStatus:null,ttnRevision:0,report:huge};
  const log={id:'load',truckId:'truck',shiftId,timestamp:3000,createdByEmail:user,createdBy:'One',clientOperationId:'op',reportHtml:huge};
  const event=(id,timestamp,operations,extra={})=>({id,timestamp,eventType:'history',...author,history:{userEmail:user,user:'One',operations,undone:false,...extra}});
  const rows=[event('start',100,[{collection:'shift',id:'current',before:null,after:shift},{collection:'tabelNextRecords',id:'big',before:null,after:{sheet:huge}}]),
    event('arrival',2000,[{collection:'truckStatus',id:'truck',before:{...status,arriveTimestamp:null},after:status}]),
    event('load',3000,[{collection:'logs',id:'load',before:null,after:log},{collection:'truckStatus',id:'truck',before:status,after:{...status,arriveTimestamp:null,lastLoadTimestamp:3000}}]),
    event('ttn',3100,[{collection:'truckStatus',id:'truck',before:status,after:{...status,ttnStatus:true,ttnRevision:1}}]),
    event('archive',4000,[{collection:'archive',id:'saved',before:null,after:{sourceShiftId:shiftId,logs:[log],paper:huge}},{collection:'logs',id:'load',before:log,after:null}]),
    {id:'penalty',timestamp:5000,eventType:'game_penalty',amount:-3,targetEmail:user,targetName:'One',scope},
    {id:'purchase',eventType:'game_purchase',price:10,userUid:'one',text:'Theme'},
    {id:'arcade',eventType:'game_arcade',gameRound:1,bank:1000,player:{uid:'one',net:3},actors:{one:1}}];
  for(const undo of [false,true]){
    const input=structuredClone(rows);input[2].history.undone=undo;
    const compact=input.map(gameTransferRecord);
    for(const filter of [{},{shiftId},{objectKey:'id:site'},{shiftId:'other'}])assert.deepEqual(calculate(compact,filter),calculate(input,filter));
    assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(JSON.stringify(input))/100);
    assert.equal(input[0].history.operations[1].after.sheet.length,huge.length,'no mutation of authoritative history');
    assert.deepEqual(compact.at(-1),input.at(-1));
  }
});
