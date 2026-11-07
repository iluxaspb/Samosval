import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,newTripField,setDraftField,makeJob,value,validate,clone} from '../core.js';

test('blank mode creates copies without any fleet or selected truck',()=>{
 const s=initial();s.draft.sender='Отправитель';s.draft.material='Асфальт';
 const f=newTripField();s.templates[0].fields.push(f);setDraftField(s.draft,'ttn',f.id,'Прораб');
 const j=makeJob(s,[],'2026-11-08',3,{blankTruck:true});
 assert.equal(j.blankTruck,true);assert.equal(j.pages.length,3);assert.equal(j.nextNumber,2);
 assert.deepEqual(j.pages.map(p=>p.copy),[1,2,3]);
 for(const p of j.pages){assert.deepEqual(p.truck,{});assert.equal(p.data.number,1);assert.equal(value({source:'material'},p.truck,p.data,j.settings),'Асфальт');assert.equal(value({source:'date'},p.truck,p.data,j.settings),'08.11.2026');assert.equal(value(f,p.truck,p.data,j.settings),'Прораб')}
 s.jobs.push(j);assert.doesNotThrow(()=>validate(clone(s)));assert.equal(s.trucks.length,0);
});
test('blank mode suppresses every truck source even if draft or truck has a value',()=>{
 const s=initial();s.trucks=[{id:'t',plate:'А123АА',driver:'Водитель',brand:'КАМАЗ',company:'Компания',volume:'20',extra:{trailer:'Прицеп'}}];
 Object.assign(s.draft,s.trucks[0]);
 const j=makeJob(s,['t'],'2026-11-08',1,{blankTruck:true}),p=j.pages[0];
 assert.deepEqual(p.truck,{});
 for(const source of ['plate','driver','brand','company','volume','custom'])assert.equal(value({source,customKey:'trailer'},s.trucks[0],p.data,j.settings),'');
 assert.equal(value({source:'text',text:'Подпись'},p.truck,p.data,j.settings),'Подпись');
 assert.equal(s.trucks[0].plate,'А123АА');
});
test('blank count bounds still apply and regular mode still requires real selected trucks',()=>{
 const s=initial();
 for(const n of [0,21,1.5,NaN])assert.throws(()=>makeJob(s,[],'2026-11-08',n,{blankTruck:true}),/Количество копий/);
 assert.equal(makeJob(s,[],'2026-11-08',20,{blankTruck:true}).pages.length,20);
 assert.throws(()=>makeJob(s,[],'2026-11-08',1),/самосвал/);
 assert.throws(()=>makeJob(s,['missing'],'2026-11-08',1),/удалена/);
 s.trucks=[{id:'t',plate:'А123АА'}];s.draft.blankTruck=true;
 const regular=makeJob(s,['t'],'2026-11-08',2,{blankTruck:false});
 assert.equal(value({source:'plate'},regular.pages[0].truck,regular.pages[0].data,regular.settings),'А123АА');
});
test('saved blank jobs retain shared fields and legacy jobs without mode flag remain readable',()=>{
 const s=initial();s.draft.material='Старый груз';const j=makeJob(s,[],'2026-11-08',1,{blankTruck:true});s.jobs.push(j);s.draft.material='Новый груз';
 const restored=validate(clone(s)),p=restored.jobs[0].pages[0];
 assert.equal(value({source:'material'},p.truck,p.data,j.settings),'Старый груз');
 assert.equal(value({source:'plate'},{plate:'Старый номер'},{},s.settings),'Старый номер');
});
