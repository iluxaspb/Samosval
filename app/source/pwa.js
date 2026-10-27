/* Installation and offline shell only. All mutations stay in the existing queues. */
(function () {
  'use strict';
  const eligible = /^https?:$/.test(location.protocol) && (location.pathname.endsWith('/index.html') || location.pathname === new URL('./',location.href).pathname);
  // Read the script actually opened, not the latest manifest on the server. The meta fallback survives HTML export.
  const buildVersion = document.currentScript?.src?.match(/\/app\/build\/([a-f0-9]{16})\/pwa\.js(?:[?#]|$)/)?.[1]
    || document.querySelector('meta[name="app-build"]')?.content || '';
  const releaseVersion = window.APP_RELEASE?.version || document.querySelector('meta[name="app-version"]')?.content || '';
  let registration, installPrompt, shellReady = false, registrationError = '', statusError = '', installed = false;
  let activeVersion = '', waitingVersion = '', updateReady = false, checking = false, statusEpoch = 0, checkInFlight, confirmedActive, confirmedWaiting;
  const watchedWorkers = new WeakSet();
  const group = document.createElement('div');
  group.id = 'test-pwa-settings'; group.className = 'form-group';
  group.style.cssText = 'border-top:1px solid var(--border);padding-top:12px;margin-top:12px';
  group.innerHTML = '<label>📲 Приложение на телефоне</label><p id="test-pwa-version" class="version-text" hidden style="font-size:12px;line-height:1.5;overflow-wrap:anywhere;text-decoration:none;cursor:default"></p><p id="test-pwa-state" role="status" style="font-size:13px;line-height:1.5"></p><button type="button" class="btn btn-primary btn-small" id="test-pwa-install">Установить приложение</button><button type="button" class="btn btn-secondary btn-small" id="test-pwa-check" style="margin-left:6px">Проверить обновление</button><p style="font-size:12px;color:var(--muted);line-height:1.5">Перед работой без сети войдите и откройте нужную смену с интернетом. Прибытие, погрузка и ТТН сохраняются на устройстве. После возвращения сети открытое приложение отправит очередь с обычной проверкой повторов и конфликтов; если оно закрыто — при следующем запуске. Вход в новую учётную запись, серверные операции и общие мини-игры требуют связи.</p>';
  document.querySelector('#settingsModal .modal-body')?.append(group);
  const status = group.querySelector('#test-pwa-state'), version = group.querySelector('#test-pwa-version'), install = group.querySelector('#test-pwa-install'), check = group.querySelector('#test-pwa-check');
  const standalone = () => installed || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function state() {
    const activeConfirmed = registration?.active === confirmedActive, waitingConfirmed = registration?.waiting === confirmedWaiting;
    return {shellReady:shellReady && activeConfirmed, persistent:window.AppStorageState?.persistent===true, signedIn:!!currentUid,
      accessReady:permissionsLoaded && currentUserStatus==='active', shiftReady:!!stateShift(),
      waiting:!!registration?.waiting, updateReady:updateReady && waitingConfirmed, checking, installed:standalone(), error:registrationError || statusError,
      releaseVersion, buildVersion, activeVersion:activeConfirmed?activeVersion:'', waitingVersion:waitingConfirmed?waitingVersion:''};
  }
  function stateShift() { return typeof window.__appGetShift === 'function' ? window.__appGetShift() : null; }
  function render() {
    const s = state();
    install.hidden = s.installed;
    check.disabled = checking || !eligible || !('serviceWorker' in navigator) || !window.isSecureContext || !navigator.onLine;
    const releaseAdmin = typeof permissionsLoaded !== 'undefined' && permissionsLoaded && typeof canAdmin === 'function' && canAdmin();
    version.hidden = !releaseAdmin;
    version.textContent = releaseAdmin ? 'Открыта: '+(releaseVersion || 'версия не определена')+' · сборка '+(buildVersion || 'не определена')
      +'. Офлайн-копия: '+(s.activeVersion || 'не подтверждена')+'.'
      +(s.waiting?' Ожидает: '+(s.waitingVersion || 'проверка сборки')+'.':'') : '';
    if (!eligible) status.textContent = 'Для установки откройте тестовую страницу на сайте через HTTPS.';
    else if (s.error) status.textContent = (s.shellReady?'Автономная копия сохранена. Не удалось проверить обновление: ':'Не удалось подготовить запуск без сети: ')+s.error+'. Подключитесь к интернету и нажмите «Проверить обновление».';
    else if (s.activeVersion && buildVersion && s.activeVersion !== buildVersion) status.textContent = 'Сохранена другая офлайн-сборка. Готовность открытой сборки для запуска без сети ещё не подтверждена.';
    else if (!s.shellReady) status.textContent = 'Сохраняем приложение для открытия без интернета…';
    else if (!s.persistent) status.textContent = 'Файлы приложения сохранены. Браузер пока не подтвердил постоянное хранение данных. Не закрывайте страницу до проверки хранилища.';
    else if (!s.signedIn || !s.accessReady) status.textContent = 'Приложение доступно без сети. Для работы сначала войдите с интернетом и дождитесь загрузки прав.';
    else if (!s.shiftReady) status.textContent = 'Приложение доступно без сети. Откройте рабочую смену с интернетом, чтобы продолжить её офлайн.';
    else status.textContent = 'Готово к работе без интернета: приложение и текущая смена сохранены на устройстве.';
    if (s.updateReady && s.persistent) status.textContent += ' Обновление загружено: сохраните незавершённые формы, затем закройте все окна тестовой версии и откройте её снова. Очередь действий сохранится; не очищайте данные сайта.';
    else if (s.updateReady) status.textContent += ' Обновление загружено. Перед закрытием сохраните формы и дождитесь подтверждения постоянного хранилища. Не очищайте данные сайта.';
    else if (s.waiting) status.textContent += ' Обновление ожидает, но целостность файлов ещё не подтверждена. Повторите проверку с интернетом; текущие данные не изменены.';
    if (s.installed) status.textContent += ' Приложение установлено.';
    window.dispatchEvent(new CustomEvent('test-pwa-state',{detail:s}));
  }
  function workerStatus(worker) {
    if (!worker) return Promise.resolve(null);
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = result => {clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(result);};
      const timer = setTimeout(()=>finish(null),4000);
      channel.port1.onmessage=e=>finish(e.data?.type==='APP_PWA_STATUS'?e.data:null);
      try {worker.postMessage({type:'APP_PWA_STATUS'},[channel.port2]);} catch (_) {finish(null);}
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
      registration = await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
      registrationError='';watch(registration.installing);
      registration.addEventListener('updatefound',()=>watch(registration.installing));
      await askStatus();render();return true;
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
  navigator.serviceWorker?.addEventListener('controllerchange',askStatus);
  install.onclick = async () => {
    if (installPrompt) {
      const prompt=installPrompt;installPrompt=null;await prompt.prompt();await prompt.userChoice;
      try {await navigator.storage?.persist?.();} catch (_) {}
      render();
    } else appNotice('Android: откройте эту страницу в Chrome → меню ⋮ → «Установить приложение» или «Добавить на главный экран».\n\niPhone: Safari → «Поделиться» → «На экран Домой».\n\nДождитесь надписи о готовности без интернета в настройках.');
  };
  check.onclick = checkForUpdates;
  const resume = () => {
    render();
    if (navigator.onLine && !document.hidden) {
      offlineTransportRecovered(); offlineReplayJournal();
      checkForUpdates();
    }
  };
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)resume();});
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
      for(const match of [...code.matchAll(/@import\s+url\(['"]?([^)'"\s]+)['"]?\);/g)]) {
        const url=new URL(match[1],base).href;code=code.replace(match[0],await css(await (await get(url)).text(),url));
      }
      for(const match of [...code.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)]) {
        if(/^(data:|#)/.test(match[1]))continue;
        code=code.replace(match[0],'url("'+await dataURL(new URL(match[1],base).href)+'")');
      }
      return code;
    }
    for(const node of [...doc.querySelectorAll('script[src],link[rel="stylesheet"]')]) {
      const url=new URL(node.getAttribute(node.tagName==='SCRIPT'?'src':'href'),location.href);
      if(url.origin!==location.origin || !url.pathname.includes('/app/'))continue;
      const replacement=doc.createElement(node.tagName==='SCRIPT'?'script':'style');
      if(node.id)replacement.id=node.id;
      const body=await (await get(url.href)).text();
      replacement.textContent=node.tagName==='SCRIPT'?body.replace(/<\/script/gi,'<\\/script'):await css(body,url.href);
      node.replaceWith(replacement);
    }
    doc.querySelectorAll('link[rel="manifest"],link[rel="apple-touch-icon"]').forEach(n=>n.remove());
    return '<!DOCTYPE html>\n'+doc.documentElement.outerHTML;
  }
  window.AppPWA={snapshot:state,inlineHtml};
  checkForUpdates();render();
})();
