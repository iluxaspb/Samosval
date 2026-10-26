// Isolated DOM fixtures only: no browser exploit execution, live data, network,
// Firebase or MAX. Stored markup is never passed to any HTML parsing sink.
// Dependency: jsdom (the existing tests/timesheet/package.json dev dependency).
const fs = require('node:fs'), assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const read = path => fs.readFileSync('test-app/src/' + path, 'utf8');
function fixture(patched) {
  const dom = new JSDOM('<!doctype html><div id="statusTicker" style="display:none"></div><div id="toast"></div>', {runScripts:'outside-only',url:'https://fixture.invalid/'});
  const w = dom.window, timers = new Map(), calls = [], errors = [];
  Object.assign(w, {
    state:{notifications:[],users:[{email:'author@example.invalid',nickname:'Автор из справочника'}],trucks:[]},
    currentEmail:'viewer@example.invalid',currentUserNickname:'Текущий зритель',
    lastTickerTs:0,lastTickerId:null,toastTimer1:null,toastTimer2:null,allowUndo:true,
    hasPermission:()=>w.allowUndo,validTickerNotification:()=>true,
    offlineLocalTicker:()=>null,lastValidNotification:()=>w.state.notifications[0]||null,
    undoLastAction:()=>calls.push('server undo'),undoLastOfflineAction:()=>calls.push('offline undo'),
    setTimeout:(fn,ms)=>{const id=Symbol();timers.set(id,{fn,ms});return id;},
    clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval:()=>{},
    pendingStart(){},pendingEnd(){},refs:{notifications:{add:async()=>{throw Error('Unexpected database write');}}},
    console:{log(){},warn(...args){errors.push(args.join(' '));},error(...args){errors.push(args.join(' '));}}
  });
  // Outside-only JS execution and no resources option already prevent execution
  // and fetches. Block HTML parsing APIs as an additional regression assertion.
  const htmlDescriptors = {};
  for (const name of ['innerHTML','outerHTML']) {
    const desc = htmlDescriptors[name] = Object.getOwnPropertyDescriptor(w.Element.prototype,name);
    Object.defineProperty(w.Element.prototype,name,{...desc,set(){throw Error('Forbidden HTML sink: '+name);}});
  }
  w.Element.prototype.insertAdjacentHTML = () => {throw Error('Forbidden HTML sink');};
  w.Document.prototype.write = () => {throw Error('Forbidden document.write');};
  w.DOMParser.prototype.parseFromString = () => {throw Error('Forbidden DOMParser');};
  w.eval(read('core/05-formatting.js'));
  w.eval(read('core/24-notifications.js'));
  if (patched) w.eval(read('features/status-ticker.js'));
  timers.clear(); // exclude startup/migration timers: exercise rendering only
  function flush(ms) {for (const [id,timer] of [...timers]) if (timer.ms===ms) {timers.delete(id);timer.fn();}}
  function show(data) {w.state.notifications=data?[data]:[];w.renderStatusTicker();return w.document.getElementById('statusTicker');}
  function dispose() {for (const [name,desc] of Object.entries(htmlDescriptors)) Object.defineProperty(w.Element.prototype,name,desc);dom.window.close();}
  return {w,dom,show,flush,calls,errors,dispose};
}
function assertSafeContent(root) {
  for (const node of root.querySelectorAll('*')) {
    assert(['B','STRONG','I','EM','SPAN','DIV','BR'].includes(node.tagName),node.outerHTML);
    for (const attr of node.attributes) {
      assert(['class','style'].includes(attr.name),'Unexpected notification attribute '+attr.name);
      if (attr.name==='class') assert(/^(ru-plate(?:-main|-region|-flag)?|plate-digit|region-code|region-rus)$/.test(attr.value));
      if (attr.name==='style') {
        assert.equal(node.style.color,'rgb(245, 158, 11)');
        assert.equal(node.style.fontSize,'10px');
        assert.equal(node.style.length,2);
      }
    }
  }
}
for (const patched of [false,true]) {
  const f=fixture(patched),{w,show,flush}=f;
  const first={id:'one',timestamp:1000,html:'Приехал · Самосвал',createdBy:'Иван',createdByEmail:'viewer@example.invalid'};
  const t=show(first);
  assert.equal(t.querySelector('.ticker-left.active').textContent,first.html);
  assert.equal(t.querySelector('.ticker-user').textContent,'· 👤 Иван');
  assert.equal(t.querySelectorAll('.ticker-left').length,1);
  assert.equal(t.querySelector('.btn-undo').getAttribute('onclick'),null);
  t.querySelector('.btn-undo').click();assert.deepEqual(f.calls,['server undo']);

  const plate=w.renderRussianPlate('А123ВС178');
  const second={...first,id:'two',timestamp:2000,userName:'А & Б',html:'⚡ Погрузка · <b>КамАЗ &amp; test</b> '+plate+' · А &amp; Б'};
  show(second);
  let active=t.querySelector('.ticker-left.active');
  assert.equal(active.querySelector('.plate-digit').textContent,'123');
  assert.equal(active.querySelector('.region-code').textContent,'178');
  assert.equal(active.querySelector('.region-rus').textContent,'RUS');
  assert.equal(active.querySelector('.ru-plate-flag').children.length,3);
  assert.equal(active.querySelector('b').textContent,'КамАЗ & test');
  assert(!active.textContent.includes('А & Б'),'escaped legacy author is deduplicated');
  assertSafeContent(active);flush(800);assert.equal(t.querySelectorAll('.ticker-left').length,1);

  const correction={...second,userName:'Новый автор',html:'Исправлено <b>без дубля</b>',offlinePending:true};
  show(correction);assert.equal(t.querySelector('.ticker-left.active').textContent,'Исправлено без дубля');
  assert.equal(t.querySelector('.ticker-user').textContent,'· 👤 Новый автор');
  assert.equal(t.querySelectorAll('.ticker-left').length,1,'same ID correction does not replay animation');
  t.querySelector('.btn-undo').click();assert.equal(f.calls.at(-1),'offline undo');
  w.allowUndo=false;show(correction);assert.equal(t.querySelector('.btn-undo'),null,'permissions update on the same ID');
  w.allowUndo=true;show({...correction,offlinePending:false});t.querySelector('.btn-undo').click();assert.equal(f.calls.at(-1),'server undo');

  show({...correction,userName:'',createdBy:'',createdByEmail:'',html:'Автор не сохранён'});
  assert.equal(t.querySelector('.ticker-user').textContent,'','unknown historical author is not the viewer');
  if (patched) w.__forceTickerName();
  assert.equal(t.querySelector('.ticker-user').textContent,'');
  show({...correction,userName:'',createdBy:'—',createdByEmail:'author@example.invalid'});
  assert.equal(t.querySelector('.ticker-user').textContent,'· 👤 Автор из справочника');
  show({...correction,userName:'',createdBy:'',createdByEmail:'unknown@example.invalid'});
  assert.equal(t.querySelector('.ticker-user').textContent,'· 👤 Unknown');

  const marker='<img src="https://blocked.invalid/file" onerror="blocked-marker">';
  const malformed='<svg><foreignObject><div class="ru-plate" data-foreign="marker">x</div></foreignObject></svg>'+
    '<script>blocked-marker</script><iframe srcdoc="blocked-marker"></iframe>'+marker+
    '<span class="plate-digit" onclick="blocked-marker">456</span>'+ // class alone is not enough
    '<span style="background:url(https://blocked.invalid/file)">style</span>'+
    '<b><i>bad closing</b></i><div class="ru-plate-main">safe&#x3c;img&#62; &#39; &amp;</div>';
  show({...correction,id:'malformed',html:malformed,userName:'<img alt="author-marker">',timestamp:'0" data-foreign="marker'});
  active=t.querySelector('.ticker-left.active');assertSafeContent(active);
  assert(active.textContent.includes(marker));
  assert(active.textContent.includes('safe<img> \' &'));
  assert.equal(t.querySelectorAll('img,script,iframe,svg,[data-foreign],[onerror],[onclick]').length,0);
  assert.equal(t.querySelector('.ticker-user').textContent,'· 👤 <img alt="author-marker">');
  assert.equal(t.querySelector('.ticker-time').dataset.timestamp,'0');
  assert.equal(t.querySelector('.ticker-time').textContent,'—');

  const fragment=w.document.createElement('div');
  w.renderNotificationContent(fragment,'Иван · <b>Приехал</b> · Иван','Иван');assert.equal(fragment.textContent,'Приехал');
  w.renderNotificationContent(fragment,'<span style="color:#f59e0b;font-size:10px">☁️ ОФЛАЙН</span>');
  assertSafeContent(fragment);assert.equal(fragment.firstChild.style.fontSize,'10px');
  w.renderNotificationContent(fragment,'<b>'.repeat(100)+'текст'+'</b>'.repeat(100));assertSafeContent(fragment);
  w.renderNotificationContent(fragment,{html:'not a string'});assert.equal(fragment.childNodes.length,0);
  w.renderNotificationContent(fragment,'Простой текст < 12 &amp; &#x1f69b;');assert.equal(fragment.textContent,'Простой текст < 12 & 🚛');
  w.renderNotificationContent(fragment,'<br>Перенос');assert.equal(fragment.querySelectorAll('br').length,1);
  for(const value of [NaN,Infinity,-1,{},[],1e100])assert.equal(w.notificationTimestamp(value),0);

  if (patched) {
    show({...first,id:'newer',timestamp:6000});show({...first,id:'older',timestamp:4000});
    assert.equal(t.querySelectorAll('.leave-reverse').length,1,'undo/reordering preserves reverse animation');
    flush(800);
  }
  for(let i=0;i<20;i++) {show({...first,id:'burst-'+i,timestamp:7000+i,html:'Обновление '+i});assert(t.querySelectorAll('.ticker-left').length<=2);}
  flush(800);assert.equal(t.querySelectorAll('.ticker-left').length,1);assert.equal(t.querySelector('.ticker-left.active').textContent,'Обновление 19');
  show(null);show({...first,id:'restored',html:'Возвращено'});flush(800);
  assert.equal(t.style.display,'flex');assert.equal(t.querySelector('.ticker-left.active').textContent,'Возвращено');
  show(null);flush(800);assert.equal(t.style.display,'none');assert.equal(t.children.length,0);
  show(first);assert.equal(t.querySelectorAll('.ticker-left').length,1);

  const toast=w.document.getElementById('toast');
  w.showToastEl('<b>Сообщение</b> '+marker,false);assert.equal(toast.querySelectorAll('b').length,1);assert.equal(toast.querySelector('img'),null);
  flush(2500);flush(700);assert.equal(toast.textContent,'');
  w.__gameDeferToast=()=>true;w.showToastEl('Отложено игрой',false);assert.equal(toast.textContent,'');
  assert.deepEqual(f.errors,[]);f.dispose();
  console.log('PASS '+(patched?'patched':'core')+' notification renderer: legacy text/plates, inert invalid markup, author attribution, timestamp, permissions/undo, corrections, rapid updates and hide/restore');
}
