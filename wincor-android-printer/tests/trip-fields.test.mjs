import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,newTripField,tripFields,draftFieldValue,setDraftField,makeJob,value,clone,validate} from '../core.js';

function setup(){const state=initial();state.trucks=[{id:'truck',plate:'А123АА',driver:'Водитель'}];const field=newTripField();field.label='Имя прораба';state.templates[0].fields.push(field);return {state,field,template:state.templates[0]}}
test('named trip field prints the entered value on every copy and preserves history',()=>{
  const {state,field,template}=setup();
  setDraftField(state.draft,template.id,field.id,'Иван Петров');
  const job=makeJob(state,['truck'],'2026-11-07',2);
  setDraftField(state.draft,template.id,field.id,'Другой прораб');
  field.label='Ответственный';
  for(const page of job.pages) assert.equal(value(job.template.fields.at(-1),page.truck,page.data,job.settings),'Иван Петров');
  assert.equal(job.template.fields.at(-1).label,'Имя прораба');
  assert.equal(job.pages[0].data.tripValues,undefined);
  state.jobs.push(job);assert.doesNotThrow(()=>validate(clone(state)));
});
test('renaming a field preserves its draft; equal labels and copied fields remain independent',()=>{
  const {state,field,template}=setup();
  setDraftField(state.draft,template.id,field.id,'Первый');
  field.label='Переименован';
  assert.equal(draftFieldValue(state.draft,template.id,field.id),'Первый');
  const copy={...field,id:'copy'};template.fields.push(copy);
  assert.equal(draftFieldValue(state.draft,template.id,copy.id),'');
  setDraftField(state.draft,template.id,copy.id,'Второй');
  const job=makeJob(state,['truck'],'2026-11-07',1), page=job.pages[0];
  assert.equal(value(field,page.truck,page.data,job.settings),'Первый');
  assert.equal(value(copy,page.truck,page.data,job.settings),'Второй');
});
test('drafts are separated by template and survive JSON storage; blank is printable',()=>{
  const {state,field,template}=setup();
  const copy={...clone(template),id:'template-copy'};state.templates.push(copy);
  setDraftField(state.draft,template.id,field.id,'Основной');
  setDraftField(state.draft,copy.id,field.id,'Копия');
  const restored=validate(clone(state));
  assert.equal(draftFieldValue(restored.draft,template.id,field.id),'Основной');
  restored.draft.templateId=copy.id;
  let job=makeJob(restored,['truck'],'2026-11-07',1);
  assert.equal(value(field,job.pages[0].truck,job.pages[0].data,job.settings),'Копия');
  setDraftField(restored.draft,copy.id,field.id,'');
  job=makeJob(restored,['truck'],'2026-11-07',1);
  assert.equal(value(field,job.pages[0].truck,job.pages[0].data,job.settings),'');
});
test('legacy static text and truck sources remain unchanged; deleted fields leave no print data',()=>{
  const {state,field,template}=setup();
  setDraftField(state.draft,template.id,field.id,'Удалено');
  template.fields=template.fields.filter(f=>f.id!==field.id);
  assert.equal(tripFields(template).length,0);
  const job=makeJob(state,['truck'],'2026-11-07',1), page=job.pages[0];
  assert.deepEqual(page.data.tripFields,{});
  assert.equal(value({source:'text',text:'Постоянный текст'},page.truck,page.data,job.settings),'Постоянный текст');
  assert.equal(value({source:'driver'},page.truck,page.data,job.settings),'Водитель');
  assert.equal(value({source:'trip',id:field.id},page.truck,{},job.settings),'');
});


test('one trip input supplies every linked position and is frozen in history',()=>{
  const {state,field,template}=setup();
  const linked=[newTripField(),newTripField()].map(copy=>({...copy,tripSourceId:field.id}));
  template.fields.push(...linked);
  assert.deepEqual(tripFields(template).map(item=>item.id),[field.id]);
  setDraftField(state.draft,template.id,field.id,'Иван Петров');
  const job=makeJob(state,['truck'],'2026-11-07',2);
  setDraftField(state.draft,template.id,field.id,'Другой прораб');
  for(const page of job.pages){
    for(const item of [field,...linked])assert.equal(value(item,page.truck,page.data,job.settings),'Иван Петров');
  }
  state.jobs.push(job);
  assert.doesNotThrow(()=>validate(clone(state)));
});
