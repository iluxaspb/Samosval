/* Installation and offline shell only. All mutations stay in the existing queues. */
(function () {
  'use strict';
  const eligible = /^https?:$/.test(location.protocol) && location.pathname.endsWith('/index-test.html');
  // Read the script actually opened, not the latest manifest on the server. The meta fallback survives HTML export.
  const buildVersion = document.currentScript?.src?.match(/\/test-app\/build\/([a-f0-9]{16})\/pwa\.js(?:[?#]|$)/)?.[1]
    || document.querySelector('meta[name="test-app-build"]')?.content || '';
  const releaseVersion = window.TEST_APP_RELEASE?.version || document.querySelector('meta[name="test-app-version"]')?.content || '';
  let registration, installPrompt, shellReady = false, registrationError = '', statusError = '', installed = false;
  let manualUpdateBusy = false, latestPublished = null, publishedCheck = null;
  const updateBanner=document.createElement('aside');
  updateBanner.id='app-update-banner';updateBanner.hidden=true;
  updateBanner.setAttribute('aria-label','Обновление приложения');
  updateBanner.innerHTML='<span id="app-update-label">Доступно обновление</span><button type="button" class="btn btn-quick btn-small" id="app-update-apply">Установить</button><span id="app-update-status" role="status"></span>';
  document.querySelector('#mainHeader .header-inner')?.append(updateBanner);
  const updateApply=updateBanner.querySelector('#app-update-apply'),bannerMessage=updateBanner.querySelector('#app-update-status');
  const bannerCss=document.createElement('style');bannerCss.textContent='#app-update-banner:not([hidden]){display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 10px;margin-top:6px;border:1px solid var(--success,#22c55e);border-radius:10px;background:var(--card,#142333);font-size:13px}#app-update-label{flex:1;font-weight:700}#app-update-status{flex-basis:100%;font-size:12px}';document.head.append(bannerCss);
  let activeVersion = '', waitingVersion = '', updateReady = false, checking = false, statusEpoch = 0, checkInFlight, confirmedActive, confirmedWaiting;
  const watchedWorkers = new WeakSet();
  const group = document.createElement('div');
  group.id = 'test-pwa-settings'; group.className = 'form-group';
  group.style.cssText = 'border-top:1px solid var(--border);padding-top:12px;margin-top:12px';
  group.innerHTML = '<label>📲 Приложение на телефоне</label><p id="test-pwa-version" class="release-diagnostics" hidden style="font-size:12px;line-height:1.5;overflow-wrap:anywhere;text-decoration:none;cursor:default"></p><p id="test-pwa-state" role="status" style="font-size:13px;line-height:1.5"></p><button type="button" class="btn btn-quick btn-small" id="test-pwa-install">Установить приложение</button><button type="button" class="btn btn-secondary btn-small" id="test-pwa-check" style="margin-left:6px">🔄 Проверить и установить</button><a id="test-pwa-recovery-link" href="./update-test.html" target="_blank" rel="noopener noreferrer" style="display:block;margin-top:10px;font-size:13px;color:var(--primary)">Не обновляется? Открыть страницу восстановления обновления ↗</a><p id="test-pwa-update-message" role="status" style="font-size:12px;line-height:1.5;margin:8px 0"></p><p style="font-size:12px;color:var(--muted);line-height:1.5">Перед работой без сети войдите и откройте нужную смену с интернетом. Прибытие, погрузка и ТТН сохраняются на устройстве. После возвращения сети открытое приложение отправит очередь с обычной проверкой повторов и конфликтов; если оно закрыто — при следующем запуске. Вход в новую учётную запись, серверные операции и общие мини-игры требуют связи.</p>';
  document.querySelector('#settingsModal .modal-body')?.append(group);
  const status = group.querySelector('#test-pwa-state'), version = group.querySelector('#test-pwa-version'), install = group.querySelector('#test-pwa-install'), check = group.querySelector('#test-pwa-check');
  const updateMessage = group.querySelector('#test-pwa-update-message');
  let progressDialog=null,installTarget='';
  function updateProgress(phase,text,completed,total){
    if(!progressDialog){
      progressDialog=document.createElement('dialog');progressDialog.id='app-update-dialog';progressDialog.setAttribute('aria-labelledby','app-update-title');
      progressDialog.innerHTML='<div class="au-heading"><span class="au-icon">↗</span><button type="button" id="app-update-close" aria-label="Свернуть">×</button></div><h2 id="app-update-title">Обновление приложения</h2><p id="app-update-phase" role="status" aria-live="polite"></p><progress id="app-update-progress" max="100" aria-label="Ход обновления"></progress><p id="app-update-count"></p><ol class="au-steps"><li>Проверка</li><li>Файлы</li><li>Установка</li><li>Запуск</li></ol><p id="app-update-detail"></p><p class="au-note">Рейсы, табель и очередь действий сохраняются.</p>';
      document.body.append(progressDialog);progressDialog.querySelector('#app-update-close').onclick=()=>progressDialog.close();
      const css=document.createElement('style');css.textContent='#app-update-dialog{position:fixed;inset:0;margin:auto;box-sizing:border-box;width:min(420px,calc(100vw - 28px));max-height:90dvh;overflow:auto;padding:24px;border:1px solid var(--border,#334155);border-radius:22px;background:var(--card,#122135);color:var(--text,#f1f5f9);box-shadow:0 24px 80px #0008}#app-update-dialog::backdrop{background:#020617b3;backdrop-filter:blur(5px)}.au-heading{display:flex;justify-content:space-between;align-items:center}.au-icon{display:grid;place-items:center;background:#22c55e22;border-radius:14px;width:44px;height:44px;color:#4ade80;font-size:28px}#app-update-close{border:0;background:transparent;color:inherit;font-size:28px;padding:4px 8px}#app-update-title{font-size:21px;margin:18px 0 12px}#app-update-phase{font-weight:700;line-height:1.5}#app-update-progress{appearance:none;width:100%;height:12px;border:0;border-radius:99px;overflow:hidden;background:#334155}#app-update-progress::-webkit-progress-bar{background:#334155;border-radius:99px}#app-update-progress::-webkit-progress-value{background:linear-gradient(90deg,#22c55e,#38bdf8);border-radius:99px;}#app-update-progress:indeterminate{background:linear-gradient(90deg,#334155,#38bdf8,#334155);background-size:200% 100%;animation:au-moving 1.8s linear infinite}.au-steps{list-style:none;display:grid;grid-template-columns:repeat(4,1fr);gap:5px;padding:0;font-size:10px;color:var(--muted,#94a3b8)}.au-steps li{border-top:3px solid #334155;padding-top:8px}.au-steps li.au-done{border-color:#22c55e;color:#4ade80}#app-update-detail{font-size:13px;line-height:1.6;white-space:pre-line}#app-update-count,.au-note{font-size:11px;color:var(--muted,#94a3b8)}#app-update-dialog[data-paused] #app-update-phase{color:#fbbf24}@keyframes au-moving{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){#app-update-progress{animation:none!important}}';document.head.append(css);
    }
    const labels={check:'Проверяю обновление',download:'Скачиваю и проверяю файлы',install:'Устанавливаю обновление',restart:'Запускаю новую сборку',done:'Готово',paused:'Обновление отложено',error:'Не удалось завершить обновление'};
    progressDialog.toggleAttribute('data-paused',phase==='paused');progressDialog.querySelector('#app-update-phase').textContent=labels[phase];
    progressDialog.querySelector('#app-update-detail').textContent=text||'';
    const bar=progressDialog.querySelector('progress'),count=progressDialog.querySelector('#app-update-count');
    if(Number.isInteger(completed)&&Number.isInteger(total)&&total>0){bar.max=total;bar.value=completed;count.textContent=completed+' из '+total+' файлов · '+Math.round(completed/total*100)+'%';}
    else{bar.removeAttribute('value');count.textContent=phase==='paused'?'Данные сохранены на устройстве':phase==='error'?'Можно повторить установку':'Выполняется…';}
    const index={check:0,download:1,install:2,restart:3,done:4}[phase]??-1;
    progressDialog.querySelectorAll('.au-steps li').forEach((li,i)=>li.classList.toggle('au-done',i<=index));
    if(!progressDialog.open)progressDialog.showModal();
  }
  navigator.serviceWorker?.addEventListener('message',event=>{
    const data=event.data;if(!manualUpdateBusy||data?.type!=='TEST_PWA_PROGRESS'||data.version!==installTarget||!Number.isInteger(data.completed)||!Number.isInteger(data.total)||data.completed<0||data.completed>data.total)return;
    if(![registration?.installing,registration?.waiting,registration?.active].includes(event.source))return;
    updateProgress('download','Каждый файл проверяется по контрольной сумме.',data.completed,data.total);
  });
  const standalone = () => installed || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
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
    const hasUpdate=!!latestPublished&&latestPublished.version!==buildVersion;
    updateBanner.hidden=!hasUpdate;
    updateApply.disabled=manualUpdateBusy||!navigator.onLine;
    updateApply.textContent=manualUpdateBusy?'Устанавливаю…':'Установить';
    install.hidden = s.installed;
    check.disabled = checking || manualUpdateBusy || !eligible || !('serviceWorker' in navigator) || !window.isSecureContext || !navigator.onLine;
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
    if (s.updateReady && s.persistent) status.textContent += ' Доступно обновление. Нажмите «Установить»: приложение проверит данные и перезапустится. Очередь действий сохранится.';
    else if (s.updateReady) status.textContent += ' Доступно обновление. Сохраните формы и нажмите «Установить». Не очищайте данные сайта.';
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
      channel.port1.onmessage=e=>finish(e.data?.type==='TEST_PWA_STATUS'?e.data:null);
      try {worker.postMessage({type:'TEST_PWA_STATUS'},[channel.port2]);} catch (_) {finish(null);}
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
      registration = await navigator.serviceWorker.register('./sw-test.js',{scope:'./index-test.html',updateViaCache:'none'});
      registrationError='';watch(registration.installing);
      registration.addEventListener('updatefound',()=>watch(registration.installing));
      await askStatus();if(registration.active?.state==='activated'&&activeVersion===buildVersion)registration.active.postMessage({type:'TEST_PWA_PRUNE'});render();return true;
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
  function updateBlockReason(){
    try{
      if(typeof offlinePendingCount!=='function'||typeof pendingOps!=='number')return 'Не удалось проверить сохранение действий. Подождите загрузки приложения и повторите установку.';
      const trips=offlinePendingCount();if(trips>0)return 'На устройстве '+trips+' несинхронизированных действий с рейсами. Дождитесь их отправки на сервер, затем нажмите «Установить» снова.';
      if(pendingOps>0||typeof syncState!=='undefined'&&Object.values(syncState.pendingWrites||{}).some(Boolean))return 'Сейчас сохраняются изменения. Дождитесь подтверждения сохранения и повторите установку.';
      if(typeof nasRuntimeClient!=='undefined'&&nasRuntimeClient){
        for(const key of ['samosval_nas_commands_v1:'+nasRuntimeClient.scope,typeof nasIdentityJournalKey==='function'?nasIdentityJournalKey():'']){
          if(!key)continue;const queue=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(queue))return 'Не удалось проверить очередь сервера. Перезапуск отменён для сохранения данных.';
          if(queue.length)return 'Есть неподтверждённые изменения на сервере: '+queue.length+'. Повторите их сохранение и дождитесь подтверждения.';
        }
      }
      return '';
    }catch{return 'Не удалось проверить очередь данных. Перезапуск отменён: ваши записи не удалены.';}
  }
  async function assertUpdateSafe(){
    let reason=updateBlockReason();
    if(!reason&&typeof window.__tabelPrepareUpdate==='function'){
      try{const table=await window.__tabelPrepareUpdate();if(table.pending||table.uploading)reason='В табеле есть неподтверждённые записи: '+table.pending+'. Дождитесь сохранения или разрешите конфликт в табеле, затем повторите установку.';}
      catch{reason='Не удалось подтвердить сохранение табеля. Закончите ввод и повторите установку.';}
    }
    if(reason)throw Object.assign(Error(reason),{updatePaused:true});
  }
  async function publishedManifest() {
    const response = await fetch('./test-app/build-manifest.json?manual=' + Date.now(),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('Сайт не ответил: HTTP ' + response.status);
    const data = await response.json();
    if (!/^[a-f0-9]{16}$/.test(data.version) ||
        !Array.isArray(data.assets) || !data.assets.some(item => item.url === './index-test.html')) {
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
        if (value?.type === 'TEST_PWA_APPLY' && value.version === expected && value.accepted === true) finish(null,true);
        else finish(Error('Новая версия не прошла проверку.'));
      };
      try {worker.postMessage({type:'TEST_PWA_APPLY',version:expected},[channel.port2]);}
      catch(error) {finish(error);}
    });
  }
  async function waitForActivation(expected) {
    const deadline=Date.now()+90000;let lastRequest=0,attempts=0;
    while(Date.now()<deadline){
      const waiting=registration?.waiting,active=registration?.active;
      if(waiting?.state==='installed'){
        // Avoid repeatedly waking the old active worker while it must become idle.
        // A bounded repeat also recovers a lost native activation request.
        if(attempts<4&&Date.now()-lastRequest>2000){lastRequest=Date.now();attempts++;await applyVerifiedBuild(waiting,expected);}
      }else if(active?.state==='activated'){
        const result=await workerStatus(active);
        if(result?.version===expected&&result?.complete===true)return;
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw Error('Браузер не подтвердил активацию. Данные сохранены; повторите установку при устойчивом соединении.');
  }
  async function installPublishedUpdate() {
    if (manualUpdateBusy) return;
    manualUpdateBusy = true;installTarget='';
    updateProgress('check','Проверяю опубликованную сборку и сохранение данных.');
    render();
    const message = text => {updateMessage.textContent = text;bannerMessage.textContent=text;};
    try {
      if (!eligible || !navigator.onLine || !window.isSecureContext) throw Error('Для обновления нужен интернет.');
      message('Проверяю последнюю версию непосредственно на сайте…');
      const latest = await publishedManifest();latestPublished=latest;installTarget=latest.version;render();
      if (latest.version === buildVersion) {
        message('Уже открыта актуальная сборка ' + (releaseVersion || buildVersion) + '.');updateProgress('done','У вас уже установлена актуальная сборка.',1,1);
        return;
      }
      await assertUpdateSafe();
      const question = 'Установить новую сборку и перезапустить это окно приложения? Данные сохраняются. Сначала завершите ввод в открытых формах.';
      progressDialog.close();
      const agreed = typeof appConfirm === 'function' ? await appConfirm(question) : window.confirm(question);
      if (!agreed) {message('Обновление отменено.');return;}
      await assertUpdateSafe();
      message('Загружаю новую сборку, проверяю целостность файлов…');updateProgress('download','Получаю проверенный комплект файлов приложения.');
      if (!registration) await register();
      if (!registration) throw Error('Не удалось подключить служебный файл обновления.');
      await registration.update();
      const waiting = await waitForVerifiedBuild(latest.version);
      await assertUpdateSafe();
      if (waiting) {
        message('Новая сборка проверена. Применяю обновление…');updateProgress('install','Все файлы получены и проверены. Переключаю сборку.');
        await applyVerifiedBuild(waiting,latest.version);
      }
      updateProgress('install','Ожидаю подтверждения запуска новой сборки от браузера.');
      await waitForActivation(latest.version);
      await assertUpdateSafe();
      message('Обновление установлено. Перезапускаю…');updateProgress('restart','Запускаю новую сборку. Рейсы и табель сохранены.');
      location.replace('./index-test.html?update=' + encodeURIComponent(latest.version));
    } catch(error) {
      const detail=String(error?.message||error);message((error.updatePaused?'Обновление отложено: ':'Обновление не установлено: ')+detail);updateProgress(error.updatePaused?'paused':'error',detail);
    } finally {
      manualUpdateBusy = false;
      render();
    }
  }
  async function discoverPublishedUpdate(){
    if(!eligible||!navigator.onLine||document.hidden)return;
    if(publishedCheck)return publishedCheck;
    publishedCheck=(async()=>{try{latestPublished=await publishedManifest();render();}catch{/* A failed check never claims an update is available. */}})().finally(()=>{publishedCheck=null;});
    return publishedCheck;
  }
  updateApply.onclick=installPublishedUpdate;
  check.onclick = installPublishedUpdate;
  setInterval(discoverPublishedUpdate,120000);
  const resume = () => {
    render();
    if (navigator.onLine && !document.hidden) {
      offlineTransportRecovered(); offlineReplayJournal();
      checkForUpdates();discoverPublishedUpdate();
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
      if(url.origin!==location.origin || !url.pathname.includes('/test-app/'))continue;
      const replacement=doc.createElement(node.tagName==='SCRIPT'?'script':'style');
      if(node.id)replacement.id=node.id;
      const body=await (await get(url.href)).text();
      replacement.textContent=node.tagName==='SCRIPT'?body.replace(/<\/script/gi,'<\\/script'):await css(body,url.href);
      node.replaceWith(replacement);
    }
    doc.querySelectorAll('link[rel="manifest"],link[rel="apple-touch-icon"]').forEach(n=>n.remove());
    return '<!DOCTYPE html>\n'+doc.documentElement.outerHTML;
  }
  window.TestPWA={snapshot:state,inlineHtml,checkForUpdates:discoverPublishedUpdate,installUpdate:installPublishedUpdate};
  checkForUpdates();discoverPublishedUpdate();render();
})();
