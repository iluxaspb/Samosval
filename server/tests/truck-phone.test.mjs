import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePhone,phonePatch} from '../src/truck-phone.mjs';
test('international phone normalizes to safe tel target',()=>{
 assert.equal(normalizePhone('+7 (999) 123-45-67'),'+79991234567');
});
test('empty is optional, malformed and injection inputs rejected',()=>{
 assert.equal(normalizePhone(''),'');
 for(const value of [null,123,'123','+0123456789','+79991234567;ext=1','tel:+79991234567','+7<script>','+1234567890123456'])assert.throws(()=>normalizePhone(value));
});
test('limited patch rejects other fields and empty phone',()=>{
 assert.deepEqual(phonePatch({truckId:'truck_1',phone:'+79991234567'}),{truckId:'truck_1',phone:'+79991234567'});
 for(const data of [{truckId:'truck_1',phone:''},{truckId:'truck_1',phone:'+79991234567',brand:'hack'},{truckId:'../x',phone:'+79991234567'}])assert.throws(()=>phonePatch(data));
});
