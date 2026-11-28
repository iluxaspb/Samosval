import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const phone=read('../core/36-truck-phone.js');
const icons=read('../core/35-line-icons.js');
const core=read('../core/18-line-ui.js').split("  window.addEventListener(")[0];
const animated=read('./anim-speeds.js').split('  // ===== renderLine =====')[1].split('  // ===== UI в настройках =====')[0];

function render(source,entry,permissions){
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
  escapeHtml:value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  renderRussianPlate:value=>value,formatLoadAge:()=>'-'
 });
 context.window=context;
 vm.runInContext(phone,context);
 vm.runInContext(icons,context);
 context.entry=entry;
 vm.runInContext('truckPhoneRows.set("synthetic_truck",entry)',context);
 vm.runInContext(source,context);
 vm.runInContext('renderLine()',context);
 return list.innerHTML;
}

const masks=[...Array(8).keys()];
const permissionsFor=mask=>new Set(['view_truck_phone','add_truck_phone','call_truck_phone'].filter((_,i)=>mask&(1<<i)));

for(const [name,source] of [['core',core],['animated replacement',animated]]){
 test(`${name}: the card carries only a phone icon button — no tel links at all`,()=>{
  const entry={phone:'+12025550100',driverName:'Иван Петров'};
  for(const mask of masks){
   const html=render(source,entry,permissionsFor(mask));
   const cards=html.split(/<div class="truck-card /).slice(1);
   assert.equal(cards.length,2);
   const target=cards.find(card=>card.includes('data-truck-id="synthetic_truck"'));
   const empty=cards.find(card=>card.includes('data-truck-id="synthetic_empty"'));
   assert.ok(target);assert.ok(empty);
   // Телефон в карточке больше не рисуется ни ссылкой, ни номером.
   assert.doesNotMatch(html,/href="tel:/i,`tel link mask ${mask}`);
   assert.equal(html.includes(entry.phone),false,`raw phone in card mask ${mask}`);
   assert.equal(html.includes('addTruckPhone'),false,`legacy add button mask ${mask}`);
   // Иконка-кнопка есть ровно при праве view_truck_phone и только в своей карточке.
   const iconCount=target.split('truck-phone-btn').length-1;
   assert.equal(iconCount,mask&1?1:0,`icon mask ${mask}`);
   assert.equal(target.includes("openTruckPhoneModal('synthetic_truck')"),!!(mask&1),`open mask ${mask}`);
   assert.equal(empty.includes('truck-phone-btn'),mask&1?true:false,`second card icon follows the same permission mask ${mask}`);
   assert.equal(empty.includes("openTruckPhoneModal('synthetic_truck')"),false,`no cross-card handler mask ${mask}`);
   assert.equal(empty.includes("openTruckPhoneModal('synthetic_empty')"),!!(mask&1),`own handler mask ${mask}`);
   // Модификатор tp-has-phone — ровно при непустом номере в базе (у synthetic_truck он есть, у synthetic_empty нет).
   assert.equal(target.includes('tp-has-phone'),!!(mask&1),`green modifier with phone mask ${mask}`);
   assert.equal(empty.includes('tp-has-phone'),false,`no green modifier without phone mask ${mask}`);
   if(mask&1){
    assert.match(target,/type="button"[^>]*aria-label="Телефон самосвала"/,'кнопка-иконка должна быть кнопкой с подписью');
    assert.match(target,/title="Телефон водителя"/,'подсказка иконки');
    assert.match(target,/<svg[^>]*width="16"[^>]*height="16"[^>]*stroke="currentColor"/,'inline SVG 16x16 с currentColor');
   }
  }
 });
 test(`${name}: a stored phone never reaches the card markup`,()=>{
  const html=render(source,{phone:'javascript:invalid',driverName:null},permissionsFor(7));
  assert.doesNotMatch(html,/href="tel:|javascript:invalid/);
  assert.equal(html.includes("openTruckPhoneModal('synthetic_truck')"),true);
 });
 test(`${name}: a truck without a phone still shows the icon and no dial link`,()=>{
  const html=render(source,null,permissionsFor(7));
  assert.doesNotMatch(html,/href="tel:/);
  assert.equal(html.includes("openTruckPhoneModal('synthetic_truck')"),true);
 });
 test(`${name}: an empty stored phone leaves the icon in its default look`,()=>{
  const html=render(source,{phone:'',driverName:null},permissionsFor(7));
  const card=html.split(/<div class="truck-card /).slice(1).find(c=>c.includes('data-truck-id="synthetic_truck"'));
  assert.ok(card,'карточка на месте');
  assert.ok(card.includes('truck-phone-btn'),'иконка есть');
  assert.equal(card.includes('tp-has-phone'),false,'пустой номер — без зелёного модификатора');
 });
}