import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const phone=read('../core/36-truck-phone.js');
const core=read('../core/18-line-ui.js').split("  window.addEventListener(")[0];
const animated=read('./anim-speeds.js').split('  // ===== renderLine =====')[1].split('  // ===== UI в настройках =====')[0];

function render(source,phoneValue,permissions){
 const trucks=[{id:'synthetic_truck',brand:'Synthetic',number:'TEST',defaultVol:10},{id:'synthetic_empty',brand:'Empty',number:'EMPTY',defaultVol:10}];
 const list={innerHTML:'',querySelectorAll:()=>[]};
 const elements={trucksLineList:list};
 for(const id of ['startShiftContainer','activeShiftContainer','changeObjBtn'])elements[id]={style:{}};
 const context=vm.createContext({
  document:{getElementById:id=>elements[id]},
  state:{shift:{id:'synthetic_shift'},truckStatus:Object.fromEntries(trucks.map(t=>[t.id,{onLine:true}]))},
  settings:{},getTimings:()=>({}),getActiveLineIds:()=>trucks.map(t=>t.id),
  getLogs:()=>[],findTruck:id=>trucks.find(t=>t.id===id),
  hasPermission:action=>permissions.has(action),offlinePendingForTruck:()=>false,
  escapeHtml:value=>value,renderRussianPlate:value=>value,formatLoadAge:()=>'-'
 });
 context.window=context;
 vm.runInContext(phone,context);
 context.phoneValue=phoneValue;
 vm.runInContext("truckPhoneRows.set('synthetic_truck',phoneValue)",context);
 vm.runInContext(source,context);
 vm.runInContext('renderLine()',context);
 return list.innerHTML;
}

for(const [name,source] of [['core',core],['animated replacement',animated]]){
 test(`${name}: real renderer includes permission-gated phone markup inside the matching card`,()=>{
  const phoneValue='+12025550100';
  for(let mask=0;mask<8;mask++){
   const permissions=new Set(['view_truck_phone','add_truck_phone','call_truck_phone'].filter((_,i)=>mask&(1<<i)));
   const html=render(source,phoneValue,permissions);
   const cards=html.split(/<div class="truck-card /).slice(1);
   assert.equal(cards.length,2);
   const target=cards.find(card=>card.includes('data-truck-id="synthetic_truck"'));
   const empty=cards.find(card=>card.includes('data-truck-id="synthetic_empty"'));
   assert.ok(target);assert.ok(empty);
   assert.equal(target.includes(`href="tel:${phoneValue}"`),!!((mask&1)&&(mask&4)),`tel mask ${mask}`);
   assert.equal(target.includes(phoneValue),!!(mask&1),`view mask ${mask}`);
   assert.equal(empty.includes('href="tel:'),false,'no cross-card phone');
   assert.equal(empty.includes("addTruckPhone('synthetic_empty')"),(mask&7)===7,`add mask ${mask}`);
  }
 });
 test(`${name}: invalid phone is never interpolated into a tel link`,()=>{
  const html=render(source,'javascript:invalid',new Set(['view_truck_phone','add_truck_phone','call_truck_phone']));
  assert.doesNotMatch(html,/href="tel:|javascript:invalid/);
  assert.ok(html.includes("addTruckPhone('synthetic_truck')"));
 });
}
