/* Installation and offline shell only. All mutations stay in the existing queues. */
(function () {
  'use strict';
  const eligible = /^https?:$/.test(location.protocol) && location.pathname.endsWith('/index-test.html');
  let registration, installPrompt, shellReady = false, registrationError = '', installed = false;
  const group = document.createElement('div');
  group.id = 'test-pwa-settings'; group.className = 'form-group';
  group.style.cssText = 'border-top:1px solid var(--border);padding-top:12px;margin-top:12px';
  group.innerHTML = '<label>📲 Приложение на телефоне</label><p id="test-pwa-state" role="status" style="font-size:13px;line-height:1.5"></p><button type="button" class="btn btn-primary btn-small" id="test-pwa-install">Установить приложение</button><button type="button" class="btn btn-secondary btn-small" id="test-pwa-check" style="margin-left:6px">Проверить обновление</button><p style="font-size:12px;color:var(--muted);line-height:1.5">Перед работой без сети войдите и откройте нужную смену с интернетом. Прибытие, погрузка и ТТН сохраняются на устройстве. После возвращения сети открытое приложение отправит очередь с обычной проверкой повторов и конфликтов; если оно закрыто — при следующем запуске. Вход в новую учётную запись, серверные операции и общие мини-игры требуют связи.</p>';
  document.querySelector('#settingsModal .modal-body')?.append(group);
  const status = group.querySelector('#test-pwa-state'), install = group.querySelector('#test-pwa-install'), check = group.querySelector('#test-pwa-check');
  const standalone = () => installed || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function state() {
    return {shellReady, persistent:window.TestStorageState?.persistent===true, signedIn:!!currentUid,
      accessReady:permissionsLoaded && currentUserStatus==='active', shiftReady:!!stateShift(),
      waiting:!!registration?.waiting, installed:standalone(), error:registrationError};
  }
  function stateShift() { return typeof window.__testGetShift === 'function' ? window.__testGetShift() : null; }
  function render() {
    const s = state();
    install.hidden = s.installed;
    check.disabled = !eligible || !('serviceWorker' in navigator) || !navigator.onLine;
    if (!eligible) status.textContent = 'Для установки откройте тестовую страницу на сайте через HTTPS.';
    else if (registrationError) status.textContent = (shellReady?'Автономная копия сохранена. Не удалось проверить обновление: ':'Не удалось подготовить запуск без сети: ')+registrationError+'. Подключитесь к интернету и нажмите «Проверить обновление».';
    else if (!shellReady) status.textContent = 'Сохраняем приложение для открытия без интернета…';
    else if (!s.persistent) status.textContent = 'Файлы приложения сохранены. Браузер пока не подтвердил постоянное хранение данных. Не закрывайте страницу до проверки хранилища.';
    else if (!s.signedIn || !s.accessReady) status.textContent = 'Приложение доступно без сети. Для работы сначала войдите с интернетом и дождитесь загрузки прав.';
    else if (!s.shiftReady) status.textContent = 'Приложение доступно без сети. Откройте рабочую смену с интернетом, чтобы продолжить её офлайн.';
    else status.textContent = 'Готово к работе без интернета: приложение и текущая смена сохранены на устройстве.';
    if (s.waiting) status.textContent += ' Обновление загружено: закройте все окна тестовой версии и откройте её снова. Очередь действий сохранится.';
    if (s.installed) status.textContent += ' Приложение установлено.';
    window.dispatchEvent(new CustomEvent('test-pwa-state',{detail:s}));
  }
  async function askStatus() {
    const worker = registration?.active;
    if (!worker) return;
    const channel = new MessageChannel();
    const result = await new Promise(resolve => {
      const timer = setTimeout(()=>{channel.port1.close();resolve(null);},4000);
      channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(e.data);};
      worker.postMessage({type:'TEST_PWA_STATUS'},[channel.port2]);
    });
    shellReady = result?.complete === true;
    render();
  }
  function watch(worker) {
    worker?.addEventListener('statechange',()=>{
      if (worker.state === 'redundant') registrationError='загрузка файлов прервана';
      if (worker.state === 'activated') {registrationError='';askStatus();}
      render();
    });
  }
  async function register() {
    if (!eligible || !('serviceWorker' in navigator) || !window.isSecureContext) {
      registrationError = eligible ? 'браузер не поддерживает установку на этом адресе' : '';
      render(); return;
    }
    try {
      registration = await navigator.serviceWorker.register('./sw-test.js',{scope:'./index-test.html',updateViaCache:'none'});
      registrationError='';watch(registration.installing);
      registration.addEventListener('updatefound',()=>watch(registration.installing));
      await askStatus();render();
    } catch (error) {registrationError=error.message;render();}
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
  check.onclick = async () => {
    try {if(!registration)await register();else await registration.update();registrationError='';await askStatus();render();}
    catch(error){registrationError=error.message;render();}
  };
  const resume = () => {
    render();
    if (navigator.onLine && !document.hidden) {
      offlineTransportRecovered(); offlineReplayJournal();
      registration?.update().catch(()=>{});
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
  window.TestPWA={snapshot:state,inlineHtml};
  register();render();
})();
