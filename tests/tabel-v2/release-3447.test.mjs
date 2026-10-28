import test from 'node:test';
import assert from 'node:assert/strict';
import { rows } from '../../test-app/tabel-v2/table-domain.mjs';
test('owned rows put water first, brush next, then every mill; keep other sections and crew', () => {
  const equipment = [
    {id:'other', name:'Каток', kind:'other', ownership:'own'},
    {id:'brush', name:'МТЗ-щётка', kind:'brush', ownership:'own'},
    ...['1','2','3'].map(id => ({id:'mill'+id, name:'Фреза '+id,kind:'mill',ownership:'own'})),
    {id:'water',name:'Поливомоечная',kind:'water',ownership:'own',pump:true},
    {id:'hired',name:'Фреза наёмная',kind:'mill',ownership:'hired',contractor:'Фирма'},
  ];
  const config = {equipment,people:[],materials:[],works:[],request:{equipment:equipment.map(e=>e.id),people:[]}};
  const rr = rows(config,[{equipment,people:[],values:{}}]);
  assert.deepEqual(rr.filter(r=>r.field==='hours').map(r=>r.entity), ['water','brush','mill1','mill2','mill3','other','hired']);
  assert.equal(rr.find(r=>r.entity==='water'&&r.field==='pumpHours').name,'Помпа · Поливомоечная');
  assert.equal(rr.find(r=>r.entity==='brush'&&r.field==='crewHours').name,'Тракторист');
  assert.equal(rr.filter(r=>r.entity==='hired').length,1);
});
