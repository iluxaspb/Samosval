import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePhone,normalizeDriverName,phonePatch} from '../src/truck-phone.mjs';
test('international phone normalizes to safe tel target',()=>{
 assert.equal(normalizePhone('+7 (999) 123-45-67'),'+79991234567');
});
test('empty is optional, malformed and injection inputs rejected',()=>{
 assert.equal(normalizePhone(''),'');
 for(const value of [null,123,'123','+0123456789','+79991234567;ext=1','tel:+79991234567','+7<script>','+1234567890123456'])assert.throws(()=>normalizePhone(value));
});
test('limited patch rejects other fields and empty phone',()=>{
 assert.deepEqual(phonePatch({truckId:'truck_1',phone:'+79991234567'}),{truckId:'truck_1',phone:'+79991234567',driverName:null});
 for(const data of [{truckId:'truck_1',phone:''},{truckId:'truck_1',phone:'+79991234567',brand:'hack'},{truckId:'../x',phone:'+79991234567'}])assert.throws(()=>phonePatch(data));
});

test('driver name is optional, normalized and strictly validated',()=>{
 assert.equal(normalizeDriverName(undefined),null);
 assert.equal(normalizeDriverName(null),null);
 assert.equal(normalizeDriverName(''),null);
 assert.equal(normalizeDriverName('   '),null);
 assert.equal(normalizeDriverName('  Иван   Петров '),'Иван Петров');
 assert.equal(normalizeDriverName("O'Neil-Smith Jr. 2"),"O'Neil-Smith Jr. 2");
 for(const value of [42,{},[],true,'<b>Иван</b>','Иван\nПетров','Иван\u0000Петров','x'.repeat(81),'Иван;drop','Иван+7999','Иван/../']){
  assert.throws(()=>normalizeDriverName(value),(e)=>e.code==='invalid-driver-name',String(value));
 }
});

test('patch accepts exactly truckId, phone and driverName',()=>{
 assert.deepEqual(phonePatch({truckId:'truck_1',phone:'+79991234567'}),{truckId:'truck_1',phone:'+79991234567',driverName:null});
 assert.deepEqual(phonePatch({truckId:'truck_1',phone:'+79991234567',driverName:'  Пётр  '}),{truckId:'truck_1',phone:'+79991234567',driverName:'Пётр'});
 assert.deepEqual(phonePatch({truckId:'truck_1',phone:'+7 (999) 123-45-67',driverName:''}),{truckId:'truck_1',phone:'+79991234567',driverName:null});
 assert.throws(()=>phonePatch({truckId:'truck_1',phone:'+79991234567',driverName:5}),(e)=>e.code==='invalid-driver-name');
 assert.throws(()=>phonePatch({truckId:'truck_1',phone:'+79991234567',driverName:'<img src=x onerror=1>'}),(e)=>e.code==='invalid-driver-name');
 assert.throws(()=>phonePatch({truckId:'truck_1',phone:'+79991234567',nickname:'x'}),(e)=>e.code==='invalid-phone-patch');
 assert.throws(()=>phonePatch({truckId:'truck_1',phone:'+79991234567',driver_name:'x'}),(e)=>e.code==='invalid-phone-patch');
 assert.throws(()=>phonePatch({truckId:'truck_1',phone:'',driverName:'Пётр'}),(e)=>e.code==='phone-required');
});
