'use strict';
// Real browser acceptance, real Firestore/IndexedDB; explicitly NOT real Firebase
// Auth, a production deployment, physical mobile hardware, or a camera test.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), {spawn} = require('node:child_process');
const {PROJECT, DEMO_CONFIG, allowedUrl, createLocalServer, installBrowserFixture, pngDetails, readWithRulesDisabled} = require('./browser-support.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(__dirname, 'results', 'browser'); fs.mkdirSync(output, {recursive:true});
const port = Number(process.env.AUDIT_FIRESTORE_PORT || 8099);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'samosval-audit-browser-'));
const report = {startedAt:new Date().toISOString(), status:'running', project:PROJECT,
  rules:'firestore-timesheet-test.rules', browser:'Chromium with sandbox enabled',
  modes:['desktop 1280×900', 'mobile viewport 390×844 (Chromium emulation)'],
  fixture:{auth:'Explicit local UI stub; no Firebase Auth service contacted', firestore:'Real Firebase SDK and emulator mock-user tokens',
    sourceChanges:'HTTP responses only: demo project identifiers, inert Firebase configuration and matching worker integrity hashes; repository sources remain untouched',
    externalTraffic:'Blocked by exact-origin routing and CSP on documents/service workers; Storage disabled, MAX not configured',
    data:'Generated example.test identities and local demo data only'},
  exclusions:['Real Firebase Auth/password delivery', 'Production/live project rules deployment', 'Physical iOS/Android installation',
    'Physical camera/GPS/Storage upload', 'External MAX delivery', 'Security/exploit payload execution',
    'Summary export controls are intentionally hidden in the approved paper-viewer layout; CSV uses callable API coverage, not a visible click',
    'PWA release-update activation (covered separately by sandbox-required tests/pwa/update-browser.py)'],
  cases:[], steps:[], pageErrors:[], console:[], blockedRequests:[], cspViolations:[], serverRequests:[], cleanup:[]};
let env, emulator, server, origin, chromium, sdk, activeContext, page, currentCase = 'setup', traceNumber = 0;
let emulatorLog = '', fatalError, stopped = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanName = s => s.replace(/[^a-zA-Z0-9_-]+/g, '-');
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const wait = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, {timeout});

async function evidence(name) {
  if (!page || page.isClosed()) return;
  const file = cleanName(currentCase + '-' + name);
  try { await page.screenshot({path:path.join(output, file + '.png'), fullPage:true, timeout:10000}); }
  catch (error) { report.console.push({type:'evidence-error',text:error.message}); }
  if (name.includes('failure')) {
    try { fs.writeFileSync(path.join(output, file + '.html'), await page.content()); } catch (_) {}
    try { fs.writeFileSync(path.join(output, file + '-state.json'), JSON.stringify(await page.evaluate(() => ({
      fixture:window.__auditFixture, status:typeof currentUserStatus === 'undefined' ? null : currentUserStatus,
      permissions:typeof permissionsLoaded === 'undefined' ? null : permissionsLoaded,
      shift:typeof state === 'undefined' ? null : state.shift,
      sync:typeof syncState === 'undefined' ? null : syncState,
      pending:typeof offlinePendingCount === 'function' ? offlinePendingCount() : null,
      dialogs:[...document.querySelectorAll('dialog[open],.modal.open,.pcm-overlay')].map(e => ({id:e.id,text:e.textContent.slice(0,2000)}))
    })), null, 2)); } catch (_) {}
  }
}

async function step(name, action) {
  const entry = {case:currentCase,name,status:'running',startedAt:new Date().toISOString()}; report.steps.push(entry); persist();
  const start = Date.now();
  try { await action(); entry.status = 'passed'; console.log('PASS browser:', currentCase, name); }
  catch (error) { entry.status = 'failed'; entry.error = error.stack || String(error); await evidence(name + '-failure'); throw error; }
  finally { entry.durationMs = Date.now() - start; persist(); }
}

async function closeContext() {
  if (!activeContext) return;
  const context = activeContext; activeContext = null;
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    try { const detail = await p.evaluate(() => window.__auditFixture); if (detail) {
      assert.equal(detail.blockedStorageCalls, 0, 'Unexpected Storage operation');
    } } catch (error) { report.pageErrors.push({case:currentCase,type:'closing-page',message:error.message}); }
  }
  try { await context.tracing.stop({path:path.join(output, cleanName(currentCase) + '-trace-' + (++traceNumber) + '.zip')}); }
  finally { await context.close(); page = null; }
}

async function launch(profile, uid, mobile, offline = false, initiallySignedIn = false) {
  assert(!activeContext, 'Previous context must be closed first');
  // Never retry a launch by disabling Chromium/OS security. Unsupported sandbox
  // environments fail visibly; CI must provide an authorized supported runner.
  activeContext = await chromium.launchPersistentContext(profile, {
    executablePath:process.env.AUDIT_BROWSER || process.env.PWA_BROWSER || undefined,
    chromiumSandbox:true, headless:true, viewport:mobile ? {width:390,height:844} : {width:1280,height:900},
    isMobile:mobile, hasTouch:mobile, locale:'ru-RU', timezoneId:'Europe/Moscow', acceptDownloads:true,
    serviceWorkers:'allow', timeout:30000
  });
  activeContext.setDefaultTimeout(15000);
  await activeContext.tracing.start({screenshots:true,snapshots:true,sources:true});
  // Persist failures immediately; a subsequent successful reload cannot erase them.
  await activeContext.exposeBinding('__auditReport', (_source,type,detail) => {
    (type==='csp' ? report.cspViolations : report.pageErrors).push({case:currentCase,type,...detail});
  });
  await activeContext.addInitScript(installBrowserFixture, {port,uid,project:PROJECT,config:DEMO_CONFIG,initiallySignedIn});
  await activeContext.route('**/*', route => {
    const url = route.request().url();
    if (allowedUrl(url, origin, port)) return route.continue();
    report.blockedRequests.push({case:currentCase,url,method:route.request().method()}); return route.abort('blockedbyclient');
  });
  activeContext.on('page', p => {
    p.on('pageerror', error => report.pageErrors.push({case:currentCase,type:'pageerror',message:error.stack || error.message}));
    p.on('console', message => report.console.push({case:currentCase,type:message.type(),text:message.text()}));
    p.on('dialog', dialog => { report.pageErrors.push({case:currentCase,type:'unexpected-native-dialog',message:dialog.message()}); dialog.dismiss(); });
  });
  await activeContext.setOffline(offline);
  page = await activeContext.newPage();
  await page.goto(origin + '/Samosval/index-test.html', {waitUntil:'load',timeout:30000});
  await wait(() => window.__auditFixture?.ready === true);
  assert.equal(await page.evaluate(() => firebase.app().options.projectId), PROJECT);
}

async function readRows(name) {
  return readWithRulesDisabled(env,async context => (await sdk.getDocs(sdk.collection(context.firestore(), 'workspaces/main_workspace/' + name))).docs.map(d => ({id:d.id,...d.data()})));
}
async function writeDoc(name, data, merge = false) {
  return env.withSecurityRulesDisabled(context => sdk.setDoc(sdk.doc(context.firestore(), name), data, {merge}));
}
async function readDoc(name) {
  return readWithRulesDisabled(env,async context => (await sdk.getDoc(sdk.doc(context.firestore(),name))).data());
}
async function seed() {
  await env.clearFirestore();
  const rows = {
    'users/qa-active':{email:'qa-active@example.test',nickname:'Локальная проверка',role:'admin',status:'active'},
    'users/qa-viewer':{email:'qa-viewer@example.test',nickname:'Наблюдатель',role:'viewer',status:'active'},
    'users/qa-disabled':{email:'qa-disabled@example.test',nickname:'Закрытый доступ',role:'viewer',status:'disabled',rejectionReason:'Локальная проверка отказа'},
    'settings/permissions':{admin:{tabs:['line','report','archive','trucks','analytics','backup','admin','timesheet'],actions:[]},viewer:{tabs:['line','report'],actions:['view_header']}},
    'settings/appConfig':{cycleMinutes:15,maxEnabled:false,maxUrl:'',maxToken:'',maxChatId:'',testReviewFlags:{game_mode:true,game_sound:false,game_effects:false,arcade_enabled:true,arcade_invites:false}},
    'workspaces/main_workspace/objects/qa-object':{name:'Локальный учебный объект'},
    'workspaces/main_workspace/trucks/qa-truck':{brand:'Учебный КАМАЗ',number:'А123АА78',defaultVol:20,isGAI:false},
    'workspaces/main_workspace/trucks/qa-offline':{brand:'Офлайн КАМАЗ',number:'В456ВВ78',defaultVol:18,isGAI:false},
    'workspaces/main_workspace/timesheetPeople/p1':{name:'Учебный Иван',group:'operator',deleted:false,revision:1},
    'workspaces/main_workspace/timesheetPeople/p2':{name:'Учебный Сергей',group:'operator',deleted:false,revision:1},
    'workspaces/main_workspace/timesheetEquipment/m1':{name:'Учебная фреза',ownership:'own',contractor:'',crewIds:['p1','p2'],deleted:false,revision:1}
  };
  for (const [name,data] of Object.entries(rows)) await writeDoc(name,data);
}

async function login(uid) {
  await page.locator('#authOverlay').waitFor({state:'visible'});
  await page.locator('#authEmail').fill(uid + '@example.test');
  await page.locator('#authPassword').fill('local-demo-password');
  await page.locator('#authOverlay button[onclick="handleLogin()"]').click();
}
async function ready() {
  await wait(() => permissionsLoaded && currentUserStatus === 'active' && state.trucks.length === 2 && state.objects.length === 1
    && (!navigator.onLine || syncState.everConnected.shift && syncState.everConnected.logs && syncState.everConnected.status));
}
async function confirm(accept = true, expectedMessage) {
  const overlay=page.locator('.pcm-overlay.pcm-open');
  await overlay.waitFor({state:'visible'});
  if (expectedMessage) assert.match(await overlay.locator('.pcm-message').innerText(),expectedMessage);
  const current=await overlay.elementHandle(); assert(current);
  await overlay.locator(accept ? '.pcm-btn-confirm' : '.pcm-btn-cancel').click();
  // A legitimate successor prompt may appear immediately (optional backup →
  // final close). Wait for THIS dismissed instance, never every future modal.
  await current.waitForElementState('hidden'); await current.dispose();
}
async function nav(name) { await page.locator('#nav-' + name).click(); await page.locator('#tab-' + name + '.active').waitFor({state:'visible'}); }
async function toggleCheckbox(id, checked) {
  if (await page.locator('#' + id).isChecked() !== checked) {
    // The real checkboxes are intentionally 0×0; click their visible label
    // slider, not a forced/JavaScript event on an inaccessible input.
    await page.locator('#' + id + ' + .toggle-slider').click();
  }
  await wait(({id,checked}) => document.getElementById(id).checked === checked && !document.getElementById(id).disabled,{id,checked});
}
async function hold(truck, kind, milliseconds = 650) {
  const cls = {arrive:'btn-arrive',load:'btn-quick',ttn:'btn-ttn'}[kind];
  await page.locator('.truck-card[data-truck-id="' + truck + '"] .action-row .' + cls).click({delay:milliseconds});
}
async function chooseTruck(id) {
  await page.locator('#selectTrucksBtn').click();
  await page.locator('#selectorModal button[onclick="toggleLineTruck(\'' + id + '\')"]').click();
  await wait(id => !!state.truckStatus[id]?.onLine, id);
  await page.locator('#selectorModal > .modal-content > button[onclick="closeSelectorModal()"]').click();
}
async function assertNoUnexpectedErrors() {
  const fixture = await page.evaluate(() => window.__auditFixture);
  assert.deepEqual(fixture.errors, [], 'Unhandled browser promise rejection');
  assert.deepEqual(fixture.csp, [], 'Application attempted a disallowed resource');
  assert.equal(fixture.blockedStorageCalls, 0);
  assert.deepEqual(report.pageErrors.filter(e => e.case === currentCase), [], 'Browser exception');
  assert.deepEqual(report.blockedRequests.filter(e => e.case === currentCase), [], 'External network attempt');
}

async function assertRemovedFeatures() {
  assert.equal(await page.locator('#admin-camera-button,[id^="geo-photo"],[id^="object-photos"],[id^="local-photos"],.stylus-canvas').count(),0);
  const scripts=await page.locator('script[src]').evaluateAll(nodes=>nodes.map(node=>node.src));
  assert(!scripts.some(src=>/firebase-storage|geo-photo|object-photos|local-photos|photo-files/.test(src)),'Removed photo/Storage module returned');
  assert.equal(await page.locator('#tab-report,#archiveModal').getByRole('button',{name:/^(?:.*Рисовать|Очистить)$/}).count(),0);
}

async function assertSummarySheets() {
  await page.locator('#paperReportWrapper').waitFor({state:'visible'});
  assert(await page.locator('#paperReportContainer .paper-table').isVisible(),'Regular sheet is not visible');
  assert.equal(await page.locator('#gaiReportWrapper').isVisible(),false);
  await page.locator('#toggleReportBtn').click();
  await page.locator('#toggleReportBtn').click({delay:350});
  assert.equal(await page.locator('#gaiReportWrapper').isVisible(),false,'Short/released hold must not switch sheets');
  const toggleBounds=await page.locator('#toggleReportBtn').boundingBox(); assert(toggleBounds);
  await page.mouse.move(toggleBounds.x+toggleBounds.width/2,toggleBounds.y+toggleBounds.height/2);
  await page.mouse.down(); await page.mouse.move(toggleBounds.x-30,toggleBounds.y+toggleBounds.height/2);
  await delay(900); await page.mouse.up();
  assert.equal(await page.locator('#gaiReportWrapper').isVisible(),false,'Moving away must cancel the hold');
  for (const gai of [false,true]) {
    if (gai) await page.locator('#toggleReportBtn').click({delay:1800});
    const paper=gai?'#gaiPaperContainer':'#paperReportContainer';
    await page.locator(paper).waitFor({state:'visible'});
    assert.equal(await page.locator(gai?'#paperReportWrapper':'#gaiReportWrapper').isVisible(),false);
    assert.equal(await page.evaluate(()=>showGAITable),gai,'Hold must switch the actual report state once');
    assert.equal(await page.locator('#toggleReportBtn').innerText(),'📄','Switch stays icon-only');
    const tableText=await page.locator(paper+' .paper-table').innerText();
    await page.locator(paper).click({position:{x:40,y:35}});
    await page.locator('#summary-sheet-dialog[open] .paper-table').waitFor({state:'visible'});
    assert.match(await page.locator('#summary-sheet-dialog .paper-object-name').innerText(),/Локальный учебный объект/);
    assert.match(await page.locator('#summary-sheet-dialog .paper-total-info').innerText(),gai?/Всего рейсов ГАИ/:/Общий объем/);
    assert.equal(await page.locator('#summary-sheet-dialog .paper-table').innerText(),tableText,'Viewer must clone the selected sheet, not the other report');
    const scale=await page.locator('#summary-sheet-dialog .sheet-scale').innerText();
    await page.locator('#summary-sheet-dialog [data-action="in"]').click();
    assert.notEqual(await page.locator('#summary-sheet-dialog .sheet-scale').innerText(),scale);
    await page.locator('#summary-sheet-dialog [data-action="fit"]').click();
    await page.keyboard.press('Escape'); await page.locator('#summary-sheet-dialog').waitFor({state:'detached'});
    await page.locator(paper).click({position:{x:40,y:35}});
    await page.locator('#summary-sheet-dialog [data-action="close"]').click();
    await page.locator('#summary-sheet-dialog').waitFor({state:'detached'});
  }
  await page.locator('#toggleReportBtn').click({delay:950});
  await page.locator('#paperReportWrapper').waitFor({state:'visible'});
  // The user-approved benchmark intentionally hides legacy Summary export rows.
  // Preserve that UI; API export coverage below is labelled separately.
  assert.equal(await page.locator('button[onclick="exportCSV()"]').isVisible(),false);
  for (const type of ['regular','gai']) assert.equal(await page.locator('button[onclick="exportCurrentReportPNG(\''+type+'\')"]').isVisible(),false);
}

async function authenticationCases() {
  await step('admin-only-release-history-and-role-revocation', async () => {
    await launch(path.join(work,'roles'),'qa-viewer',false);
    assert.equal(await page.locator('#mainHeader .version-text').isVisible(),false,'Signed-out release label');
    await login('qa-viewer'); await ready();
    assert.equal(await page.locator('#mainHeader .version-text').isVisible(),false,'Viewer release label');
    // Deliberate negative authorization probe, not a claimed visible user click.
    await page.locator('#mainHeader .version-text').evaluate(node=>node.click());
    assert.equal(await page.locator('#releaseHistoryDialog').count(),0);
    await page.locator('#mainHeader .gear-btn').click();
    assert.equal(await page.locator('#test-pwa-version').isVisible(),false,'Viewer release diagnostics');
    await page.locator('#settingsModal button[onclick="closeSettingsModal()"]').last().click();
    await writeDoc('users/qa-viewer',{role:'admin'},true);
    await wait(()=>permissionsLoaded && currentUserRole==='admin');
    await page.locator('#mainHeader .version-text').waitFor({state:'visible'});
    assert.equal(await page.locator('#mainHeader .version-text').innerText(),report.release);
    await page.locator('#mainHeader .version-text').click();
    await page.locator('#releaseHistoryDialog[open]').waitFor({state:'visible'});
    assert((await page.locator('#releaseHistoryDialog h3').first().innerText()).startsWith(report.release.replace(/^Версия /,'')));
    await writeDoc('users/qa-viewer',{role:'viewer'},true);
    await wait(()=>permissionsLoaded && currentUserRole==='viewer');
    await page.locator('#releaseHistoryDialog').waitFor({state:'detached'});
    assert.equal(await page.locator('#mainHeader .version-text').isVisible(),false);
    await assertNoUnexpectedErrors(); await closeContext();
  });
  await step('registration-pending-approval-logout', async () => {
    await launch(path.join(work,'pending'), 'qa-pending', false);
    await page.locator('#authOverlay').waitFor({state:'visible'});
    await page.locator('#authEmail').fill('qa-pending@example.test'); await page.locator('#authPassword').fill('local-demo-password');
    await page.locator('#registerBtn').dblclick();
    await page.locator('#pendingScreen').waitFor({state:'visible'});
    await wait(() => document.getElementById('registrationStatusText').textContent.includes('заявка отправлена'));
    assert.equal(await page.evaluate(() => window.__auditFixture.authCalls.filter(c => c === 'register').length), 1);
    assert.equal(await page.locator('.container').isVisible(), false);
    await evidence('pending');
    await writeDoc('users/qa-pending',{role:'admin',status:'active'},true); await ready();
    await page.locator('#userBadgeLabel').click(); await confirm(false);
    assert.equal(await page.evaluate(() => currentUid), 'qa-pending');
    await page.locator('#userBadgeLabel').click(); await confirm(true);
    await page.locator('#authOverlay').waitFor({state:'visible'});
    assert.equal(await page.evaluate(() => currentUid), '');
    assert.equal(await page.locator('#authPassword').inputValue(), '');
    await assertNoUnexpectedErrors(); await closeContext();
  });
  await step('disabled-account-gate', async () => {
    await launch(path.join(work,'disabled'), 'qa-disabled', true); await login('qa-disabled');
    await page.locator('#disabledScreen').waitFor({state:'visible'});
    assert.equal(await page.locator('.container').isVisible(), false);
    assert.match(await page.locator('#disabledStatusText').innerText(), /Локальная проверка отказа/);
    assert.equal(await page.evaluate(() => permissionsLoaded), false); await evidence('disabled');
    await page.locator('#disabledScreen button').click(); await confirm();
    await page.locator('#authOverlay').waitFor({state:'visible'}); await assertNoUnexpectedErrors(); await closeContext();
  });
}

async function responsiveCase(mobile) {
  const profile = path.join(work, mobile ? 'mobile' : 'desktop');
  await step('login-validation-and-local-identity', async () => {
    await launch(profile, 'qa-active', mobile);
    await page.locator('#authOverlay').waitFor({state:'visible'});
    await page.locator('#authOverlay button[onclick="handleLogin()"]').click();
    assert.match(await page.locator('#authError').innerText(), /Укажите Email/);
    await page.locator('#authEmail').fill('qa-active@example.test'); await page.locator('#authPassword').fill('wrong-fixture-password');
    await page.locator('#authOverlay button[onclick="handleLogin()"]').click();
    await wait(() => document.getElementById('authError').textContent.includes('Неверный'));
    await login('qa-active'); await ready();
    await assertRemovedFeatures();
    assert.equal(await page.locator('#mainHeader .version-text').innerText(),report.release);
    assert.equal(await page.locator('#authPassword').inputValue(), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('dt_saved_pass')), null);
  });
  await step('start-cancel-reopen-and-add-line', async () => {
    await page.locator('#startShiftBtn').click();
    await page.locator('#startShiftModal button[onclick="closeStartShiftModal()"]').click();
    assert.equal(await page.evaluate(() => state.shift), null);
    await page.locator('#startShiftBtn').click();
    await page.locator('#existingObjectsList button').dblclick();
    await wait(() => state.shift?.isActive && !startShiftInFlight);
    assert.equal((await readRows('shift')).length, 1);
    await chooseTruck('qa-truck');
    assert.equal((await readRows('truckStatus')).length, 1);
    await page.locator('#selectTrucksBtn').click(); await page.locator('#truckSearchInput').fill('не найдено');
    await page.locator('#selectorModal button[onclick="closeSelectorModal()"]').last().click();
    await page.locator('#selectTrucksBtn').click(); assert.equal(await page.locator('#truckSearchInput').inputValue(), '');
    await page.locator('#selectorModal button[onclick="closeSelectorModal()"]').last().click();
  });
  await step('arrival-load-ttn-undo-with-real-pointer-events', async () => {
    await hold('qa-truck','arrive',100); assert.equal(await page.evaluate(() => !!state.truckStatus['qa-truck'].arriveStatus), false);
    await hold('qa-truck','arrive'); await wait(() => !!state.truckStatus['qa-truck'].arriveStatus);
    await hold('qa-truck','load'); await wait(() => getLogs().length === 1 && !state.truckStatus['qa-truck'].arriveStatus && offlinePendingCount() === 0 && !offlineReplayRunning);
    assert.equal((await readRows('logs')).length, 1);
    assert(await page.locator('.truck-card[data-truck-id="qa-truck"] .btn-arrive').isDisabled());
    assert(await page.locator('.truck-card[data-truck-id="qa-truck"] .action-row .btn-quick').isDisabled());
    await hold('qa-truck','ttn'); await wait(() => state.truckStatus['qa-truck'].ttnStatus === true && offlinePendingCount() === 0 && !offlineReplayRunning && lastValidNotification()?.type === 'ttn' && !lastValidNotification().offlinePending);
    await page.locator('#statusTicker .btn-undo').click(); await confirm(false);
    assert.equal(await page.evaluate(() => state.truckStatus['qa-truck'].ttnStatus), true);
    await page.locator('#statusTicker .btn-undo').click(); await confirm();
    await wait(() => !state.truckStatus['qa-truck'].ttnStatus && !undoActionInFlight);
    await wait(() => document.querySelector('#game-penalty-notice button'));
    await page.locator('#game-penalty-notice button').click();
    await hold('qa-truck','ttn'); await wait(() => state.truckStatus['qa-truck'].ttnStatus === true && offlinePendingCount() === 0 && !offlineReplayRunning);
    assert.equal((await readRows('logs')).length, 1); await evidence('line');
  });
  await step('report-sheets-csv-api-and-edit-cancel', async () => {
    await nav('report'); await wait(() => document.getElementById('matrixTableBody').textContent.includes('20'));
    await assertSummarySheets();
    assert.match(await page.locator('#paperTotalVolume').innerText(), /20/);
    await page.locator('#logsContainer .btn-edit').first().click(); await page.locator('#editLogVolume').fill('99');
    await page.locator('#editLogModal button[onclick="closeEditLogModal()"]').last().click();
    assert.equal((await readRows('logs'))[0].volume, 20);
    const downloaded = page.waitForEvent('download'); await page.evaluate(()=>exportCSV());
    const file = await downloaded; await file.saveAs(path.join(output,currentCase + '-report.csv'));
    const csv = fs.readFileSync(path.join(output,currentCase + '-report.csv'),'utf8'); assert(csv.includes('20')); assert(csv.includes('А123АА78'));
    await evidence('report');
  });
  await step('close-cancel-double-close-archive-reopen-restore', async () => {
    await page.locator('#closeShiftBtn').click();
    await confirm(false,/Перед закрытием смены создать резервную копию/);
    await confirm(false,/^Закрыть смену\?$/);
    assert.equal(await page.evaluate(() => state.shift.isActive), true);
    assert.equal((await readRows('archive')).length,0,'Cancel final close must not archive the shift');
    await page.locator('.pcm-overlay').waitFor({state:'detached'});
    await page.locator('#closeShiftBtn').dblclick();
    await page.locator('.pcm-overlay.pcm-open').waitFor({state:'visible'});
    const closePrompt=await page.locator('.pcm-overlay.pcm-open .pcm-message').innerText();
    // A real second pointer click can cancel the optional backup backdrop. The
    // final close confirmation is still mandatory, and never accepted blindly.
    if (/Перед закрытием смены создать резервную копию/.test(closePrompt)) await confirm(false,/Перед закрытием смены создать резервную копию/);
    else assert.match(closePrompt,/^Закрыть смену\?$/);
    await confirm(true,/^Закрыть смену\?$/);
    await wait(() => !state.shift && state.archive.length === 1 && !closeShiftInFlight);
    assert.equal((await readRows('archive')).length, 1); assert.equal((await readRows('logs')).length, 0);
    await nav('archive'); await page.locator('#archiveSearchToggle').click(); await page.locator('#archiveSearchInput').fill('учебный');
    await page.locator('.archive-shift-item').first().click(); await page.locator('#archiveModal.open').waitFor({state:'visible'});
    assert.match(await page.locator('#modalArchiveBody').innerText(), /20/);
    await page.locator('#archiveModal button[onclick="closeArchiveModal()"]').click();
    await page.locator('.archive-shift-item').first().click();
    await page.locator('#archiveRestoreBtn').click(); await confirm(false);
    assert.equal((await readRows('archive')).length, 1);
    await page.locator('#archiveRestoreBtn').dblclick(); await confirm();
    await wait(() => state.shift?.isActive && !state.shift.restoring && state.archive.length === 0 && getLogs().length === 1 && !archiveRestoreInFlight);
    assert.equal((await readRows('archive')).length, 0); assert.equal((await readRows('logs')).length, 1);
    assert.equal((await readRows('truckStatus')).length, 1);
    await nav('line'); await evidence('restored');
  });
  await step('settings-theme-preview-and-game-toggle-persistence', async () => {
    await page.locator('#mainHeader .gear-btn').click(); await page.locator('#settingsModal.open').waitFor({state:'visible'});
    await page.locator('#settingHoldLoad').fill('0.5'); await page.locator('#settingHoldLoad').press('Tab');
    await toggleCheckbox('hapticLoad',false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dt_settings')).hapticLoad), false);
    assert(await page.locator('#test-pwa-settings').isVisible());
    await page.locator('#settingsModal').getByRole('button',{name:'🛍 Лавка дорожника',exact:true}).click();
    await page.locator('#road-shop-dialog[open]').waitFor({state:'visible'});
    await page.locator('#road-shop-preview').selectOption('roadworks');
    await wait(() => RoadShop.getAppliedTheme() === 'roadworks');
    await page.locator('#road-shop-dialog [data-step="1"]').click(); assert.notEqual(await page.evaluate(() => RoadShop.getAppliedTheme()), 'roadworks');
    await page.locator('#road-shop-dialog .shop-close').click(); await wait(() => RoadShop.getAppliedTheme() === '');
    await page.locator('#mainHeader .gear-btn').click(); await page.locator('#settingsModal button[onclick="closeSettingsModal()"]').last().click();
    await nav('admin'); await page.locator('button[onclick="switchAdminTab(\'appsettings\', this)"]').click();
    await page.locator('#game-admin > summary').click(); await toggleCheckbox('game_mode',false);
    await wait(() => appConfig.testReviewFlags.game_mode === false && document.getElementById('game-wallet').hidden);
    await toggleCheckbox('game_mode',true); await wait(() => appConfig.testReviewFlags.game_mode === true && !document.getElementById('game-wallet').hidden);
    for (const [kind,value] of Object.entries({load:'1',arrive:'2',ttn:'0'})) assert.equal(await page.locator('#game-reward-'+kind).inputValue(),value);
    await page.locator('#game-reward-load').fill('-1'); await page.locator('#game-rewards-save').click();
    assert.match(await page.locator('#game-rewards-status').innerText(),/целые числа/);
    assert.equal((await readDoc('settings/appConfig')).gameRewardSchedule,undefined,'Invalid reward configuration must not write');
    for (const [kind,value] of Object.entries({load:'2',arrive:'3',ttn:'4'})) await page.locator('#game-reward-'+kind).fill(value);
    await page.locator('#game-rewards-save').click();
    await wait(()=>document.getElementById('game-rewards-status').textContent.startsWith('Сохранено'));
    const schedule=(await readDoc('settings/appConfig')).gameRewardSchedule;
    assert.equal(schedule.length,1); assert.deepEqual({load:schedule[0].load,arrive:schedule[0].arrive,ttn:schedule[0].ttn},{load:2,arrive:3,ttn:4});
    await page.locator('#game-rewards-save').click();
    await wait(()=>!document.getElementById('game-rewards-save').disabled);
    assert.equal((await readDoc('settings/appConfig')).gameRewardSchedule.length,1,'Same reward settings must not append duplicate history');
    await page.locator('#arcade-admin > summary').click(); await toggleCheckbox('arcade_enabled',false);
    await wait(() => document.getElementById('arcade-entry').hidden);
    await toggleCheckbox('arcade_enabled',true); await wait(() => !document.getElementById('arcade-entry').hidden);
    await page.locator('#arcade-entry').click(); await page.locator('#arcade-dialog[open]').waitFor({state:'visible'});
    await page.locator('#arcade-dialog [data-view="ranking"]').click();
    await page.locator('#arcade-dialog [data-view="home"]').click(); await page.locator('#arcade-dialog .arcade-close').click();
    await page.reload(); await ready();
    assert.equal(await page.evaluate(() => settings.hapticLoad), false);
    assert.deepEqual(await page.evaluate(()=>{const rates=window.__gameCoinsCore.rewardsAt(appConfig);return {load:rates.load,arrive:rates.arrive,ttn:rates.ttn};}),{load:2,arrive:3,ttn:4});
    assert.equal(await page.evaluate(() => appConfig.testReviewFlags.arcade_enabled), true); await evidence('settings-reloaded');
  });
  await step('timesheet-crew-hours-material-repeat-month-and-history', async () => {
    await nav('timesheet'); await wait(() => document.querySelector('.ts-sync')?.textContent.includes('Данные подтверждены'));
    await page.locator('#tab-timesheet [data-action="add-equipment"]').click();
    await page.locator('.ts-dialog select[name="machine"]').selectOption('m1');
    for (const checkbox of await page.locator('.ts-dialog input[name="operatorIds"]').all()) await checkbox.check();
    await page.locator('.ts-dialog button[type="submit"]').dblclick(); await page.locator('.ts-dialog').waitFor({state:'detached'});
    await wait(() => document.querySelectorAll('.ts-inline-hours').length >= 2);
    // Server assertions validate the actual transaction/rules, not just optimistic DOM.
    await wait(() => document.querySelector('.ts-sync')?.textContent.includes('Данные подтверждены'));
    assert.equal((await readRows('timesheetEntries')).length, 3);
    await page.locator('#tab-timesheet [data-action="crew"]').first().click();
    await page.locator('.ts-dialog [data-action="crew-assign"]').click();
    await page.locator('.ts-dialog button[type="submit"]').click(); await page.locator('.ts-dialog').waitFor({state:'detached'});
    assert.equal((await readRows('timesheetEntries')).length, 3);
    await page.locator('.ts-crew-row [data-value="12"]').click();
    await wait(() => document.getElementById('tab-timesheet').textContent.includes('24 чел.-ч'));
    await wait(() => document.querySelector('.ts-sync')?.textContent.includes('Данные подтверждены'));
    assert.equal((await readRows('timesheetEntries')).filter(r => r.kind === 'person').reduce((n,r) => n + r.minutes, 0), 1440);
    await page.locator('#tab-timesheet [data-action="entry"][data-id^="equipment"]').first().click();
    await page.locator('.ts-dialog [name="hours"]').fill('11'); await page.locator('.ts-dialog button[type="submit"]').click();
    await page.locator('.ts-dialog').waitFor({state:'detached'});
    await page.locator('#tab-timesheet [data-action="material"]').first().click();
    await page.locator('.ts-dialog [name="material"]').fill('Учебный щебень'); await page.locator('.ts-dialog [name="supplier"]').fill('Учебный поставщик');
    await page.locator('.ts-dialog [name="quantity"]').fill('80'); await page.locator('.ts-dialog button[type="submit"]').dblclick();
    await page.locator('.ts-dialog').waitFor({state:'detached'}); await wait(() => document.querySelector('.ts-sync')?.textContent.includes('Данные подтверждены'));
    assert.equal((await readRows('timesheetMaterials')).length, 1);
    await page.locator('#tab-timesheet [data-view="month"]').click(); await page.locator('.ts-table').waitFor({state:'visible'});
    await page.locator('#tab-timesheet [data-action="history"]').click(); await wait(() => document.querySelector('.ts-dialog .ts-history'));
    await page.locator('.ts-dialog [data-close]').last().click();
    await page.locator('#tab-timesheet [data-view="day"]').click(); await evidence('timesheet');
  });
  await step('archive-fullwidth-genuine-png-and-overlay', async () => {
    // Explicit seeded domain fixture: real UI, rasterizer, canvas and download.
    // No rasterizer mock or external message destination is installed.
    const logs=Array.from({length:40},(_,i)=>({id:'wide-'+i,truckId:'qa-truck',truckName:'Учебный КАМАЗ А123АА78',volume:20,isGAI:false,
      timestamp:Date.now()+i,timeStr:'12:'+String(i).padStart(2,'0'),createdBy:'qa-active',createdByEmail:'qa-active@example.test',comment:i===0?'Последняя правая ячейка':''}));
    await writeDoc('workspaces/main_workspace/archive/qa-wide',{objectName:'Проверка широкого PNG',date:'31.10.2026',closedAt:Date.now(),logs,activeLineIds:['qa-truck'],ttnStatus:{'qa-truck':true}});
    await wait(()=>state.archive.some(item=>item.id==='qa-wide'));
    await nav('archive');
    if (await page.locator('#archiveSearchInput').isVisible()) await page.locator('#archiveSearchInput').fill('');
    // Newly added objects can start collapsed; open via the visible group header.
    const group=page.locator('.archive-group').filter({has:page.locator('.archive-group-header').filter({hasText:'Проверка широкого PNG'})});
    if (await group.locator('.archive-group-header').getAttribute('aria-expanded')!=='true') await group.locator('.archive-group-header').click();
    await group.locator('.archive-shift-item').click();
    await page.locator('#archiveModal.open').waitFor({state:'visible'});
    assert.equal(await page.locator('#archive-paper-wrapper .paper-table th').count(),42);
    assert(await page.locator('#archive-paper-wrapper .paper-report-container').isVisible());
    await page.locator('#archive-paper-wrapper .paper-report-container').click({position:{x:40,y:35}});
    await page.locator('#archive-sheet-dialog[open]').waitFor({state:'visible'});
    assert.equal(await page.locator('#archive-sheet-dialog .paper-table th').count(),42);
    const before=await page.locator('#archive-sheet-dialog .sheet-scale').innerText();
    await page.locator('#archive-sheet-dialog [data-action="in"]').click();
    assert.notEqual(await page.locator('#archive-sheet-dialog .sheet-scale').innerText(),before);
    await page.locator('#archive-sheet-dialog [data-action="fit"]').click();
    await page.keyboard.press('Escape'); await page.locator('#archive-sheet-dialog').waitFor({state:'detached'});
    const icon=page.locator('#archiveModal .archive-toggle-icon'); assert.equal(await icon.innerText(),'📄');
    await icon.click(); await icon.click({delay:350});
    assert.equal(await page.evaluate(()=>viewingArchiveGAITable),false,'Archive short press must not switch');
    await icon.click({delay:950}); assert.equal(await icon.getAttribute('aria-pressed'),'true');
    assert.equal(await page.evaluate(()=>viewingArchiveGAITable),true);
    assert.match(await page.locator('#archive-paper-wrapper .paper-total-info').innerText(),/Всего рейсов ГАИ/);
    await page.locator('#archive-paper-wrapper .paper-report-container').click({position:{x:40,y:35}});
    await page.locator('#archive-sheet-dialog[open] .paper-table').waitFor({state:'visible'});
    assert.match(await page.locator('#archive-sheet-dialog .paper-total-info').innerText(),/Всего рейсов ГАИ/);
    await page.locator('#archive-sheet-dialog [data-action="close"]').click();
    await page.locator('#archive-sheet-dialog').waitFor({state:'detached'});
    await icon.click({delay:950}); assert.equal(await icon.getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#archive-paper-wrapper .paper-table th').count(),42);
    const fullWidth=await page.locator('#archive-paper-wrapper .paper-table').evaluate(table=>table.scrollWidth);
    assert(fullWidth>2000,'Fixture must exceed viewport/A4 width');
    const pending=page.waitForEvent('download',{timeout:65000}); await page.locator('#archiveSavePngBtn').click();
    const download=await pending, filename=path.join(output,currentCase+'-archive-fullwidth.png');
    assert.match(download.suggestedFilename(),/\.png$/); await download.saveAs(filename);
    const bytes=fs.readFileSync(filename), dimensions=pngDetails(bytes);
    assert(dimensions.width>2000 && dimensions.width<=8192 && dimensions.height>0,'PNG must preserve the wide sheet within canvas bounds');
    assert(dimensions.width>=Math.min(fullWidth,8192)*.97,'PNG cropped to viewport/A4');
    const decoded=await page.evaluate(async bytes=>{
      const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      const x=Math.floor(canvas.width*.9),data=ctx.getImageData(x,0,canvas.width-x,canvas.height).data;
      let ink=0;for(let i=0;i<data.length;i+=4)if(data[i+3]>0 && Math.min(data[i],data[i+1],data[i+2])<170)ink++;
      return {width:canvas.width,height:canvas.height,rightEdgeInk:ink};
    },Array.from(bytes));
    assert.equal(decoded.width,dimensions.width);assert.equal(decoded.height,dimensions.height);
    assert(decoded.rightEdgeInk>20,'Rightmost table columns must contain rendered content');
    report.steps.at(-1).png={...dimensions,sourceTableWidth:fullWidth,rightEdgeInk:decoded.rightEdgeInk,filename:path.basename(filename)};
    await evidence('wide-archive'); await page.locator('#archiveModal button[onclick="closeArchiveModal()"]').click();
    await assertNoUnexpectedErrors();
  });
  await step('pwa-cold-offline-close-reopen-and-reconnect-exactly-once', async () => {
    await nav('line'); await chooseTruck('qa-offline');
    await wait(() => TestPWA.snapshot().shellReady && TestPWA.snapshot().persistent && navigator.serviceWorker.controller);
    const cdp = await activeContext.newCDPSession(page), manifest = await cdp.send('Page.getAppManifest');
    assert.deepEqual(manifest.errors, []); assert(manifest.url.endsWith('/manifest-test.webmanifest'));
    const prior = (await readRows('logs')).length;
    await closeContext(); await launch(profile, 'qa-active', mobile, true); await ready();
    await wait(() => state.shift?.isActive && state.truckStatus['qa-offline']?.onLine);
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    await nav('line'); await hold('qa-offline','arrive'); await wait(() => offlinePendingCount() === 1);
    await hold('qa-offline','load'); await wait(() => offlinePendingCount() === 2);
    await hold('qa-offline','ttn'); await wait(() => offlinePendingCount() === 3);
    assert.equal((await readRows('logs')).length, prior);
    await evidence('offline-pending'); await closeContext();
    await launch(profile, 'qa-active', mobile, true); await ready();
    await wait(() => offlinePendingCount() === 3 && state.truckStatus['qa-offline']?.ttnStatus === true);
    assert.equal(await page.evaluate(() => getLogs().filter(l => l.truckId === 'qa-offline').length), 1);
    await activeContext.setOffline(false);
    // setOffline produces a genuine online event. Extra dispatch verifies replay
    // re-entry through the application's public event listener is idempotent.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await wait(() => offlinePendingCount() === 0, undefined, 60000);
    await wait(() => offlineUnreviewedFailures().length === 0 && !offlineReplayRunning, undefined, 30000);
    assert.equal((await readRows('logs')).length, prior + 1);
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
    await page.reload(); await ready(); await wait(() => offlinePendingCount() === 0);
    assert.equal((await readRows('logs')).length, prior + 1);
    assert.equal((await readRows('logs')).filter(l => l.truckId === 'qa-offline').length, 1);
    await evidence('reconnected'); await assertNoUnexpectedErrors();
  });
}

async function runCase(name, task) {
  currentCase = name; const entry = {name,status:'running'}; report.cases.push(entry); persist();
  try { await seed(); await task(); entry.status = 'passed'; }
  catch (error) { entry.status = 'failed'; entry.error = error.stack || String(error); console.error('FAIL browser:',name,error); await evidence('case-failure'); }
  finally { try { await closeContext(); } catch (error) { entry.status='failed'; entry.cleanupError=error.stack; } persist(); }
}

async function main() {
  assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid local emulator port');
  assert(PROJECT.startsWith('demo-'));
  report.build=JSON.parse(fs.readFileSync(path.join(root,'test-app/build-manifest.json'),'utf8')).version;
  report.release=fs.readFileSync(path.join(root,'index-test.html'),'utf8').match(/class="version-text">([^<]+)</)[1];
  const jar = process.env.FIRESTORE_EMULATOR_JAR; assert(jar && fs.existsSync(jar), 'Set FIRESTORE_EMULATOR_JAR to an installed local Firestore emulator JAR');
  ({chromium} = require('playwright')); sdk = require('firebase/firestore');
  const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
  emulator = spawn('java',['-Xmx512m','-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id',PROJECT],{cwd:work,stdio:['ignore','pipe','pipe']});
  emulator.stdout.on('data', chunk => emulatorLog += chunk); emulator.stderr.on('data', chunk => emulatorLog += chunk);
  let startupError; emulator.on('error', error => { startupError = error; });
  const until = Date.now() + 45000;
  while (!emulatorLog.includes('Dev App Server is now running')) {
    if (startupError) throw startupError;
    if (emulator.exitCode !== null) throw Error('Local emulator exited: ' + emulatorLog.slice(-4000));
    if (Date.now() > until) throw Error('Local emulator startup timed out: ' + emulatorLog.slice(-4000));
    await delay(100);
  }
  env = await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port,rules:fs.readFileSync(path.join(root,report.rules),'utf8')}});
  server = createLocalServer(root,port,report.serverRequests);
  server.on('audit-error', error => report.pageErrors.push({case:currentCase,type:'server',message:error.stack}));
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  await runCase('auth-gates', authenticationCases);
  if (!stopped) await runCase('desktop', () => responsiveCase(false));
  if (!stopped) await runCase('mobile', () => responsiveCase(true));
}

async function cleanup() {
  try { await closeContext(); report.cleanup.push('browser closed'); } catch (e) { report.cleanup.push('browser close failed: ' + e.message); }
  if (env) try { await env.cleanup(); report.cleanup.push('Firebase test clients closed'); } catch (e) { report.cleanup.push('Firebase cleanup failed: ' + e.message); }
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (emulator && emulator.exitCode === null) {
    emulator.kill('SIGTERM');
    const until = Date.now() + 5000; while (emulator.exitCode === null && Date.now() < until) await delay(100);
    if (emulator.exitCode === null && emulator.signalCode === null) emulator.kill('SIGKILL');
    report.cleanup.push('owned local emulator stopped');
  }
  fs.writeFileSync(path.join(output,'emulator.log'),emulatorLog);
  // Only remove the profiles this invocation created; evidence lives separately.
  fs.rmSync(work,{recursive:true,force:true}); report.cleanup.push('temporary profiles removed');
}

const watchdog = setTimeout(() => {
  stopped = true; fatalError = Error('Browser suite exceeded its 12-minute execution budget');
  report.timeout = fatalError.message; persist(); activeContext?.close().catch(() => {}); emulator?.kill('SIGTERM');
}, 12 * 60 * 1000);
main().catch(error => { fatalError=error; console.error(error); }).finally(async () => {
  clearTimeout(watchdog);
  try { await cleanup(); } catch (error) { fatalError = fatalError || error; report.cleanup.push(error.stack); }
  report.finishedAt = new Date().toISOString();
  if (fatalError) report.error = fatalError.stack;
  report.status = fatalError || report.cases.length !== 3 || report.cases.some(c => c.status !== 'passed') || report.pageErrors.length || report.blockedRequests.length || report.cspViolations.length ? 'failed' : 'passed';
  persist(); console.log('Browser acceptance:',report.status,'Evidence:',output);
  if (report.status !== 'passed') process.exitCode = 1;
});
