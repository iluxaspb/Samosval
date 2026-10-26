'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const clone=value=>JSON.parse(JSON.stringify(value));
const serviceSource=fs.readFileSync('test-app/src/features/object-photos-service.js','utf8');
const uiSource=fs.readFileSync('test-app/src/features/object-photos-ui.js','utf8');

function fixture({onQuery}={}){
  const photos=new Map(),queries=[];let concurrent=0,maxConcurrent=0,ctx,env;
  class Query{
    constructor(path,conditions=[]){this.path=path;this.conditions=conditions;}
    doc(id){return new Ref(this.path+'/'+id);}
    where(field,operator,value){assert.equal(operator,'==','Lineage query must not depend on Firestore in limits');return new Query(this.path,[...this.conditions,[field,value]]);}
    async get(){
      assert.equal(this.path,'workspaces/test/objectPhotos');const filters=clone(this.conditions);queries.push(filters);concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
      try{
        if(onQuery)await onQuery(filters,env);
        await new Promise(resolve=>setImmediate(resolve));
        return {docs:[...photos.entries()].filter(([,data])=>filters.every(([field,value])=>data[field]===value)).map(([id,data])=>({id,data:()=>clone(data)}))};
      }finally{concurrent--;}
    }
  }
  class Ref{constructor(path){this.path=path;}collection(name){return new Query(this.path+'/'+name);}}
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.style={};this.dataset={};this.hidden=false;this.disabled=false;this.open=false;this.root=false;this._text='';this.handlers={};}
    get isConnected(){return this.root||!!this.parentElement?.isConnected;}
    set textContent(value){this._text=String(value);for(const child of this.children)child.parentElement=null;this.children=[];}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    append(...children){for(let child of children){if(typeof child==='string'){const text=new Element('#text');text.textContent=child;child=text;}child.parentElement=this;this.children.push(child);}}
    prepend(child){child.parentElement=this;this.children.unshift(child);}
    replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this._text='';this.append(...children);}
    addEventListener(name,handler){this.handlers[name]=handler;}
    setAttribute(name,value){this[name]=value;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    querySelectorAll(){return [];}
  }
  const nodes=new Map();
  for(const id of ['dialog','message','usage','grid','title','all','shift','select-label','delete','select','more','close','refresh']){const node=new Element(id==='dialog'?'dialog':'div');node.root=true;nodes.set('object-photos-'+id,node);}
  const body=new Element();body.root=true;nodes.set('modalArchiveBody',body);
  const document={getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag),createTextNode:text=>{const node=new Element('#text');node.textContent=text;return node;},addEventListener(){}};
  ctx={WORKSPACE_ID:'test',db:{collection:name=>new Query(name)},window:{addEventListener(){},dispatchEvent(){}},currentUid:'user-a',currentUserStatus:'active',permissionsLoaded:true,archiveAccess:true,isAdmin:false,
    canAdmin:()=>ctx.isAdmin,hasTabAccess:()=>ctx.archiveAccess,document,resolveUserDisplayName:(_email,name)=>name||'Author',firebaseConfig:{projectId:'demo-test'},appConfig:{},
    navigator:{onLine:true},setInterval(){return 1;},setTimeout,clearTimeout,console,Date,Map,Set,Promise};
  vm.createContext(ctx);vm.runInContext(serviceSource,ctx);
  ctx.window.ObjectPhotos.url=async photo=>'https://photos.invalid/'+photo.id;
  vm.runInContext(uiSource,ctx);
  env={ctx,photos,queries,nodes,body,service:ctx.window.ObjectPhotos,stats:()=>({maxConcurrent,concurrent}),
    add:(id,shiftId,objectId='current',extra={})=>photos.set(id,{shiftId,objectKey:'id:'+objectId,objectId,objectName:objectId,status:'ready',capturedAt:1000+photos.size,bytes:1200,...extra}),
    gridIds:()=>nodes.get('object-photos-grid').children.map(card=>card.children[0].children[0]._photo.id),
    click:async id=>nodes.get('object-photos-'+id).onclick(),
    attach:archive=>{body.replaceChildren();ctx.window.__attachArchivePhotos(archive);return body.children[0].children;}};
  return env;
}

const tests=[];const test=(name,run)=>tests.push({name,run});
test('service includes every ancestor across object changes, excludes unrelated/deleted photos, deduplicates and bounds concurrent queries',async()=>{
  const env=fixture();const ids=Array.from({length:15},(_,i)=>'s'+i);
  ids.forEach((id,i)=>env.add('p'+i,id,i%2?'current':'previous'));
  env.add('unrelated','other','current');env.add('deleted','s0','previous',{status:'deleted'});
  const result=await env.service.list({objectKey:'id:current',photoShiftIds:[...ids,'s0'],shiftId:'s14'});
  assert.equal(result.length,15);assert(result.some(photo=>photo.objectId==='previous'));assert(!result.some(photo=>['unrelated','deleted'].includes(photo.id)));
  assert.equal(new Set(result.map(photo=>photo.id)).size,15);assert.equal(env.queries.length,15);assert(env.queries.every(query=>query.length===1&&query[0][0]==='shiftId'));
  assert.equal(env.stats().maxConcurrent,4);assert(result.every((photo,i)=>!i||result[i-1].capturedAt>=photo.capturedAt));
});
test('service retains legacy single-shift filtering and strict object mode',async()=>{
  const env=fixture();env.add('old','legacy','old-object');env.add('same-object','different-shift','current');env.add('new','current-shift','current');
  const old=await env.service.list({objectKey:'id:current',shiftId:'legacy'});assert.deepEqual(Array.from(old,photo=>photo.id),['old']);
  const object=await env.service.list({objectKey:'id:current',photoShiftIds:[]});assert.deepEqual(new Set(object.map(photo=>photo.id)),new Set(['same-object','new']));
  assert(env.queries.at(-1).some(([field,value])=>field==='objectKey'&&value==='id:current'));
});
test('service snapshots filter values before an asynchronous query',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const env=fixture({onQuery:()=>gate});env.add('first','s1','current');env.add('second','s2','current');
  const filter={photoShiftIds:['s1'],objectKey:'id:current'},pending=env.service.list(filter);filter.photoShiftIds[0]='s2';filter.shiftId='s2';release();
  assert.deepEqual(Array.from(await pending,photo=>photo.id),['first']);
});
test('service rejects results when the account changes or photo access is revoked during the read',async()=>{
  for(const change of [env=>env.ctx.currentUid='user-b',env=>env.ctx.archiveAccess=false,env=>env.ctx.permissionsLoaded=false]){
    const env=fixture({onQuery:(_query,fixture)=>change(fixture)});env.add('private','s1');
    await assert.rejects(env.service.list({photoShiftIds:['s1']}),error=>error.code==='photo/access');
  }
});
test('archive UI toggles full restored lineage and object photos without losing ancestors',async()=>{
  const env=fixture();env.add('ancestor','original','previous');env.add('restored','restored','current');env.add('other-object-shift','other','current');
  const [objectButton,shiftButton]=env.attach({objectId:'current',objectName:'Current',sourceShiftId:'restored',photoShiftIds:['original','restored','original']});
  assert.equal(shiftButton.textContent,'Фото этой смены');await shiftButton.onclick();
  assert.deepEqual(new Set(env.gridIds()),new Set(['ancestor','restored']));assert.equal(env.nodes.get('object-photos-shift').disabled,true);assert.equal(env.nodes.get('object-photos-all').disabled,false);
  await env.click('all');assert.deepEqual(new Set(env.gridIds()),new Set(['restored','other-object-shift']));assert.equal(env.nodes.get('object-photos-shift').disabled,false);
  await env.click('shift');assert.deepEqual(new Set(env.gridIds()),new Set(['ancestor','restored']));
  await objectButton.onclick();assert.deepEqual(new Set(env.gridIds()),new Set(['restored','other-object-shift']));await env.click('shift');assert.deepEqual(new Set(env.gridIds()),new Set(['ancestor','restored']));
});
test('legacy archive UI exposes its single source shift; archives without linkage expose only object photos',async()=>{
  const env=fixture();env.add('legacy-photo','old','previous');env.add('current-photo','new','current');
  const legacy=env.attach({objectId:'current',objectName:'Current',sourceShiftId:'old'});assert.equal(legacy.length,2);await legacy[1].onclick();assert.deepEqual(env.gridIds(),['legacy-photo']);await env.click('all');assert.deepEqual(env.gridIds(),['current-photo']);await env.click('shift');assert.deepEqual(env.gridIds(),['legacy-photo']);
  const unlinked=env.attach({objectId:'current',objectName:'Current'});assert.equal(unlinked.length,1);await unlinked[0].onclick();assert.equal(env.nodes.get('object-photos-shift').hidden,true);assert.deepEqual(env.gridIds(),['current-photo']);
});
test('rapid shift-to-object switching cannot display a delayed ancestor response over the selected object',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const env=fixture({onQuery:query=>query.some(([field])=>field==='shiftId')?gate:undefined});env.add('ancestor','old','previous');env.add('current-photo','new','current');
  const buttons=env.attach({objectId:'current',objectName:'Current',sourceShiftId:'old',photoShiftIds:['old']});const oldResponse=buttons[1].onclick();await env.click('all');assert.deepEqual(env.gridIds(),['current-photo']);release();await oldResponse;assert.deepEqual(env.gridIds(),['current-photo']);
});


test('UI clears visible photos immediately when access changes during refresh',async()=>{
  let pause=false,release;const gate=new Promise(resolve=>release=resolve);
  const env=fixture({onQuery:()=>pause?gate:undefined});env.add('private-photo','old','current');
  const buttons=env.attach({objectId:'current',objectName:'Current',sourceShiftId:'old'});await buttons[0].onclick();assert.deepEqual(env.gridIds(),['private-photo']);
  pause=true;const refresh=env.click('refresh');env.ctx.currentUid='other-account';release();await refresh;
  assert.equal(env.nodes.get('object-photos-dialog').open,false);assert.deepEqual(env.gridIds(),[]);
});

(async()=>{let failures=0;for(const {name,run} of tests){try{await run();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name);console.error(error);}}console.log(`${tests.length-failures}/${tests.length} shift photo tests passed`);if(failures)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
