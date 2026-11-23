/* Установка и офлайн-оболочка. Обновление полностью автоматическое
 * (решение владельца от 23.11.2026): новая сборка ставится сама — SW делает
 * skipWaiting сразу после SHA-проверки файлов, страница перезагружается по
 * controllerchange. Ни кнопок, ни блокировок. Активный ввод не прерывается:
 * перезагрузка откладывается до потери фокуса/закрытия карточки, максимум
 * 3 минуты. Черновики переживают reload (admin-nickname-draft). Все
 * мутации данных остаются в существующих очередях. */
(function () {
  'use strict';
  const eligible = /^https?:$/.test(location.protocol) && location.pathname.endsWith('/index-working-test.html');
  // Read the script actually opened, not the latest manifest on the server. The meta fallback survives HTML export.
  const buildVersion = document.currentScript?.src?.match(/\/working-test\/build\/([a-f0-9]{16})\/pwa\.js(?:[?#]|$)/)?.[1]
    || document.querySelector('meta[name="working-test-build"]')?.content || '';
  const releaseVersion = window.WORKING_TEST_RELEASE?.version || document.querySelector('meta[name="working-test-version"]')?.content || '';
  let registration, installPrompt, shellReady = false, registrationError = '', statusError = '', installed = false;
  let latestPublished = null, publishedCheck = null;
  const statusLine=document.createElement('div');
  statusLine.id='app-update-status-line';statusLine.hidden=true;  statusLine.setAttribute('role','status');
  statusLine.style.cssText='display:none;padding:3px 12px;font-size:12px;line-height:1.5;color:var(--muted,#94a3b8);background:transparent;text-align:center';
  document.querySelector('#mainHeader')?.after(statusLine);
  const group = document.createElement('div');
  group.id = 'test-pwa-settings'; group.className = 'form-group';
  group.style.cssText = 'border-top:1px solid var(--border);padding-top:12px;margin-top:12px';
  group.innerHTML = '<label>📲 Приложение на телефоне</label><p id="test-pwa-version" class="release-diagnostics" style="font-size:12px;line-height:1.5;overflow-wrap:anywhere;text-decoration:none;cursor:default"></p><p id="test-pwa-state" role="status" style="font-size:13px;line-height:1.5"></p><button type="button" class="btn btn-quick btn-small" id="test-pwa-install">Установить приложение</button><button type="button" class="btn btn-secondary btn-small" id="test-pwa-check" style="margin-left:6px">🔄 Проверить обновление</button><button type="button" class="btn btn-secondary btn-small" id="test-pwa-force" style="margin-left:6px">♻️ Принудительное обновление</button><a id="test-pwa-recovery-link" href="./update-working-test.html" target="_blank" rel="noopener noreferrer" style="display:block;margin-top:10px;font-size:13px;color:var(--primary)">Не обновляется? Открыть страницу восстановления обновления ↗</a><p id="test-pwa-update-message" role="status" style="font-size:12px;line-height:1.5;margin:8px 0"></p><p style="font-size:12px;color:var(--muted);line-height:1.5">Перед работой без сети войдите и откройте нужную смену с интернетом. Прибытие, погрузка и ТТН сохраняются на устройстве. После возвращения сети открытое приложение отправит очередь с обычной проверкой повторов и конфликтов; если оно закрыто — при следующем запуске. Вход в новую учётную запись, серверные операции и общие мини-игры требуют связи.</p>';
  document.querySelector('#settingsModal .modal-body')?.append(group);
  const status = group.querySelector('#test-pwa-state'), version = group.querySelector('#test-pwa-version'), install = group.querySelector('#test-pwa-install'), check = group.querySelector('#test-pwa-check'), force = group.querySelector('#test-pwa-force');
  const updateMessage = group.querySelector('#test-pwa-update-message');
  const standalone = () => installed || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let activeVersion = '', waitingVersion = '', updateReady = false, checking = false, statusEpoch = 0, checkInFlight;
  let confirmedActive, confirmedWaiting;
  const watchedWorkers = new WeakSet();
  function state() {
    const activeConfirmed = registration?.active === confirmedActive, waitingConfirmed = registration?.waiting === confirmedWaiting;
    return {shellReady:shellReady && activeConfirmed, persistent:window.TestStorageState?.persistent===true, signedIn:!!currentUid,
      accessReady:permissionsLoaded && currentUserStatus==='active', shiftReady:!!stateShift(),
      waiting:!!registration?.waiting, updateReady:updateReady && waitingConfirmed, checking, installed:standalone(), error:registrationError || statusError,
      releaseVersion, buildVersion, activeVersion:activeConfirmed?activeVersion:'', waitingVersion:waitingConfirmed?waitingVersion:''};
  }
  function stateShift() { return typeof window.__testGetShift === 'function' ? window.__testGetShift() : null; }
  function render() {
    const s = state();
    // Тихая строка статуса под шапкой: единственное видимое след обновления.
    if (updateFailedText) {
      statusLine.hidden=false;statusLine.style.display='block';
      statusLine.innerHTML='Обновление не применилось, откройте <a href="./queue-doctor.html" target="_blank" rel="noopener noreferrer" style="color:var(--primary,#3b82f6);text-decoration:underline">queue-doctor.html</a>';
    } else {
      const statusText=updateStatusText();
      statusLine.hidden=!statusText;statusLine.style.display=statusText?'block':'none';
      statusLine.textContent=statusText||'';
    }
    install.hidden = s.installed;
    check.disabled = checking || !eligible || !('serviceWorker' in navigator) || !window.isSecureContext || !navigator.onLine;
    // Номер версии в настройках виден ВСЕГДА (не только администратору):
    // владелец сверяет обновление по номеру версии.
    version.hidden = false;
    version.textContent = 'Открыта: '+(releaseVersion || 'версия не определена')+' · сборка '+(buildVersion || 'не определена')
      +'. Офлайн-копия: '+(s.activeVersion || 'не подтверждена')+'.'
      +(s.waiting?' Ожидает: '+(s.waitingVersion || 'проверка сборки')+'.':'');
    if (!eligible) status.textContent = 'Для установки откройте тестовую страницу на сайте через HTTPS.';
    else if (s.error) status.textContent = (s.shellReady?'Автономная копия сохранена. Не удалось проверить обновление: ':'Не удалось подготовить запуск без сети: ')+s.error+'. Подключитесь к интернету и нажмите «Проверить обновление».';
    else if (s.activeVersion && buildVersion && s.activeVersion !== buildVersion) status.textContent = 'Сохранена другая офлайн-сборка. Готовность открытой сборки для запуска без сети ещё не подтверждена.';
    else if (!s.shellReady) status.textContent = 'Сохраняем приложение для открытия без интернета…';
    else if (!s.persistent) status.textContent = 'Файлы приложения сохранены. Браузер пока не подтвердил постоянное хранение данных. Не закрывайте страницу до проверки хранилища.';
    else if (!s.signedIn || !s.accessReady) status.textContent = 'Приложение доступно без сети. Для работы сначала войдите с интернетом и дождитесь загрузки прав.';
    else if (!s.shiftReady) status.textContent = 'Приложение доступно без сети. Откройте рабочую смену с интернетом, чтобы продолжить её офлайн.';
    else status.textContent = 'Готово к работе без интернета: приложение и текущая смена сохранены на устройстве.';
    if (s.waiting) status.textContent += ' Новая сборка скачивается и применится автоматически.';
    if (s.installed) status.textContent += ' Приложение установлено.';
    window.dispatchEvent(new CustomEvent('test-pwa-state',{detail:s}));
  }
  // Тихая строка под шапкой: версия и состояние автоматического обновления.
  // Никаких кнопок и блокировок — обновление ставится само.
  function updateStatusText() {
    if (updateFailedText) return updateFailedText;
    if (appliedVersion) return 'Версия '+(releaseVersion || appliedVersion)+' · обновление установлено';
    if (!!latestPublished && updateNeeded(latestPublished.version)) return 'Версия '+(releaseVersion || '?')+' · устанавливаю обновление…';
    return '';
  }
  // Подтверждённая версия АКТИВНОГО воркера: '' — пока не знаем или нет
  // регистрации. Ключевой ориентир автообновления: страница (buildVersion)
  // может быть уже новой по network-first, а офлайн-кэш — старым.
  function confirmedActiveVersion() {
    if (!registration?.active || registration.active !== confirmedActive) return '';
    return activeVersion;
  }
  // Установка нужна, пока опубликованная сборка не совпадает И с открытой
  // страницей, И с активным воркером (если его версия подтверждена).
  function updateNeeded(published) {
    if (!published) return false;
    if (published !== buildVersion) return true;
    const active = confirmedActiveVersion();
    return !!active && active !== published;
  }
  function workerStatus(worker) {
    if (!worker) return Promise.resolve(null);
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = result => {clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(result);};
      const timer = setTimeout(()=>finish(null),4000);
      channel.port1.onmessage=e=>finish(e.data?.type==='WORKING_TEST_PWA_STATUS'?e.data:null);
      try {worker.postMessage({type:'WORKING_TEST_PWA_STATUS'},[channel.port2]);} catch (_) {finish(null);}
    });
  }
  async function askStatus() {
    const epoch = ++statusEpoch, active = registration?.active, waiting = registration?.waiting;
    const [current, next] = await Promise.all([workerStatus(active),workerStatus(waiting)]);
    // A delayed reply from a replaced worker must not overwrite the new worker's status.
    if (epoch !== statusEpoch || active !== registration?.active || waiting !== registration?.waiting) return;
    confirmedActive=active;confirmedWaiting=waiting;
    activeVersion = typeof current?.version === 'string' ? current.version : '';
    waitingVersion = typeof next?.version === 'string' ? next.version : '';
    shellReady = current?.complete === true && !!activeVersion && (!buildVersion || activeVersion === buildVersion);
    updateReady = !!waiting && next?.complete === true && !!waitingVersion;
    statusError = active && !current ? 'Service Worker не ответил: готовность файлов не подтверждена' : '';
    render();
  }
  function watch(worker) {
    if (!worker || watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);
    worker.addEventListener('statechange',()=>{
      if (worker.state === 'redundant') registrationError='загрузка файлов прервана';
      if (worker.state === 'activated' || worker.state === 'installed') {registrationError='';askStatus();}
      render();
    });
  }
  async function register() {
    if (!eligible || !('serviceWorker' in navigator) || !window.isSecureContext) {
      registrationError = eligible ? 'браузер не поддерживает установку на этом адресе' : '';
      render(); return false;
    }
    try {
       // На отдельном сайте (страница в корне) worker получает весь каталог, иначе
      // офлайн-кэш не перехватывал бы подресурсы. В общем репозитории scope
      // остаётся ограниченным одной страницей, чтобы не вытеснить прод-worker.
      const swScope = './';
      registration = await navigator.serviceWorker.register('./sw-working-test.js',{scope:swScope,updateViaCache:'none'});
      registrationError='';watch(registration.installing);
      registration.addEventListener('updatefound',()=>watch(registration.installing));
      await askStatus();if(registration.active?.state==='activated'&&activeVersion===buildVersion)registration.active.postMessage({type:'WORKING_TEST_PWA_PRUNE'});render();return true;
    } catch (error) {registrationError=error?.message || String(error);render();return false;}
  }
  function checkForUpdates() {
    if (checkInFlight) return checkInFlight;
    checkInFlight = (async () => {
      checking=true;render();
      try {
        if (!registration) return await register(); // A failed register owns its error; never clear it in the caller.
        await registration.update();registrationError='';await askStatus();return true;
      } catch (error) {registrationError=error?.message || String(error);return false;}
      finally {checking=false;render();}
    })().finally(()=>{checkInFlight=null;});
    return checkInFlight;
  }
  window.addEventListener('beforeinstallprompt',event=>{if(!eligible)return;event.preventDefault();installPrompt=event;render();});
  window.addEventListener('appinstalled',()=>{installed=true;installPrompt=null;render();});
  install.onclick = async () => {
    if (installPrompt) {
      const prompt=installPrompt;installPrompt=null;await prompt.prompt();await prompt.userChoice;
      try {await navigator.storage?.persist?.();} catch (_) {}
      render();
    } else appNotice('Android: откройте эту страницу в Chrome → меню ⋮ → «Установить приложение» или «Добавить на главный экран».\n\niPhone: Safari → «Поделиться» → «На экран Домой».\n\nДождитесь надписи о готовности без интернета в настройках.');
  };
  async function publishedVersion() {
    // Фактически опубликованная сборка. Сначала — лёгкий файл номера версии
    // version.json: service worker его не кэширует, страница читает по сети
    // в обход кэша (no-store + cache-buster). Если файла нет или он битый —
    // разбор const VERSION прямо в sw-working-test.js. Устаревший
    // build-manifest.json не может тут ни расходиться с реальностью, ни
    // блокировать обновление.
    try {
      const response = await fetch('./version.json?cb=' + Date.now(),{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15000)});
      if (response.ok) {
        const data = await response.json();
        if (/^[a-f0-9]{16}$/.test(data.build || '')) return data.build;
      }
    } catch (_) {/* version.json недоступен — ниже запасной разбор SW */}
    const response = await fetch('./sw-working-test.js',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('Сайт не ответил: HTTP ' + response.status);
    const code = await response.text();
    const match = code.match(/const VERSION = '([a-f0-9]{16})'/);
    if (!match) throw Error('На сайте не найден номер опубликованной сборки.');
    return match[1];
  }
  // ===== Автоматическая перезагрузка при смене контроллера =====
  // Новый SW сразу делает skipWaiting после SHA-проверки файлов (install).
  // Здесь остаётся показать оверлей и перезагрузиться, не прерывая ввод.
  let reloadTimer=null;
  // Перезагрузка откладывается, пока идёт активный ввод: фокус в поле или
  // незакрытая карточка подтверждения. Максимум 3 минуты — дальше reload.
  const MAX_INPUT_DEFER=180000;
  function activeInput(){
    const focused=document.activeElement;
    if (focused&&(focused.tagName==='INPUT'||focused.tagName==='TEXTAREA'||focused.tagName==='SELECT'||focused.isContentEditable===true)) return true;
    if (document.querySelector('.pcm-overlay.pcm-open')) return true; // открыто окно подтверждения
    return false;
  }
  function showUpdateOverlay(){
    const overlay=document.createElement('div');
    overlay.id='app-reloading-overlay';
    overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#0b1220;color:#f1f5f9;display:flex;align-items:center;justify-content:center;text-align:center;font:600 22px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px';
    overlay.textContent='Обновление установлено — перезагружаюсь…';
    document.body?.append(overlay);
  }
  function doReload(){
    if (reloadTimer) {clearTimeout(reloadTimer);reloadTimer=null;}
    showUpdateOverlay();
    // Короткая пауза, чтобы оверлей был виден и страницы-наблюдатели успели
    // подготовиться; затем перезагрузка.
    setTimeout(()=>location.reload(),1600);
  }
  function reloadWhenSafe(){
    if (reloadTimer) return;
    const startedAt=Date.now();
    reloadTimer=setInterval(()=>{
      if (!activeInput() || Date.now()-startedAt>=MAX_INPUT_DEFER) doReload();
    },500);
  }
  let appliedVersion='';
  navigator.serviceWorker?.addEventListener('controllerchange',()=>{
    appliedVersion=confirmedActiveVersion()||activeVersion||'';
    askStatus();
    // Первое переключение контроллера: приложение только было открыто,
    // перезагружать не нужно.
    if (!pageHadController) {pageHadController=true;return;}
    reloadWhenSafe();
  });
  // ===== Обнаружение новой версии и запуск автообновления =====
  // Страница сверяет активный SW с version.json на сервере (SW его не
  // кэширует). Версия новее → registration.update() → SW скачивает файлы с
  // SHA-проверкой → skipWaiting → controllerchange → оверлей → reload.
  // Никаких кнопок и блокировок: черновики переживают reload, очереди
  // сохраняются, данные не чистятся.
  let updateAttempts=0, updateFailedText='', autoUpdateInFlight=false, updateRetryTimer=null;
  async function autoUpdate(){
    if(autoUpdateInFlight)return;autoUpdateInFlight=true;
    try{
      if(!eligible||!navigator.onLine||document.hidden)return;
      let published='';
      try {published=await publishedVersion();}catch{return;}
      latestPublished={version:published};
      if(!updateNeeded(published)){updateAttempts=0;updateFailedText='';render();return;}
      render();
      // Страховка от петли: 3 попытки с интервалом 15 с; если версия всё ещё
      // не применилась — показываем ссылку на queue-doctor и прекращаем цикл.
      if (updateAttempts>=3){updateFailedText='Обновление не применилось, откройте';render();return;}
      updateAttempts++;
      try {
        if(!registration)await register();
        if(registration){await registration.update();await askStatus();}
      } catch (_) {}
      if(confirmedActiveVersion()===published){updateAttempts=0;return;} // применилось без controllerchange
      if(updateNeeded(published)){
        clearTimeout(updateRetryTimer);
        updateRetryTimer=setTimeout(()=>{updateRetryTimer=null;void autoUpdate();},15000);
      }
    } finally {autoUpdateInFlight=false;}
  }
  async function discoverPublishedUpdate(){
    if(!eligible||!navigator.onLine||document.hidden)return;
    if(publishedCheck)return publishedCheck;
    publishedCheck=(async()=>{
      try{
        const version=await publishedVersion();
        latestPublished={version};
        render();
      }catch{/* A failed check never claims an update is available. */}
    })().finally(()=>{publishedCheck=null;});
    return publishedCheck;
  }
  if (typeof window !== 'undefined') window.__wtStatusLine = statusLine;
  check.onclick = checkForUpdates;
  // Принудительное обновление: лечит зависшую установку БЕЗ ручной очистки
  // кэша браузера. Сносит все офлайн-кэши service worker своего префикса,
  // снимает старые регистрации SW, скачивает сборку с нуля и перезапускает
  // страницу. localStorage/IndexedDB (данные, настройки, очередь действий)
  // НЕ трогаются.
  let forceBusy = false;
  force.onclick = async () => {
    if (forceBusy) return;
    if (!('serviceWorker' in navigator)) { updateMessage.textContent = 'Принудительное обновление недоступно: браузер не поддерживает service worker.'; return; }
    if (!navigator.onLine) { updateMessage.textContent = 'Принудительное обновление не выполнено: нет подключения к интернету. Попробуйте позже.'; return; }
    forceBusy = true; force.disabled = true;
    try {
      updateMessage.textContent = 'Очищаю сохранённые копии приложения…';
      const keys = await caches.keys();
      const shellCaches = keys.filter(key => key.indexOf('samosval-working-test-shell-') === 0);
      for (const key of shellCaches) await caches.delete(key);
      // Снимаем ВСЕ регистрации воркеров в этом scope: зависший старый SW
      // больше не перехватывает загрузку, новая регистрация ставит свежий.
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) { try { await reg.unregister(); } catch (_) {} }
      updateMessage.textContent = 'Кэши очищены, регистрирую обновление заново…';
      registration = null; shellReady = false; updateReady = false; confirmedActive = null; confirmedWaiting = null;
      await register();
      updateMessage.textContent = 'Готово: приложение обновится автоматически.';
    } catch (error) {
      updateMessage.textContent = 'Принудительное обновление не удалось: ' + String(error?.message || error) + ' Попробуйте позже; данные не удалены.';
    } finally {
      forceBusy = false; force.disabled = false; render();
    }
  };
  // Периодическая проверка: раз в 30 минут + при возврате в приложение
  // (visibilitychange/focus/pageshow) + при возврате сети. Плюс проверка
  // при старте ниже. Всё цепляется само, пользователь ничего не жмёт.
  setInterval(()=>{void autoUpdate();},1800000);
  const resume = () => {
    render();
    if (navigator.onLine && !document.hidden) {
      offlineTransportRecovered(); offlineReplayJournal();
      checkForUpdates();void autoUpdate();
    }
  };
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)resume();});
  // iOS Safari может не прислать visibilitychange после возврата из фона:
  // страховка по focus и pageshow запускает ту же проверку версии и связи.
  window.addEventListener('focus',resume);window.addEventListener('pageshow',resume);
  window.addEventListener('online',resume);window.addEventListener('offline',render);
  setInterval(render,5000);

  // Preserve the existing standalone HTML export after moving scripts/styles out of the page.
  async function inlineHtml(html) {
    const doc = new DOMParser().parseFromString(html,'text/html');
    const get = async url => {const r=await fetch(url);if(!r.ok)throw Error('Не удалось собрать файл: '+url);return r;};
    const dataURL = async url => new Promise(async (resolve,reject)=>{
      try {const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(await (await get(url)).blob());} catch(e){reject(e);}
    });
    async function css(code,base) {
      for(const match of [...code.matchAll(/@import\s*url\(['"]?([^)'"\s]+)['"]?\);/g)]) {
        const url=new URL(match[1],base).href;code=code.replace(match[0],await css(await (await get(url)).text(),url));
      }
      for(const match of [...code.matchAll(/url\(['"]?([^)'"]+)['"]?\)/g)]) {
        if(/^(data:|#)/.test(match[1]))continue;
        code=code.replace(match[0],'url("'+await dataURL(new URL(match[1],base).href)+'")');
      }
      return code;
    }
    for(const node of [...doc.querySelectorAll('script[src],link[rel="stylesheet"]')]) {
      const url=new URL(node.getAttribute(node.tagName==='SCRIPT'?'src':'href'),location.href);
      if(url.origin!==location.origin || !url.pathname.includes('/working-test/'))continue;
      const replacement=doc.createElement(node.tagName==='SCRIPT'?'script':'style');
      if(node.id)replacement.id=node.id;
      const body=await (await get(url.href)).text();
      replacement.textContent=node.tagName==='SCRIPT'?body.replace(/<\/script/gi,'<\\/script'):await css(body,url.href);
      node.replaceWith(replacement);
    }
    doc.querySelectorAll('link[rel="manifest"],link[rel="apple-touch-icon"]').forEach(n=>n.remove());
    return '<!DOCTYPE html>\n'+doc.documentElement.outerHTML;
  }
  let pageHadController=!!navigator.serviceWorker?.controller;
  window.TestPWA={snapshot:state,inlineHtml,checkForUpdates:discoverPublishedUpdate,__autoUpdate:autoUpdate};
  checkForUpdates();discoverPublishedUpdate().then(()=>autoUpdate());render();
})();
