const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('test-app/source/core/08-png-export.js', 'utf8');
const pluginSource = fs.readFileSync('test-app/source/core/04-subscriptions.js', 'utf8');
const shell = fs.readFileSync('test-app/source/shell.html', 'utf8');
const helper = source.slice(source.indexOf('  async function generatePNGFromHTML('), source.indexOf('  // === STYLUS ==='));
assert(helper.includes("'image/png'"));
function dom(height = 1000) {
  const downloads = [], elements = new Map();
  function element(tag) {
    return {tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null, scrollWidth: 1400, scrollHeight: height,
      appendChild(node) { this.children.push(node); node.parentNode = this; return node; },
      removeChild(node) { this.children = this.children.filter(n => n !== node); node.parentNode = null; },
      append(node) { this.appendChild(node); }, remove() { this.parentNode?.removeChild(this); },
      click() { downloads.push({filename: this.download, href: this.href}); },
      toDataURL() { return 'data:image/png;base64,drawing'; }
    };
  }
  const body = element('body');
  return {downloads, elements, element, body, document: {body, createElement: element, getElementById: id => elements.get(id) || null, fonts: {load: () => Promise.resolve(), ready: Promise.resolve()}}};
}
function rasterFixture({height = 1000, pendingFonts = false, pendingCanvas = false, emptyBlob = false} = {}) {
  const d = dom(height), calls = [], created = [], revoked = [];
  class Worker {
    constructor() { this.prop = {}; this.pending = Promise.resolve(); }
    set(options) { this.options = options; calls.push('set'); return this; }
    from(inner) { this.inner = inner; calls.push('from'); return this; }
    toContainer() { this.pending = this.pending.then(() => { this.prop.container = d.element('div'); this.prop.overlay = d.element('div'); this.prop.overlay.appendChild(this.prop.container); d.body.appendChild(this.prop.overlay); }); return this; }
    then(fn) { this.pending = this.pending.then(() => fn.call(this)); return this; }
    toCanvas() {
      this.pending = this.pending.then(() => {
        calls.push('canvas');
        assert.equal(this.prop.container.style.width, '1400px', 'capture uses full report width');
        assert.equal(this.options.pagebreak.mode.length, 0, 'no PDF page splitting');
        if (pendingCanvas) return new Promise(() => {});
        this.prop.canvas = {width: Math.round(1400 * this.options.html2canvas.scale), height: Math.round(height * this.options.html2canvas.scale),
          toBlob: (done, mime) => { assert.equal(mime, 'image/png'); calls.push('png'); done(emptyBlob ? null : new Blob(['PNG fixture'], {type: mime})); }};
        assert(this.prop.canvas.width * this.prop.canvas.height <= 16010000);
        assert(this.prop.canvas.height <= 16384);
        this.prop.overlay.remove();
      }); return this;
    }
    get(key) { return this.pending.then(() => this.prop[key]); }
  }
  if (pendingFonts) d.document.fonts = {load: () => new Promise(() => {}), ready: new Promise(() => {})};
  const context = {document: d.document, Blob, console, Promise, html2pdf: () => new Worker(),
    setTimeout: (fn, ms) => setTimeout(fn, ms === 2000 || ms === 60000 ? 1 : pendingCanvas && ms === 45000 ? 5 : ms === 1000 ? 1 : ms), clearTimeout,
    URL: {createObjectURL: blob => { assert.equal(blob.type, 'image/png'); created.push(blob); return 'blob:png'; }, revokeObjectURL: url => revoked.push(url)}};
  vm.createContext(context); vm.runInContext(helper, context);
  return {...d, context, calls, created, revoked};
}
function functionCode(name) {
  const start = source.indexOf('  async function ' + name + '(');
  assert(start >= 0, name);
  const end = source.indexOf('\n  }', start) + '\n  }'.length;
  return source.slice(start, end);
}
(async () => {
  for (const opts of [{}, {height: 20000}, {pendingFonts: true}]) {
    const f = rasterFixture(opts), blob = await f.context.generatePNGFromHTML('<table><tr><td>Отчёт</td></tr></table>');
    assert.equal(blob.type, 'image/png'); assert(f.calls.includes('canvas')); assert(f.calls.includes('png')); assert.equal(f.body.children.length, 0);
    f.context.downloadReportPNG(blob, 'report.png'); assert.equal(f.downloads[0].filename, 'report.png');
    await new Promise(r => setTimeout(r, 5)); assert.deepEqual(f.revoked, ['blob:png']);
  }
  const hung = rasterFixture({pendingCanvas: true});
  await assert.rejects(() => hung.context.generatePNGFromHTML('report'), /Не удалось подготовить PNG/); assert.equal(hung.body.children.length, 0);
  const empty = rasterFixture({emptyBlob: true});
  await assert.rejects(() => empty.context.generatePNGFromHTML('report'), /Не удалось сохранить изображение/); assert.equal(empty.body.children.length, 0);

  const f = rasterFixture(), reportInputs = [], errors = [], requests = [];
  Object.assign(f.context, {state: {shift: {objectName: 'Site', startDate: '2026-10-25'}, truckStatus: {}, archive: [{id: 'archive', objectName: 'Site', date: '2026-10-24', logs: [{isGAI: false}, {isGAI: true}], activeLineIds: ['truck'], ttnStatus: {truck: true}}]},
    objectTitle: (_id, fallback) => fallback, getLogs: () => [{isGAI: false}, {isGAI: true}], hasPermission: () => true, getActiveLineIds: () => ['truck'],
    buildReportHTML: data => { reportInputs.push(data); return '<table>report</table>'; }, showToastEl() {}, showError: e => errors.push(e), viewingArchiveId: 'archive', viewingArchiveGAITable: false,
    generatePNGFromHTML: async html => { requests.push(html); return new Blob(['png'], {type: 'image/png'}); }});
  // A real archive image must be a clone of the visible report, never rebuilt from logs.
  const snapshot = f.element('div'), sheet = f.element('div'), scroller = f.element('div'), table = f.element('table');
  const sourcePaper = f.element('div');
  snapshot.querySelectorAll = () => [];
  snapshot.getBoundingClientRect = () => ({left:0, width:1400, height:1000});
  table.getBoundingClientRect = () => ({right:1380});
  snapshot.querySelector = selector => selector === '.paper-report-container' ? sheet
    : selector === '.paper-scroll-wrapper' ? scroller : selector === '.paper-table' ? table : null;
  const wrapper = {cloneNode: () => snapshot, querySelector: selector =>
    selector === '.paper-report-container' ? sourcePaper : null};
  const saveButton = {disabled:false};
  f.elements.set('archiveModal', {querySelector: selector =>
    selector.includes('archive-paper-wrapper') ? wrapper : saveButton});
  const archiveSnapshots = [], makeWorker = f.context.html2pdf;
  f.context.window = {innerWidth:1200, innerHeight:800, html2pdf: () => {
    const worker = makeWorker(), originalFrom = worker.from;
    worker.from = function(node) { archiveSnapshots.push(node); return originalFrom.call(this,node); };
    return worker;
  }};
  Object.assign(f.context, {hasTabAccess: () => true, getComputedStyle: () => ({zoom:'1'})});
  vm.runInContext(functionCode('exportCurrentReportPNG') + '\n' + functionCode('exportArchivePNG'), f.context);
  await f.context.exportCurrentReportPNG('regular');
  await f.context.exportCurrentReportPNG('gai');
  await f.context.exportArchivePNG();
  assert.equal(f.downloads.length, 3);
  assert(f.downloads.every(d => d.filename.endsWith('.png')));
  assert.deepEqual(errors, []);
  assert.equal(reportInputs[0].logs.length, 1);
  assert.equal(reportInputs[1].logs.length, 1);
  assert.equal(reportInputs.length, 2, 'archive must not re-build or re-sort the visible report');
  assert.equal(archiveSnapshots[0], snapshot, 'PNG must rasterize visible report clone');
  assert.equal(saveButton.disabled, false, 'button re-enabled after export');
  const pluginHost = f.element('div'); f.elements.set('pluginPdfButtonsContainer', pluginHost);
  f.context.pluginPdfButtons = [{label: 'PDF plugin', generateHtmlFn: () => '<p>plugin</p>'}];
  const begin = pluginSource.indexOf('  function renderPluginPdfButtons()'), end = pluginSource.indexOf('  function renderPluginsList()', begin);
  assert(begin>=0 && end>begin, 'Plugin PNG source boundaries missing');
  vm.runInContext(pluginSource.slice(begin, end), f.context); f.context.renderPluginPdfButtons();
  assert.equal(pluginHost.children[0].textContent, '🖼 PNG plugin'); await pluginHost.children[0].onclick();
  assert(f.downloads.at(-1).filename.startsWith('plugin_')); assert(f.downloads.at(-1).filename.endsWith('.png'));
  assert(!shell.includes('onclick="exportCurrentReportPDF')); assert(!shell.includes('onclick="exportArchivePDF'));
  console.log('PASS PNG exports: main/GAI/archive/plugin filenames and MIME; full-width canvas without PDF pagination; bounded long image, font/render failures and DOM cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
