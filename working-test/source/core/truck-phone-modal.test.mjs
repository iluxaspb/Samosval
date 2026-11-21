import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./36-truck-phone.js',import.meta.url),'utf8');
const escapeHtml=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Минимальный DOM: узлы, у которых querySelector ищет по уже отрисованной строке.
// Этого достаточно, чтобы прогнать окно телефона целиком (открыть, изменить, закрыть).
class FakeElement {
 constructor(tag){this.tagName=String(tag).toUpperCase();this.children=[];this.style={};this.dataset={};this.attrs={};this.listeners={};this._html='';this._stubs={};this.value='';this.disabled=false;this.textContent='';this.parentNode=null;}
 set className(value){this.attrs.class=String(value);} get className(){return this.attrs.class||'';}
 setAttribute(name,value){this.attrs[name]=String(value);}
 getAttribute(name){return this.attrs[name];}
 set innerHTML(value){this._html=String(value);this._stubs={};}
 get innerHTML(){return this._html;}
 appendChild(child){this.children.push(child);child.parentNode=this;return child;}
 append(...nodes){for(const node of nodes)this.appendChild(node);}
 remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}}
 addEventListener(type,handler){(this.listeners[type]||(this.listeners[type]=[])).push(handler);}
 dispatch(type,event){(this.listeners[type]||[]).forEach(handler=>handler(event));}
 focus(){this.focused=true;}
 querySelectorAll(){return [];}
 querySelector(selector){
  if(this._stubs[selector])return this._stubs[selector];
  let found=false;
  if(selector==='form')found=this._html.includes('<form');
  else{const match=/^\[([a-z-]+)=([a-z-]+)\]$/.exec(selector);if(match)found=this._html.includes(`${match[1]}="${match[2]}"`);}
  if(!found)return null;
  const stub={selector,value:'',disabled:false,textContent:'',onclick:null,onsubmit:null,focus(){this.focused=true;}};
  this._stubs[selector]=stub;return stub;
 }
}
function setup({permissions=[],entry=null,trucks=[{id:'truck_1',brand:'КАМАЗ',number:'А123ВС77'}]}={}){
 const doc={body:new FakeElement('body'),createElement:tag=>new FakeElement(tag)};
 const sent=[];const renders=[];
 const client={
  readTruckPhones:async()=>({source:'ubuntu',phones:[]}),
  submitTruckPhone:async body=>{sent.push(JSON.parse(JSON.stringify(body)));return {source:'ubuntu',phones:[{truckId:body.truckId,phone:body.phone,driverName:body.driverName==null?null:body.driverName}]};}
 };
 const context=vm.createContext({
  document:doc,Map,console,escapeHtml,
  hasPermission:action=>permissions.includes(action),
  findTruck:id=>trucks.find(truck=>truck.id===id),
  renderLine:()=>renders.push('line'),renderGlobalTrucksManage:()=>{},
  nasRuntimeEpoch:1,nasRuntimeClient:client
 });
 vm.runInContext(source,context);
 const run=expression=>vm.runInContext(expression,context);
 if(entry)run(`truckPhoneRows.set('truck_1',${JSON.stringify(entry)})`);
 return {doc,run,sent,renders,card:()=>{const overlay=doc.body.children[0];return overlay?overlay.children[0]:null;},overlay:()=>doc.body.children[0]||null};
}
const VIEW=['view_truck_phone'],CALL=[...VIEW,'call_truck_phone'],ADD=[...VIEW,'add_truck_phone'],ALL=[...VIEW,'call_truck_phone','add_truck_phone'];

test('the window always shows the driver name and the phone of that truck',()=>{
 const {doc,run,card}=setup({permissions:VIEW,entry:{phone:'+12025550100',driverName:'Иван Петров'}});
 run("openTruckPhoneModal('truck_1')");
 assert.equal(doc.body.children.length,1,'окно добавлено в DOM');
 const html=card().innerHTML;
 assert.match(html,/Телефон водителя/);
 assert.match(html,/КАМАЗ А123ВС77/,'в окне видна марка и номер самосвала');
 assert.match(html,/Иван Петров/,'в окне видно имя водителя');
 assert.match(html,/\+12025550100/,'в окне виден номер');
 // Без прав call/add оконных кнопок нет, и никакой tel-ссылки тоже.
 assert.equal(html.includes('tp-call'),false);
 assert.equal(html.includes('href="tel:'),false);
 assert.equal(html.includes('data-tp="edit"'),false);
 run('closeTruckPhoneModal()');
});

test('placeholders appear when the truck has no phone and no driver',()=>{
 const {run,card}=setup({permissions:VIEW});
 run("openTruckPhoneModal('truck_1')");
 const html=card().innerHTML;
 assert.match(html,/Имя не указано/);
 assert.match(html,/Телефон не добавлен/);
 assert.equal(html.includes('href="tel:'),false);
});

test('the call button needs call_truck_phone and a valid number',()=>{
 const call=setup({permissions:ALL,entry:{phone:'+12025550100',driverName:'Иван'}});
 call.run("openTruckPhoneModal('truck_1')");
 const callHtml=call.card().innerHTML;
 assert.match(callHtml,/class="btn btn-quick tp-call"/,'кнопка звонка в стиле приложения');
 assert.match(callHtml,/href="tel:\+12025550100"/,'tel-адрес из нормализованного номера');

 const noCall=setup({permissions:ADD,entry:{phone:'+12025550100',driverName:'Иван'}});
 noCall.run("openTruckPhoneModal('truck_1')");
 assert.equal(noCall.card().innerHTML.includes('tp-call'),false,'без call_truck_phone звонка нет');
 assert.equal(noCall.card().innerHTML.includes('href="tel:'),false);

 for(const bad of ['javascript:alert(1)','+7 (999)','12345']){
  const invalid=setup({permissions:ALL,entry:{phone:bad,driverName:'Иван'}});
  invalid.run("openTruckPhoneModal('truck_1')");
  const html=invalid.card().innerHTML;
  assert.equal(html.includes('href="tel:'),false,`невалидный номер ${bad} не даёт tel-ссылки`);
  assert.equal(html.includes('tp-call'),false,`невалидный номер ${bad} не даёт кнопки звонка`);
  assert.doesNotMatch(html,/(href|onclick)="[^"]*javascript:/i,'невалидное значение не попадает в атрибуты');
 }
});

test('the edit button and the form need add_truck_phone; the click opens the form',()=>{
 const viewOnly=setup({permissions:CALL,entry:{phone:'+12025550100',driverName:'Иван'}});
 viewOnly.run("openTruckPhoneModal('truck_1')");
 assert.equal(viewOnly.card().innerHTML.includes('data-tp="edit"'),false,'без add_truck_phone кнопки изменения нет');

 const editable=setup({permissions:ADD,entry:{phone:'+12025550100',driverName:'Иван'}});
 editable.run("openTruckPhoneModal('truck_1')");
 const edit=editable.card().querySelector('[data-tp=edit]');
 assert.ok(edit,'кнопка «Изменить/добавить» есть при праве');
 edit.onclick();
 const html=editable.card().innerHTML;
 assert.match(html,/<form/,'форма открывается в том же окне');
 assert.match(html,/data-tp="phone"[^>]*type="tel"[^>]*placeholder="\+7 999 123-45-67"/,'поле телефона с подсказкой формата');
 assert.match(html,/data-tp="driver"[^>]*type="text"[^>]*maxlength="80"/,'поле имени водителя до 80 символов');
 assert.match(html,/Сохранить/);assert.match(html,/Отмена/);
 assert.equal(editable.card().querySelector('[data-tp=phone]').focused,true,'в режиме правки фокус на первом поле');
});

test('saving sends truckId, phone and driverName and refreshes the map and the window',async()=>{
 const {run,card,sent,renders}=setup({permissions:ADD,entry:{phone:'+12025550100',driverName:'Иван Петров'}});
 run("openTruckPhoneModal('truck_1')");
 card().querySelector('[data-tp=edit]').onclick();
 card().querySelector('[data-tp=phone]').value='+7 (999) 123-45-67';
 card().querySelector('[data-tp=driver]').value='  Пётр   Сидоров ';
 card().querySelector('form').onsubmit({preventDefault(){}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent.length,1,'одна запись в транспорт');
 assert.equal(JSON.stringify(sent[0]),JSON.stringify({truckId:'truck_1',phone:'+79991234567',driverName:'Пётр Сидоров'}));
 assert.equal(run("truckPhoneEntry('truck_1').phone"),'+79991234567','Map обновился номером');
 assert.equal(run("truckPhoneEntry('truck_1').driverName"),'Пётр Сидоров','Map обновился именем');
 const html=card().innerHTML;
 assert.match(html,/Пётр Сидоров/,'окно показывает новое имя');
 assert.match(html,/\+79991234567/,'окно показывает новый номер');
 assert.equal(html.includes('<form'),false,'после сохранения окно вернулось в режим просмотра');
 assert.equal(renders.length,1,'renderLine вызван один раз');
});

test('an invalid phone is never sent to the server',async()=>{
 const {run,card,sent}=setup({permissions:ADD,entry:{phone:'+12025550100',driverName:'Иван'}});
 run("openTruckPhoneModal('truck_1')");
 card().querySelector('[data-tp=edit]').onclick();
 for(const bad of ['abc','8 999 123-45-67','+7 999 12','+7999123456789012345']){
  card().querySelector('[data-tp=phone]').value=bad;
  card().querySelector('[data-tp=driver]').value='Иван';
  await card().querySelector('form').onsubmit({preventDefault(){}});
  assert.equal(sent.length,0,`номер ${bad} не отправлен`);
  assert.match(card().querySelector('[data-tp=error]').textContent,/8–15 цифр/,'ошибка показана в форме');
  assert.equal(card().querySelector('[data-tp=save]').disabled,false,'кнопка снова доступна');
 }
});

test('the driver name is escaped in the window markup',()=>{
 const hostile='<img src=x onerror=alert(1)>';
 const {run,card}=setup({permissions:ALL,entry:{phone:'+12025550100',driverName:hostile}});
 run("openTruckPhoneModal('truck_1')");
 const html=card().innerHTML;
 assert.equal(html.includes('<img'),false,'тег из имени не стал настоящим тегом');
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/,'имя показано как текст');
});

test('close button, cancel and backdrop close the window; only one window exists at a time',()=>{
 const {doc,run,card}=setup({permissions:ADD,entry:{phone:'+12025550100',driverName:'Иван'}});
 run("openTruckPhoneModal('truck_1')");
 run("openTruckPhoneModal('truck_1')");
 assert.equal(doc.body.children.length,1,'одновременно открыто не более одного окна');
 card().querySelector('[data-tp=close]').onclick();
 assert.equal(doc.body.children.length,0,'крестик закрывает и удаляет окно');

 run("openTruckPhoneModal('truck_1')");
 doc.body.children[0].dispatch('click',{target:doc.body.children[0]});
 assert.equal(doc.body.children.length,0,'клик по подложке закрывает окно');

 run("addTruckPhone('truck_1')");
 assert.match(card().innerHTML,/<form/,'addTruckPhone открывает то же окно сразу в режиме правки');
 card().querySelector('[data-tp=cancel]').onclick();
 assert.equal(doc.body.children.length,0,'«Отмена» закрывает окно');
});

test('a user without view_truck_phone gets no window at all',()=>{
 const {doc,run}=setup({permissions:['add_truck_phone','call_truck_phone'],entry:{phone:'+12025550100',driverName:'Иван'}});
 run("openTruckPhoneModal('truck_1')");
 run("addTruckPhone('truck_1')");
 assert.equal(doc.body.children.length,0,'без права просмотра окно не открывается');
});
