/* Installation and offline shell only. All mutations stay in the existing queues. */
(function () {
  'use strict';
  const eligible = /^https?:$/.test(location.protocol) && (location.pathname.endsWith('/index.html') || location.pathname.endsWith('/Samosval/'));
  // Read the script actually opened, not the latest manifest on the server. The meta fallback survives HTML export.
  const buildVersion = document.currentScript?.src?.match(/\/test-app\/build\/([a-f0-9]{16})\/pwa\.js(?:[?#]|$)/)?.[1]
    || document.querySelector('meta[name="app-build"]')?.content || '';
  const releaseVersion = window.PROD_APP_RELEASE?.version || document.querySelector('meta[name="app-version"]')?.content || '';
  let registration, installPrompt, shellReady = false, registrationError = '', statusError = '', installed = false;
  let manualUpdateBusy = false;
  let activeVersion = '', waitingVersion = '', updateReady = false, checking = false, statusEpoch = 0, checkInFlight, confirmedActive, confirmedWaiting;
  const watchedWorkers = new WeakSet();
  const group = document.createElement('div');
  group.id = 'app-pwa-settings'; group.className = 'form-group';
  group.style.cssText = 'border-top:1px solid var(--border);padding-top:12px;margin-top:12px';
  group.innerHTML = '<label>📲 Приложение на телефоне</label><p id="app-pwa-version" class="version-text" hidden style="font-size:12px;line-height:1.5;overflow-wrap:anywhere;text-decoration:none;cursor:default"></p><p id="app-pwa-state" role="status" style="font-size:13px;line-height:1.5"></p><button type="button" class="btn btn-primary btn-small" id="app-pwa-install">Установить приложение</button><button type="button" class="btn btn-secondary btn-small" id="app-pwa-check" style="margin-left:6px">🔄 Проверить и установить</button><a id="app-pwa-recovery-link" href="./update.html" target="_blank" rel="noopener noreferrer" style="display:block;margin-top:10px;font-size:13px;color:var(--primary)">Не обновляется? Открыть страницу восстановления обновления ↗</a><p id="app-pwa-update-message" role="status" style="font-size:12px;line-height:1.5;margin:8px 0"></p><p style="font-size:12px;color:var(--muted);line-height:1.5">Перед работой без сети войдите и откройте нужную смену с интернетом. Прибытие, погрузка и ТТН сохраняются на устройстве. После возвращения сети открытое приложение отправит очередь с обычной проверкой повторов и конфликтов; если оно закрыто — при следующем запуске. Вход в новую учётную запись, серверные операции и общие мини-игры требуют связи.</p>';
  document.querySelector('#settingsModal .modal-body')?.append(group);
  const status = group.querySelector('#app-pwa-state'), version = group.querySelector('#app-pwa-version'), install = group.querySelector('#app-pwa-install'), check = group.querySelector('#app-pwa-check');
  const updateMessage = group.querySelector('#app-pwa-update-message');
  const standalone = () => installed || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function state() {
    const activeConfirmed = registration?.active === confirmedActive, waitingConfirmed = registration?.waiting === confirmedWaiting;
    return {shellReady:shellReady && activeConfirmed, persistent:window.TestStorageState?.persistent===true, signedIn:!!currentUid,
      accessReady:permissionsLoaded && currentUserStatus==='active', shiftReady:!!stateShift(),
      waiting:!!registration?.waiting, updateReady:updateReady && waitingConfirmed, checking, installed:standalone(), error:registrationError || statusError,
      releaseVersion, buildVersion, activeVersion:activeConfirmed?activeVersion:'', waitingVersion:waitingConfirmed?waitingVersion:''};
  }
  function stateShift() { return typeof window.__prodGetShift === 'function' ? window.__prodGetShift() : null; }
  function render() {
    const s = state();
    install.hidden = s.installed;
    check.disabled = checking || manualUpdateBusy || !eligible || !('serviceWorker' in navigator) || !window.isSecureContext || !navigator.onLine;
    const releaseAdmin = typeof permissionsLoaded !== 'undefined' && permissionsLoaded && typeof canAdmin === 'function' && canAdmin();
    version.hidden = !releaseAdmin;
    version.textContent = releaseAdmin ? 'Открыта: '+(releaseVersion || 'версия не определена')+' · сборка '+(buildVersion || 'не определена')
      +'. Офлайн-копия: '+(s.activeVersion || 'не подтверждена')+'.'
      +(s.waiting?' Ожидает: '+(s.waitingVersion || 'проверка сборки')+'.':'') : '';
    if (!eligible) status.textContent = 'Для установки откройте рабочую страницу на сайте через HTTPS.';
    else if (s.error) status.textContent = (s.shellReady?'Автономная копия сохранена. Не удалось проверить обновление: ':'Не удалось подготовить запуск без сети: ')+s.error+'. Подключитесь к интернету и нажмите «Проверить обновление».';
    else if (s.activeVersion && buildVersion && s.activeVersion !== buildVersion) status.textContent = 'Сохранена другая офлайн-сборка. Готовность открытой сборки для запуска без сети ещё не подтверждена.';
    else if (!s.shellReady) status.textContent = 'Сохраняем приложение для открытия без интернета…';
    else if (!s.persistent) status.textContent = 'Файлы приложения сохранены. Браузер пока не подтвердил постоянное хранение данных. Не закрывайте страницу до проверки хранилища.';
    else if (!s.signedIn || !s.accessReady) status.textContent = 'Приложение доступно без сети. Для работы сначала войдите с интернетом и дождитесь загрузки прав.';
    else if (!s.shiftReady) status.textContent = 'Приложение доступно без сети. Откройте рабочую смену с интернетом, чтобы продолжить её офлайн.';
    else status.textContent = 'Готово к работе без интернета: приложение и текущая смена сохранены на устройстве.';
    if (s.updateReady && s.persistent) status.textContent += ' Обновление загружено: сохраните незавершённые формы, затем закройте все окна рабочей версии и откройте её снова. Очередь действий сохранится; не очищайте данные сайта.';
    else if (s.updateReady) status.textContent += ' Обновление загружено. Перед закрытием сохраните формы и дождитесь подтверждения постоянного хранилища. Не очищайте данные сайта.';
    else if (s.waiting) status.textContent += ' Обновление ожидает, но целостность файлов ещё не подтверждена. Повторите проверку с интернетом; текущие данные не изменены.';
    if (s.installed) status.textContent += ' Приложение установлено.';
    window.dispatchEvent(new CustomEvent('app-pwa-state',{detail:s}));
  }
  function workerStatus(worker) {
    if (!worker) return Promise.resolve(null);
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = result => {clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(result);};
      const timer = setTimeout(()=>finish(null),4000);
      channel.port1.onmessage=e=>finish(e.data?.type==='PROD_PWA_STATUS'?e.data:null);
      try {worker.postMessage({type:'PROD_PWA_STATUS'},[channel.port2]);} catch (_) {finish(null);}
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
  // A real, explicitly requested update: confirm the published release, wait
  // for the full offline bundle to pass SHA-256 checks, then activate/reload.
  // Never purge localStorage, IndexedDB, Firebase state or pending trip actions.
  function pendingActivity() {
    try {
      if (typeof offlinePendingCount !== 'function' || typeof pendingOps !== 'number') return true;
      if (offlinePendingCount() > 0 || pendingOps > 0) return true;
      return typeof syncState !== 'undefined' && !!syncState.pendingWrites &&
        Object.values(syncState.pendingWrites).some(Boolean);
    } catch (_) { return true; }
  }
  async function publishedManifest() {
    const response = await fetch('./app/build-manifest.json?manual=' + Date.now(),{cache:'no-store'});
    if (!response.ok) throw Error('Сайт не ответил: HTTP ' + response.status);
    const data = await response.json();
    if (!/^[a-f0-9]{16}$/.test(data.version) ||
        !Array.isArray(data.assets) || !data.assets.some(item => item.url === './index.html')) {
      throw Error('На сайте нет полного манифеста новой версии.');
    }
    return data;
  }
  async function waitForVerifiedBuild(expected) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const ready = registration?.waiting;
      if (ready) {
        const result = await workerStatus(ready);
        if (result?.version === expected && result?.complete === true) return ready;
      }
      const active = registration?.active;
      if (active) {
        const result = await workerStatus(active);
        if (result?.version === expected && result?.complete === true) return null;
      }
      await new Promise(resolve => setTimeout(resolve,450));
    }
    throw Error('Не удалось полностью скачать новую сборку. Откройте страницу восстановления.');
  }
  function applyVerifiedBuild(worker,expected) {
    return new Promise((resolve,reject) => {
      const channel = new MessageChannel();
      const finish = (err,ok) => {clearTimeout(timer);channel.port1.close();channel.port2.close();err?reject(err):resolve(ok);};
      const timer = setTimeout(() => finish(Error('Новая версия не подтвердила активацию.')),5000);
      channel.port1.onmessage = event => {
        const value = event.data;
        if (value?.type === 'PROD_PWA_APPLY' && value.version === expected && value.accepted === true) finish(null,true);
        else finish(Error('Новая версия не прошла проверку.'));
      };
      try {worker.postMessage({type:'PROD_PWA_APPLY',version:expected},[channel.port2]);}
      catch(error) {finish(error);}
    });
  }
  async function waitForActivation(expected) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const active = registration?.active;
      if (active?.state === 'activated') {
        const result = await workerStatus(active);
        if (result?.version === expected && result?.complete === true &&
            (!navigator.serviceWorker.controller || navigator.serviceWorker.controller === active)) return;
      }
      await new Promise(resolve => setTimeout(resolve,250));
    }
    throw Error('Сборка загружена, но ещё ожидает активации. Закройте другие окна рабочей версии.');
  }
  async function installPublishedUpdate() {
    if (manualUpdateBusy) return;
    manualUpdateBusy = true;
    render();
    const message = text => {updateMessage.textContent = text;};
    try {
      if (!eligible || !navigator.onLine || !window.isSecureContext) throw Error('Для обновления нужен интернет.');
      message('Проверяю последнюю версию непосредственно на сайте…');
      const latest = await publishedManifest();
      if (latest.version === buildVersion) {
        message('Уже открыта актуальная версия ' + (releaseVersion || buildVersion) + '.');
        return;
      }
      if (pendingActivity()) throw Error('Есть несинхронизированные рейсы или незавершённые записи. Дождитесь сохранения, затем повторите обновление.');
      const question = 'На сайте есть новая рабочая сборка. Установить и перезапустить приложение? Сначала закройте несохранённые формы. Данные и очередь рейсов не удаляются.';
      const agreed = typeof appConfirm === 'function' ? await appConfirm(question) : window.confirm(question);
      if (!agreed) {message('Обновление отменено.');return;}
      if (pendingActivity()) throw Error('Появились незавершённые действия, перезапуск отменён.');
      message('Загружаю новую версию, проверяю целостность файлов…');
      if (!registration) await register();
      if (!registration) throw Error('Не удалось подключить служебный файл обновления.');
      await registration.update();
      const waiting = await waitForVerifiedBuild(latest.version);
      if (pendingActivity()) throw Error('Найдены незавершённые действия. Обновление скачано, но перезапуск отменён.');
      if (waiting) {
        message('Новая сборка проверена. Применяю обновление…');
        await applyVerifiedBuild(waiting,latest.version);
      }
      await waitForActivation(latest.version);
      if (pendingActivity()) throw Error('Есть несохранённые действия: перезапуск отменён.');
      message('Обновление установлено. Перезапускаю…');
      location.replace('./index.html?update=' + encodeURIComponent(latest.version));
    } catch(error) {
      message('Обновление не установлено: ' + String(error?.message || error) +
        ' Можно воспользоваться ссылкой восстановления в этом разделе.');
    } finally {
      manualUpdateBusy = false;
      render();
    }
  }
  check.onclick = installPublishedUpdate;
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
  window.TestPWA={snapshot:state,inlineHtml};
  checkForUpdates();render();
})();
