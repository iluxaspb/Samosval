import test from 'node:test';
import assert from 'node:assert/strict';
import {linePeriod,buildShiftArchive,requireMaterialImport} from '../src/shift-archive.mjs';
import {sourcePeriod} from '../../test-app/tabel-v2/material-transfer.mjs';
const shift={id:'shift',objectId:'site',objectName:'Объект',startDate:'30.10.2026',startedAt:Date.parse('2026-10-30T08:00:00+03:00'),closingStartedAt:1000000,closingBy:'Админ'};
const log=(id,truckId,timestamp,extra={})=>({id,truckId,timestamp,shiftId:shift.id,volume:24,...extra});
test('server calendar and day/night boundary match the existing material-transfer logic',()=>{
  for(const hour of ['07:59','08:00','19:59','20:00']){
    const s={...shift,startedAt:Date.parse('2026-10-30T'+hour+':00+03:00')};
    const expected=sourcePeriod(s),actual=linePeriod(s);
    assert.deepEqual(actual,{date:expected.date,kind:expected.shift});
  }
  for(const startDate of ['2026-02-30','31.02.2026',''])assert.throws(()=>linePeriod({...shift,startDate}));
});
test('archive keeps GAI trips, but excludes them from ordinary totals',()=>{
  const rows=[log('a','truck',100),log('b','truck',300,{arrivalTimestamp:200}),log('c','gai',120,{isGAI:true,volume:100})];
  const statuses={truck:{shiftId:'shift',onLine:true,ttnStatus:false,arriveTimestamp:400},zero:{shiftId:'shift',onLine:true}};
  const archive=buildShiftArchive(shift,rows,statuses,500);
  assert.equal(archive.totalTrips,2);assert.equal(archive.totalVolume,48);assert.equal(archive.logs.length,3);
  assert.deepEqual(archive.logs.map(l=>l.returnedAt),[200,400,null]);
  assert.deepEqual(archive.activeLineIds,['truck','zero']);assert.equal(archive.ttnStatus.truck,false);
});
test('archive rejects foreign shifts, invalid volumes and return times after next trip or freeze',()=>{
  assert.throws(()=>buildShiftArchive(shift,[log('a','truck',100,{shiftId:'other'})],{}));
  assert.throws(()=>buildShiftArchive(shift,[log('a','truck',100,{volume:'bad'})],{}));
  const rows=[log('a','truck',100,{returnedAt:350}),log('b','truck',300,{arrivalTimestamp:200,returnedAt:600})];
  assert.deepEqual(buildShiftArchive(shift,rows,{},500).logs.map(l=>l.returnedAt),[null,null]);
});
test('empty shift needs no archive; absent or wrong material confirmation blocks source cleanup',()=>{
  assert.equal(buildShiftArchive(shift,[],{}),null);
  requireMaterialImport(shift,null,null);
  const archive={totalTrips:1,totalVolume:24};
  for(const row of [null,{data:{lineImports:{shift:{volume:23,materialId:'m'}}}},{data:{lineImports:{other:{volume:24,materialId:'m'}}}}])assert.throws(()=>requireMaterialImport(shift,archive,row),{code:'material-not-confirmed'});
  requireMaterialImport(shift,archive,{data:{lineImports:{shift:{volume:24,materialId:'m'}}}});
});
