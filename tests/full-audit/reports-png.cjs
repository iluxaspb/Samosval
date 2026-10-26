'use strict';
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const read = file => fs.readFileSync('test-app/src/' + file, 'utf8');
const helper = read('core/12-export-drawing.js');
const source = ['core/12-export-drawing.js', 'core/13-reports.js', 'core/08-plugins.js', 'core/14-archive.js'].map(read).join('\n');
function fixture(options = {}) {
  const config = {width:1400, height:1000, ...options};
  const downloads = [], elements = new Map(), workers = [], revoked = [], snapshots = [], errors = [];
  function element(tag) {
    return {tagName:tag.toUpperCase(), style:{}, children:[], parentNode:null, scrollWidth:config.width, scrollHeight:config.height,
      appendChild(node) { this.children.push(node); node.parentNode = this; return node; },
      removeChild(node) { this.children = this.children.filter(n => n !== node); node.parentNode = null; },
      remove() { this.parentNode?.removeChild(this); },
      click() { downloads.push({filename:this.download, href:this.href}); }
    };
  }
  const body = element('body');
  class Worker {
    constructor() { this.prop = {}; this.pending = Promise.resolve(); workers.push(this); }
    set(options) { this.options = options; return this; }
    from(inner) { this.inner = inner; return this; }
    toContainer() {
      this.pending = this.pending.then(() => {
        this.prop.container = element('div'); this.prop.overlay = element('div');
        this.prop.overlay.appendChild(this.prop.container); body.appendChild(this.prop.overlay);
      }); return this;
    }
    then(fn) { this.pending = this.pending.then(() => fn.call(this)); return this; }
    toCanvas() {
      this.pending = this.pending.then(async () => {
        assert.equal(this.prop.container.style.width, this.options.html2canvas.width + 'px', 'full width, not A4');
        assert.equal(this.options.pagebreak.mode.length, 0, 'no PDF pagination');
        if (config.pendingCanvas) return new Promise(() => {});
        if (config.onCanvas) await config.onCanvas(this);
        if (config.failCanvas) throw Error('render failed');
        const {width, height, scale} = this.options.html2canvas;
        this.prop.canvas = {width:Math.round(width * scale * (config.clipped ? .5 : 1)), height:Math.round(height * scale),
          toBlob(done, mime) {
            assert.equal(mime, 'image/png');
            if (!config.pendingBlob) done(config.emptyBlob ? null : new Blob(['PNG fixture'], {type:mime}));
          }};
        assert(this.prop.canvas.width * this.prop.canvas.height <= 16010000, '16MP canvas bound');
        assert(this.prop.canvas.width <= 8192 && this.prop.canvas.height <= 8192, 'canvas dimension bound');
        this.prop.overlay.remove();
      }); return this;
    }
    get(key) { return this.pending.then(() => this.prop[key]); }
  }
  const document = {body, createElement:element, getElementById:id => elements.get(id) || null,
    fonts: config.pendingFonts ? {load:()=>new Promise(()=>{}), ready:new Promise(()=>{})} : {load:()=>Promise.resolve(), ready:Promise.resolve()}};
  const c = {document, Blob, Promise, console:{warn(){},error:console.error}, innerWidth:1200, innerHeight:800, html2pdf:()=>new Worker(),
    setTimeout:(fn,ms)=>setTimeout(fn, [1000,2000,2500,60000].includes(ms) ? 1 : [15000,45000].includes(ms) ? 8 : ms), clearTimeout,
    URL:{createObjectURL:blob=>{assert.equal(blob.type,'image/png');return 'blob:png';},revokeObjectURL:url=>revoked.push(url)}};
  c.window=c;vm.createContext(c);vm.runInContext(helper,c);
  function installArchive() {
    const wrapper = {querySelector:()=>({}), cloneNode() {
      const snapshot=element('div'), sheet=element('div'), scroller=element('div');
      snapshot.querySelectorAll=()=>[];
      snapshot.getBoundingClientRect=()=>({left:0,width:config.width,height:config.height});
      snapshot.querySelector=selector=>selector==='.paper-report-container'?sheet:selector==='.paper-scroll-wrapper'?scroller:selector==='.paper-table'?{getBoundingClientRect:()=>({right:config.width-12})}:null;
      snapshots.push(snapshot);return snapshot;
    }};
    const button={disabled:false};
    elements.set('archiveModal',{querySelector:selector=>selector.includes('archive-paper-wrapper')?wrapper:button});
    Object.assign(c,{hasTabAccess:()=>true,hasPermission:()=>true,showError:e=>errors.push(e),showToastEl(){},viewingArchiveId:'archive',viewingArchiveGAITable:false,
      state:{archive:[{id:'archive',objectName:'Site/A',date:'2026-10-24'}]}});
    vm.runInContext(functionCode('saveArchivePNG')+'\n'+functionCode('exportArchivePNG'),c);
    return button;
  }
  return {c,config,body,downloads,elements,workers,revoked,snapshots,errors,element,installArchive};
}
function functionCode(name) {
  const start=source.indexOf('  async function '+name+'('); assert(start>=0,name);
  return source.slice(start,source.indexOf('\n  }',start)+'\n  }'.length);
}
(async()=>{
  for(const opts of [{},{width:10000,height:20000},{pendingFonts:true}]) {
    const f=fixture(opts),blob=await f.c.generatePNGFromHTML('<table>Отчёт</table>');
    assert.equal(blob.type,'image/png');assert.equal(f.body.children.length,0);
    f.c.downloadReportPNG(blob,'report.png');assert.equal(f.downloads[0].filename,'report.png');
    await new Promise(r=>setTimeout(r,5));assert.deepEqual(f.revoked,['blob:png']);
  }
  for(const opts of [{pendingCanvas:true},{pendingBlob:true},{emptyBlob:true},{clipped:true}]) {
    const f=fixture(opts);await assert.rejects(()=>f.c.generatePNGFromHTML('report'),/PNG|изображение/);assert.equal(f.body.children.length,0);
  }
  const f=fixture(), button=f.installArchive(), reportInputs=[];
  Object.assign(f.c,{getLogs:()=>[{isGAI:false},{isGAI:true}],getActiveLineIds:()=>['truck'],
    buildReportHTML:data=>{reportInputs.push(data);return '<table>report</table>';}});
  f.c.state.shift={objectName:'Site',startDate:'2026-10-25'};f.c.state.truckStatus={};
  vm.runInContext(functionCode('exportCurrentReportPNG'),f.c);
  await f.c.exportCurrentReportPNG('regular');await f.c.exportCurrentReportPNG('gai');await f.c.exportArchivePNG();
  assert.deepEqual(f.errors,[]);assert.equal(f.downloads.length,3);assert(f.downloads.every(d=>d.filename.endsWith('.png')));
  assert.equal(reportInputs.length,2,'archive never rebuilt or reordered');assert(reportInputs.every(i=>i.logs.length===1));
  assert.equal(f.workers.at(-1).inner,f.snapshots[0],'visible archive clone rasterized');assert.equal(button.disabled,false);
  const host=f.element('div');f.elements.set('pluginPdfButtonsContainer',host);
  f.c.pluginPdfButtons=[{label:'PDF plugin',generateHtmlFn:async()=>'<p>plugin</p>'}];
  const begin=source.indexOf('  function renderPluginPdfButtons()'),end=source.indexOf('  function renderPluginsList()',begin);
  vm.runInContext(source.slice(begin,end),f.c);f.c.renderPluginPdfButtons();
  assert.equal(host.children[0].textContent,'🖼 PNG plugin');await host.children[0].onclick();assert(f.downloads.at(-1).filename.startsWith('plugin_'));
  const count=f.downloads.length;f.c.hasTabAccess=()=>false;
  await f.c.exportCurrentReportPNG('regular');await f.c.exportArchivePNG();await host.children[0].onclick();assert.equal(f.downloads.length,count);
  f.c.hasTabAccess=()=>true;f.c.hasPermission=()=>false;f.c.viewingArchiveGAITable=true;
  await f.c.exportCurrentReportPNG('gai');await f.c.exportArchivePNG();assert.equal(f.downloads.length,count,'current/archive GAI permission guards');
  f.c.hasPermission=()=>true;
  let finish;f.config.onCanvas=()=>new Promise(resolve=>{finish=resolve;});
  const save=f.c.saveArchivePNG();assert.equal(button.disabled,true);
  while(!finish)await Promise.resolve();
  f.c.viewingArchiveId='another';f.c.viewingArchiveGAITable=false;finish();await save;
  assert.equal(f.downloads.at(-1).filename,'Site_A_2026-10-24_ГАИ.png','archive identity/type snapshotted before await');assert.equal(button.disabled,false);
  f.config.onCanvas=null;
  for(const opts of [{width:10000,height:20000},{pendingFonts:true},{pendingCanvas:true},{pendingBlob:true},{emptyBlob:true},{clipped:true},{failCanvas:true}]) {
    const a=fixture(opts),b=a.installArchive();await a.c.saveArchivePNG();assert.equal(b.disabled,false);assert.equal(a.body.children.length,0,'archive DOM cleaned');
    if(opts.pendingCanvas||opts.pendingBlob||opts.emptyBlob||opts.clipped||opts.failCanvas){assert.equal(a.downloads.length,0);assert.equal(a.errors.length,1);}
    else {assert.equal(a.downloads.length,1);assert.deepEqual(a.errors,[]);}
  }
  for(const forbidden of ['outputPdf(', 'enqueueMaxDocument', 'generatePDFFromHTML', 'setupStylus(', 'draw-canvas-', 'data-photo-object'])assert(!source.includes(forbidden),forbidden+' must stay removed');
  assert(read('features/summary-viewer.js').includes('archive-sheet-dialog'),'new archive fullscreen viewer retained');
  assert(read('core/14-archive.js').includes('class="archive-toggle-icon"'),'new icon toggle retained');
  console.log('PASS TEST PNG: current/GAI/archive/plugins; visible clone and async filename; full width/no pagination; 16MP/8192px bounds; font/canvas/blob timeouts, clipping/errors cleanup; no drawing/photos resurrected');
})().catch(error=>{console.error(error);process.exitCode=1;});
