/*
 * Запуск из корня worktree (пакеты автоматически не устанавливаются):
 * export TABEL_SYNC_QA=/path/to/qa-with-firebase-node_modules
 * export CODEX_PRIMARY_RUNTIME_NODE_MODULES=/path/to/node_modules
 * export TABEL_CHROMIUM=/path/to/chrome
 * printf '%s\n' '{"emulators":{"firestore":{"host":"127.0.0.1","port":8080},"ui":{"enabled":false},"singleProjectMode":false}}' > /tmp/opencode/live-values-firebase.json
 * /path/to/node_modules/.bin/firebase emulators:exec --only firestore \
 *   --project demo-live-values --config /tmp/opencode/live-values-firebase.json \
 *   'node tests/tabel-v2/live-values-browser.cjs'
 * Без Firebase: node tests/tabel-v2/live-values-browser.cjs --bridge
 * Основной режим: два независимых browser context, настоящий emulator subscription.
 * Ограничение: mock store + тестовый refreshIncoming, не production Store/remote,
 * не проверяются авторизация, очередь offline, дедупликация и конфликты операторов.
 * --bridge заменяет только транспорт (Playwright доставляет record из страницы 1
 * в страницу 2); этот режим НЕ доказывает работу Firestore subscription.
 * Firestore: e2e от sentAt до listener <=1000ms (Date.now между contexts);
 * оба режима: refresh + следующий animation frame <=500ms (performance.now).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {createRequire} = require('node:module');
const bridge = process.argv.includes('--bridge');
const root = path.resolve(__dirname, '../..');

function preflight() {
  const modules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
  if (!modules) throw Error('Preflight: задайте CODEX_PRIMARY_RUNTIME_NODE_MODULES (каталог с playwright).');
  let chromium;
  try { ({chromium} = require(path.join(modules, 'playwright'))); }
  catch { throw Error('Preflight: playwright не найден в CODEX_PRIMARY_RUNTIME_NODE_MODULES.'); }
  const executablePath = process.env.TABEL_CHROMIUM || '/tmp/tabel-chromium';
  if (!fs.existsSync(executablePath)) throw Error('Preflight: Chromium не найден; задайте TABEL_CHROMIUM.');
  let qa;
  if (!bridge) {
    if (!process.env.TABEL_SYNC_QA) throw Error('Preflight: задайте TABEL_SYNC_QA с firebase и @firebase/rules-unit-testing либо явно используйте --bridge.');
    qa = createRequire(path.join(process.env.TABEL_SYNC_QA, 'package.json'));
    for (const name of ['@firebase/rules-unit-testing', 'firebase/firestore']) {
      try { qa.resolve(name); } catch { throw Error('Preflight: отсутствует зависимость ' + name); }
    }
    for (const name of ['app', 'firestore']) {
      if (!fs.existsSync(path.join(process.env.TABEL_SYNC_QA, 'node_modules/firebase/firebase-' + name + '-compat.js'))) {
        throw Error('Preflight: отсутствует firebase-' + name + '-compat.js в TABEL_SYNC_QA/node_modules/firebase.');
      }
    }
  }
  return {chromium, executablePath, qa};
}

(async () => {
  const {chromium, executablePath, qa} = preflight();
  let env, browser, server;
  const errors = [];
  // Уникальный demo project: ни очистки общего emulator, ни доступа к production.
  const projectId = 'demo-live-values-' + process.pid + '-' + Date.now().toString(36);
  try {
    if (!bridge) {
      try { await fetch('http://127.0.0.1:8080/', {signal: AbortSignal.timeout(2000)}); }
      catch { throw Error('Preflight: Firestore Emulator недоступен на 127.0.0.1:8080. Запустите emulators:exec по инструкции в заголовке.'); }
      const {initializeTestEnvironment} = qa('@firebase/rules-unit-testing');
      env = await initializeTestEnvironment({projectId, firestore: {host: '127.0.0.1', port: 8080,
        rules: 'rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }'}});
    }
    server = http.createServer((req, res) => {
      if (req.url === '/live-values-harness') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live values QA</title><body></body></html>');
        return;
      }
      if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
      const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (error, data) => {
        if (error) { res.writeHead(404).end(); return; }
        const type = {'.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html'}[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, {'Content-Type': type}); res.end(data);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({executablePath, args: ['--no-sandbox']});
    const create = async uid => {
      const context = await browser.newContext({viewport: {width: 393, height: 852}});
      // Разрешены только конкретные origin тестового сервера и emulator.
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin && (bridge || url.origin !== 'http://127.0.0.1:8080')) {
          errors.push('Запрещён запрос к origin: ' + url.origin); return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      // Пустая локальная страница без auto-mount основного harness.
      await page.goto(origin + '/live-values-harness');
      if (!bridge) for (const name of ['app', 'firestore']) {
        await page.addScriptTag({content: fs.readFileSync(path.join(process.env.TABEL_SYNC_QA, 'node_modules/firebase/firebase-' + name + '-compat.js'), 'utf8')});
      }
      await page.evaluate(async ({uid, projectId, bridge}) => {
        const D = await import('/test-app/tabel-v2/table-domain.mjs');
        const {mount} = await import('/test-app/tabel-v2/grid.mjs');
        const object = {id: 'live-site', name: 'Изолированный live-values'};
        const config = D.config(object);
        config.start = D.add(D.today(), -59); config.tableMode = 'full';
        config.equipment = Array.from({length: 20}, (_, i) => ({id: 'water' + i, name: 'Машина ' + i, ownership: 'own', kind: 'water'}));
        config.request.equipment = config.equipment.map(e => e.id);
        const dayKey = d => object.id + '/day:' + D.dayKey(d.date, d.shift);
        const records = Object.fromEntries(D.days(config.start, D.today()).map(date => {
          const data = D.createDay(config, date); data.equipment[0].hours = 2;
          return [dayKey(data), {revision: 1, data}];
        }));
        records[object.id + '/sheet:linked'] = {revision: 1, data: {name: 'Табель', cells: {}, widths: {}, heights: {}}};
        document.body.innerHTML = '<link rel="stylesheet" href="/test-app/tabel-v2/workspace.css"><section class="tn tn-app"><main></main></section>';
        const store = {
          get: k => structuredClone(records[k] || {revision: 0, data: null}),
          list: prefix => Object.entries(records).filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({key, ...structuredClone(v)})),
        };
        window.daysReads = 0;
        const s = {object, root: document.querySelector('section'), store,
          config: () => config, days: () => { window.daysReads++; return store.list(object.id + '/day:').map(r => r.data); },
          require: () => {}, sheetManager: () => true, sheetVisible: id => id === 'linked', remote: false,
          key: suffix => object.id + '/' + suffix, host: {session: () => ({uid, name: uid, role: 'admin'})}};
        window.grid = await mount(s, s.root.querySelector('main'));
        const row = D.rows(config, s.days()).findIndex(r => r.entity === 'water0' && r.field === 'hours');
        window.target = D.cell(row + 2, 1);
        window.sourceKey = dayKey(D.createDay(config, config.start));
        window.makeIncoming = () => {
          const record = store.get(sourceKey); record.revision++;
          record.data.equipment[0].hours = 9;
          return {key: sourceKey, ...record, sentAt: Date.now()};
        };
        let completeDelivery;
        // Callback subscription не await-ится SDK: всегда завершаем отдельный
        // promise результатом или диагностикой, без unhandled rejection.
        window.deliveryCompletion = new Promise(resolve => { completeDelivery = resolve; });
        window.failDelivery = error => {
          window.deliveryError = error.message;
          completeDelivery({error: error.message});
        };
        window.refreshIncoming = async (record, receivedAt) => {
          const started = performance.now();
          if (record.key !== sourceKey) throw Error('Входящий key не совпадает с sourceKey');
          if (record.revision !== 2) throw Error('Входящая revision должна быть 2');
          if (record.data?.equipment?.[0]?.hours !== 9) throw Error('Входящие часы техники должны быть 9');
          if (!Number.isFinite(record.sentAt)) throw Error('Входящий sentAt должен быть числом');
          // Заменяем record, s.days() вернёт НОВЫЕ объекты; старый allDays не изменяется.
          records[record.key] = structuredClone({revision: record.revision, data: record.data});
          await grid.refresh();
          await new Promise(resolve => requestAnimationFrame(resolve));
          const result = {refreshMs: performance.now() - started, reads: daysReads,
            receivedAt, sentAt: record.sentAt, e2eMs: receivedAt - record.sentAt,
            key: record.key, revision: record.revision, hours: record.data.equipment[0].hours};
          window.received = result;
          completeDelivery({received: result});
        };
        if (!bridge) {
          firebase.initializeApp({projectId, apiKey: 'emulator', appId: 'emulator'});
          const db = firebase.firestore(); db.useEmulator('127.0.0.1', 8080);
          const ref = db.collection('liveValues').doc('day');
          window.send = record => ref.set(record);
          window.stop = ref.onSnapshot(snapshot => {
            const receivedAt = Date.now();
            if (snapshot.exists) void window.refreshIncoming(snapshot.data(), receivedAt).catch(window.failDelivery);
            window.subscriptionReady = true;
          }, window.failDelivery);
        }
      }, {uid, projectId, bridge});
      return page;
    };
    const a = await create('operator-1'), b = await create('operator-2');
    assert.notEqual(a.context(), b.context(), 'Клиенты должны использовать независимые browser contexts');
    if (!bridge) for (const page of [a, b]) {
      await page.waitForFunction(() => window.subscriptionReady || window.deliveryError);
      assert.equal(await page.evaluate(() => window.deliveryError), undefined, 'Ошибка подготовки Firestore subscription');
    }
    const target = await b.evaluate(() => window.target);
    assert.equal(await b.locator('[data-cell="' + target + '"]').innerText(), '2', 'Начальные часы целевой ячейки должны быть 2');
    await b.locator('[data-range]').fill(target + ':' + target.replace(/\d+$/, n => Number(n) + 1));
    await b.locator('[data-range]').dispatchEvent('change');
    const before = await b.evaluate(() => {
      const scroll = document.querySelector('.tn-grid-scroll');
      scroll.style.height = '220px'; scroll.style.maxHeight = '220px';
      scroll.scrollTop = 100; scroll.scrollLeft = 120;
      window.oldTable = document.querySelector('table');
      window.oldCell = document.querySelector('[data-cell="' + target + '"]');
      window.oldCells = new Map([...oldTable.querySelectorAll('[data-cell]')].map(td => [td.dataset.cell, td]));
      return {snapshot: grid.snapshot(), reads: daysReads, selection: [...document.querySelectorAll('.tn-selected')].map(el => el.dataset.cell)};
    });
    assert(before.snapshot.top > 0 && before.snapshot.left > 0, 'Прокрутка должна быть ненулевой по обеим осям');
    assert.equal(before.snapshot.period, 'all', 'Проверяем allDays в режиме всего объекта');
    const record = await a.evaluate(() => makeIncoming());
    assert.equal(record.key, await b.evaluate(() => sourceKey), 'Отправленный key должен совпадать с sourceKey получателя');
    assert.equal(record.revision, 2, 'Отправленная revision должна быть 2');
    assert.equal(record.data.equipment[0].hours, 9, 'Отправленные часы техники должны быть 9');
    if (bridge) await b.evaluate(record => { void refreshIncoming(record, Date.now()).catch(failDelivery); }, record);
    else await a.evaluate(record => send(record), record);
    const completion = await b.evaluate(() => Promise.race([
      window.deliveryCompletion,
      new Promise(resolve => setTimeout(() => resolve({error: 'Истекло 10000ms ожидания завершения входящего refresh'}), 10000)),
    ]));
    assert.equal(completion.error, undefined, 'Входящая доставка/refresh не завершились успешно: ' + completion.error);
    const after = await b.evaluate(() => ({
      error: window.deliveryError, received: window.received, snapshot: grid.snapshot(),
      sameTable: oldTable === document.querySelector('table'), sameCell: oldCell === document.querySelector('[data-cell="' + target + '"]'),
      changedCells: [...oldCells].filter(([key, td]) => td !== document.querySelector('[data-cell="' + key + '"]')).map(([key]) => key),
      cellCount: document.querySelectorAll('table [data-cell]').length, oldCellCount: oldCells.size,
      value: oldCell.childNodes[0].textContent,
      selection: [...document.querySelectorAll('.tn-selected')].map(el => el.dataset.cell),
    }));
    assert.equal(after.error, undefined, 'Обработчик входящей записи сообщил об ошибке');
    assert.equal(after.received.key, record.key, 'Полученный key отличается от отправленного sourceKey');
    assert.equal(after.received.revision, 2, 'Полученная revision должна быть 2');
    assert.equal(after.received.hours, 9, 'Полученные часы техники должны быть 9');
    assert.equal(after.value, '9', 'Целевая ячейка должна отобразить входящие часы 9');
    assert(after.sameTable, 'Узел table должен сохраниться'); assert(after.sameCell, 'Узел целевого td должен сохраниться');
    assert.deepEqual(after.changedCells, [], 'Все отрисованные data-cell должны сохранить исходные узлы');
    assert.equal(after.cellCount, after.oldCellCount, 'Число отрисованных data-cell не должно изменяться');
    assert.deepEqual(after.snapshot, before.snapshot, 'Snapshot выделения/прокрутки должен сохраниться');
    assert.deepEqual(after.selection, before.selection, 'Набор выделенных ячеек должен сохраниться');
    assert(after.received.reads > before.reads, 'grid.refresh обязан перечитать s.days() / allDays');
    assert(after.received.refreshMs >= 0 && after.received.refreshMs <= 500, 'Локальный refresh должен занимать <=500ms, получено: ' + after.received.refreshMs);
    if (!bridge) assert(after.received.e2eMs >= 0 && after.received.e2eMs <= 1000, 'Доставка через emulator должна занимать 0..1000ms, получено: ' + after.received.e2eMs);
    assert.deepEqual(errors, [], 'Не должно быть ошибок страницы/консоли или запрещённых сетевых запросов');
    console.log('PASS ' + (bridge ? 'deterministic bridge (только refresh, НЕ Firestore)' : 'Firestore Emulator 127.0.0.1:8080; e2eMs=' + after.received.e2eMs) + ': два контекста, 2 → 9, allDays перечитан, все data-cell/table/selection/scroll сохранены; refreshMs=' + after.received.refreshMs.toFixed(1));
    for (const page of [a, b]) await page.evaluate(() => { window.stop?.(); grid.dispose(); });
  } finally {
    await browser?.close(); await env?.cleanup();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
