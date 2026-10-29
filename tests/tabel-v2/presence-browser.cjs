const assert=require('node:assert/strict'),fs=require('node:fs'),{spawn}=require('node:child_process'),{createRequire}=require('node:module');
const qa=createRequire(process.env.TABEL_SYNC_QA+'/package.json');
const {initializeTestEnvironment}=qa('@firebase/rules-unit-testing');
const {doc,setDoc}=qa('firebase/firestore');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8822','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let env,browser;try{
 env=await initializeTestEnvironment({projectId:'demo-tabel-next',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('releases/3.4.51/firestore-test.rules','utf8')}});
 await env.clearFirestore();
 await env.withSecurityRulesDisabled(async c=>{const db=c.firestore();
  await setDoc(doc(db,'users/admin'),{role:'admin',status:'active'});await setDoc(doc(db,'users/editor'),{role:'master',status:'active'});
  await setDoc(doc(db,'settings/permissions'),{master:{tabs:['timesheet'],actions:['timesheet_edit']}});
  await setDoc(doc(db,'workspaces/main_workspace/tabelNextRecords/site~config'),{data:{sheetAccess:{one:{roles:{master:true}},linked:{roles:{master:true}}}}});
 });
 browser=await chromium.launch({executablePath:'/tmp/tabel-chromium',args:['--no-sandbox']});
 const create=async(uid,linked=false)=>{
  const context=await browser.newContext({viewport:{width:393,height:852}}),p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>console.error(e.message));p.on('console',m=>{if(['error','warning'].includes(m.type()))console.log(uid,m.text());});
  await p.goto('http://127.0.0.1:8822/tests/tabel-v2/harness.html');
  for(const name of ['app','firestore'])await p.addScriptTag({content:fs.readFileSync(process.env.TABEL_SYNC_QA+'/node_modules/firebase/firebase-'+name+'-compat.js','utf8')});
  await p.evaluate(async({uid,linked})=>{
    firebase.initializeApp({projectId:'demo-tabel-next',apiKey:'emulator',appId:'emulator'});
    const db=firebase.firestore();db.useEmulator('127.0.0.1',8080,{mockUserToken:{sub:uid,email:uid+'@example.test'}});
    const {mount}=await import('/test-app/tabel-v2/grid.mjs'),D=await import('/test-app/tabel-v2/table-domain.mjs');
    const object={id:'site',name:'Совместная таблица'},config=D.config(object);config.start=D.today();config.tableMode='full';
    if(linked){config.start=D.add(D.today(),-13);config.equipment=[{id:'water',name:'Поливомоечная',ownership:'own',kind:'water'}];config.request.equipment=['water'];}
    const days=linked?D.days(config.start,D.today()).map(date=>D.createDay(config,date)):[];
    const records={'site/sheet:one':{revision:1,data:{name:'Лист',rows:12,cols:5,cells:{A1:{raw:'Общие данные'}},widths:{},heights:{}}}};
    document.body.innerHTML='<link rel="stylesheet" href="/test-app/tabel-v2/workspace.css"><section class="tn tn-app"><main></main></section>';
    const root=document.querySelector('section'),host=root.querySelector('main');
    const s={object,root,config:()=>config,days:()=>days,require:()=>{},sheetManager:()=>uid==='admin',sheetVisible:id=>id===(linked?'linked':'one'),remote:true,
      host:{session:()=>({uid,name:uid==='admin'?'Илья':'Алексей',role:uid==='admin'?'admin':'master'}),workspace:db.collection('workspaces').doc('main_workspace')},
      key:suffix=>'site/'+suffix,store:{get:k=>structuredClone(records[k]||{revision:0,data:null}),list:prefix=>Object.entries(records).filter(([key])=>key.startsWith(prefix)).map(([key,v])=>({key,...structuredClone(v)}))}};
    window.grid=await mount(s,host);window.s=s;
  },{uid,linked});return p;
 };
 const a=await create('admin'),b=await create('editor');
 await a.waitForFunction(()=>document.querySelector('.tn-presence').textContent.includes('Алексей'));
 await b.waitForFunction(()=>document.querySelector('.tn-presence').textContent.includes('Илья')).catch(async e=>{console.log('A',await a.locator('.tn-presence').innerText(),'B',await b.locator('.tn-presence').innerText());console.log('visibility',await a.evaluate(()=>({hidden:document.hidden,root:s.root.hidden,now:Date.now()})));await env.withSecurityRulesDisabled(async c=>{const {getDocs,collection}=qa('firebase/firestore');console.log((await getDocs(collection(c.firestore(),'workspaces/main_workspace/tabelNextPresence'))).docs.map(d=>d.data()));});throw e;});
 await b.locator('[data-range]').fill('B2:D4');await b.locator('[data-range]').dispatchEvent('change');
 await a.waitForFunction(()=>document.querySelectorAll('[data-peer]').length===9);
 assert.equal(await a.locator('[data-cell=A2]').getAttribute('data-peer'),null);
 const nameColor=await a.locator('.tn-presence>span').filter({hasText:'Алексей'}).evaluate(el=>getComputedStyle(el).color);
 assert((await a.locator('[data-cell=C3]').evaluate(el=>el.style.boxShadow)).includes(nameColor));
 await b.locator('[data-range]').fill('E5');await b.locator('[data-range]').dispatchEvent('change');
 await a.waitForFunction(()=>document.querySelectorAll('[data-peer]').length===1&&document.querySelector('[data-cell=E5]').hasAttribute('data-peer'));
 await a.screenshot({path:'/tmp/tabel3451-presence.png'});
 await b.evaluate(()=>grid.dispose());
 await a.waitForFunction(()=>!document.querySelector('.tn-presence').textContent.includes('Алексей'));
 assert.equal(await a.locator('[data-peer]').count(),0);await a.evaluate(()=>grid.dispose());
 const all=await create('admin',true),week=await create('editor',true);
 await week.locator('[data-period]').selectOption('week');
 const chosenDate=await week.locator('[data-cell=B2]').getAttribute('title');
 const allColumn=await all.locator('[title="'+chosenDate+'"]').getAttribute('data-cell');
 const target=allColumn.replace('2','4');
 await week.locator('[data-range]').fill('B4');await week.locator('[data-range]').dispatchEvent('change');
 await all.waitForFunction(target=>document.querySelector('[data-cell="'+target+'"]').hasAttribute('data-peer'),target);
 assert.notEqual(target,'B4');assert.equal(await all.locator('[data-cell=B4]').getAttribute('data-peer'),null);
 await all.evaluate(()=>grid.dispose());await week.evaluate(()=>grid.dispose());
 console.log('PASS two mobile browsers + real Firestore emulator: user list, unique matching name/cell colors, B2:D4 exact range, moving/leaving clears highlight; linked table highlights the same date when users view different periods');
 }finally{await browser?.close();await env?.cleanup();server.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
