'use strict';
// All data and failures are in memory. No Firebase initialization or network calls.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const W = 'workspaces/main_workspace/';
class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toDate() { return new Date(this.seconds * 1000 + this.nanoseconds / 1e6); }
}
function copy(v) {
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (v instanceof Date) return new Date(v);
  if (Array.isArray(v)) return Array.from(v, copy);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, copy(x)]));
  return v;
}
function fixture() {
  const data = new Map([
    ['settings/permissions', { admin: { import_backup: true, tabs: ['backup','timesheet'] } }],
    ['settings/appConfig', { gameMode: true, nested: { a: 1 } }],
    ['settings/appConfig_test', { testReviewFlags: { game_mode: true }, clock: new Timestamp(1700000000, 123456789) }],
    [W+'shift/current', { id: 'shift-1', isActive: false, objectName: 'Объект 🚛' }],
    ['users/admin', { name: 'Admin', role: 'admin', status: 'active' }],
  ]);
  for (const name of ['trucks','objects','archive','trash','logs','truckStatus','notifications','plugins','patches'])
    data.set(W+name+'/one', { name: 'Тест '+name, count: 2, enabled: false, optional: null, nested: { tags: ['a','б'], value: 0 } });
  for (const name of ['timesheetPeople','timesheetEquipment','timesheetEntries','timesheetMaterials','timesheetChanges'])
    data.set(W+name+'/one', { id: 'body-id', revision: 5, minutes: 720, committedAt: new Timestamp(1730000000, 987654321), changes: [{ minutes: 720, label: 'Часы' }] });
  for (let i=0;i<701;i++) data.set(W+'audit/event-'+i, { timestamp: i, eventType: i%2 ? 'game_arcade_receipt' : 'game_purchase', delta: i, text: 'Игра' });
  return data;
}
function harness(initial = fixture()) {
  const values = copyMap(initial), calls = [], errors = [], toasts = [], confirms = [], downloads = [];
  const fail = { read: null, write: null, metadata: null, transaction: null, afterCommit: null, beforeRead: null, confirm: null };
  let next = 0, transactionCount = 0;
  function snapshot(path) { return { id: path.split('/').at(-1), exists: values.has(path), data: () => copy(values.get(path)), ref: doc(path), metadata: { fromCache:false, hasPendingWrites:false, ...(fail.metadata ? fail.metadata(path) : {}) } }; }
  async function read(path, opts) {
    calls.push(['read', path, opts]);
    assert.equal(opts?.source, 'server', 'all non-transaction reads must explicitly require server data');
    if (fail.beforeRead) await fail.beforeRead(path);
    if (fail.read && fail.read(path)) throw Error('permission-denied: read '+path);
  }
  async function write(path, value, remove, opts) {
    calls.push(['write-attempt',path,remove?'delete':'set']);
    if (fail.write && fail.write(path, value, remove)) throw Error('permission-denied: write '+path);
    if (remove) values.delete(path);
    else values.set(path, opts?.merge ? {...copy(values.get(path)), ...copy(value)} : copy(value));
    calls.push(['write',path,remove?'delete':'set']);
  }
  class DocRef {
    constructor(path) { assert.equal(path.split('/').length%2,0,'strict document path: '+path); this.path=path;this.id=path.split('/').at(-1);this.firestore=db; }
    collection(n) { return collection(this.path+'/'+n); }
    async get(opts) { await read(this.path,opts);return snapshot(this.path); }
    set(value,opts) { return write(this.path,value,false,opts); }
    delete() { return write(this.path,null,true); }
    update(value) { return write(this.path,value,false,{merge:true}); }
  }
  class CollectionRef {
    constructor(path,field,direction,cap=Infinity) { assert.equal(path.split('/').length%2,1,'strict collection path: '+path);Object.assign(this,{path,field,direction,cap}); }
    doc(id) { return doc(this.path+'/'+(id||'copy-'+(++next))); }
    async add(data) {const ref=this.doc();await ref.set(data);return ref;}
    orderBy(field,direction) {return new CollectionRef(this.path,field,direction,this.cap);}
    limit(cap) {return new CollectionRef(this.path,this.field,this.direction,cap);}
    async get(opts) {
      const {path,field,direction,cap}=this;
      await read(path,opts);
      let rows=[...values].filter(([key])=>key.startsWith(path+'/')&&key.split('/').length===path.split('/').length+1);
      if(field)rows.sort((a,b)=>(direction==='desc'?-1:1)*((a[1][field]||0)-(b[1][field]||0)));
      const docs=rows.slice(0,cap).map(([key])=>snapshot(key));
      return {docs,size:docs.length,metadata:{fromCache:false,hasPendingWrites:false,...(fail.metadata?fail.metadata(path):{})}};
    }
  }
  function doc(path) { return new DocRef(path); }
  function collection(path) { return new CollectionRef(path); }
  const db = { collection, doc, batch:()=>{throw Error('Batch not permitted: backup must use one transaction');}, runTransaction: async fn=>{
    transactionCount++;
    if(fail.transaction) await fail.transaction();
    const actions=[], tx={get:async ref=>{calls.push(['transaction-read',ref.path]);if(fail.read&&fail.read(ref.path))throw Error('permission-denied: transaction read');return snapshot(ref.path);},
      set:(ref,value,opts)=>actions.push({ref,value,opts}), delete:ref=>actions.push({ref,remove:true})};
    await fn(tx);
    calls.push(['transaction-size',actions.length]);
    assert(actions.length<=500,'Firestore transaction write limit');
    // Permissions and write failure checked for EVERY operation before anything mutates.
    for(const op of actions) if(fail.write&&fail.write(op.ref.path,op.value,op.remove))throw Error('permission-denied: atomic transaction');
    for(const op of actions) { if(op.remove) values.delete(op.ref.path); else values.set(op.ref.path,op.opts?.merge?{...copy(values.get(op.ref.path)),...copy(op.value)}:copy(op.value)); calls.push(['transaction-write',op.ref.path]); }
    if(fail.afterCommit) throw Error('acknowledgement unavailable');
  } };
  const sandbox={ db, Blob, TextEncoder, crypto:webcrypto, firebase:{firestore:{Timestamp}},
    console:{log(){},warn(){},error(){}}, document:{getElementById:()=>null,createElement:tag=>({click(){downloads.push(this);}})},
    URL:{createObjectURL:blob=>{downloads.push(blob);return 'blob:mock';},revokeObjectURL(){}},
    setTimeout(){},setInterval(){}, localStorage:{getItem:()=>null,setItem(){}},
    WORKSPACE_ID:'main_workspace', refs:{trucks:collection(W+'trucks'),audit:collection(W+'audit')},currentUserRole:'admin',currentUserStatus:'active',currentUid:'admin',currentEmail:'admin@example.invalid',
    getUserName:()=> 'Admin',showToastEl:text=>toasts.push(text),showError:text=>errors.push(text),
    offlinePendingCount:()=>0,offlineUndeliveredEffects:()=>[],offlineJournalCanWrite:()=>true,navigator:{onLine:true},canAdmin:()=>sandbox.currentUserRole==='admin',hasPermission:()=>true,
    appConfirm:async text=>{confirms.push(text);return fail.confirm?fail.confirm(text):true;},location:{reload(){}},state:{shift:{isActive:false}}
  };
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('test-app/src/core/17-backup.js','utf8'),sandbox);
  vm.runInContext(fs.readFileSync('test-app/src/features/auto-backup.js','utf8'),sandbox);
  assert(sandbox.SamosvalBackup,'backup module initialized');
  return {installHistory:()=>vm.runInContext(fs.readFileSync('test-app/src/features/history-recorder.js','utf8'),sandbox),api:sandbox.SamosvalBackup,sandbox,values,calls,errors,toasts,confirms,downloads,fail,transactions:()=>transactionCount,
    live:()=>copyMap(new Map([...values].filter(([p])=>!p.startsWith('backups/')))), liveWrites:()=>calls.filter(c=>['write','transaction-write'].includes(c[0])&&!c[1].startsWith('backups/')),
    metas:()=>[...values].filter(([p])=>p.startsWith('backups/')&&p.split('/').length===2)};
}
function copyMap(map) {return new Map([...map].map(([k,v])=>[k,copy(v)]));}
module.exports={harness,fixture,W,Timestamp,copy};
