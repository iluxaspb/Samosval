(() => {
  const style = document.createElement('style');
  style.textContent = `#steel-launch{position:fixed;right:16px;bottom:90px;z-index:10000}#steel-panel{position:fixed;right:8px;bottom:8px;width:min(680px,calc(100vw - 16px));height:65dvh;z-index:10001;background:#18181b;color:#fff;border:1px solid #777;border-radius:12px;display:flex;flex-direction:column;overflow:hidden}#steel-panel[hidden]{display:none}#steel-panel.full{inset:0;width:100%;height:100dvh;border:0;border-radius:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);box-sizing:border-box}#steel-panel header{display:flex;flex-wrap:wrap;gap:6px;padding:8px}#steel-panel button,#steel-launch,#steel-panel select{min-height:44px;font:16px system-ui;padding:6px 10px;background:#333;color:white;border:1px solid #888;border-radius:8px}#steel-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto}#steel-canvas{max-width:100%;max-height:100%;object-fit:contain;touch-action:none}#steel-panel footer{padding:8px;font:13px system-ui}#steel-input{font:16px system-ui;width:calc(100% - 24px);margin:4px 12px;min-height:44px} @media(max-width:480px){#steel-panel{height:80dvh}#steel-panel header{gap:4px}}`;
  document.head.append(style);
  const launch = document.createElement('button'); launch.id = 'steel-launch'; launch.textContent = 'Браузер'; document.body.append(launch);
  const panel = document.createElement('section'); panel.id = 'steel-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Живой браузер Steel');
  panel.innerHTML = `<header><select id="steel-mode" aria-label="Режим управления"><option value="view">Только просмотр</option><option value="manual">Ручное управление</option></select><button id="steel-full">На весь экран</button><button id="steel-close">Свернуть</button></header><div id="steel-stage"><canvas id="steel-canvas" tabindex="0" aria-label="Живой экран Chromium"></canvas></div><input id="steel-input" aria-label="Ввод текста в браузер" placeholder="Текст → Enter для отправки" type="password" autocomplete="off" disabled><footer id="steel-status" role="status">Подключение…</footer>`;
  document.body.append(panel);
  const el = id => panel.querySelector('#steel-' + id);
  const zoom = document.createElement('select');
  zoom.setAttribute('aria-label', 'Масштаб живого экрана');
  zoom.innerHTML = '<option value="1">Вписать</option><option value="2">200%</option><option value="4">400%</option>';
  panel.querySelector('header').append(zoom);
  const canvas = el('canvas'), ctx = canvas.getContext('2d');
  let ws, mode = 'view', frames = 0, decoding = false, pending, viewport;
  const send = m => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  function updateTouch() {
    canvas.style.touchAction = mode === 'view' && Number(zoom.value) > 1 ? 'pan-x pan-y' : 'none';
  }
  function sizeCanvas() {
    const stage = el('stage'), scale = Number(zoom.value);
    if (!canvas.width || !canvas.height) return;
    const fit = Math.min(stage.clientWidth / canvas.width, stage.clientHeight / canvas.height);
    canvas.style.width = Math.floor(canvas.width * fit * scale) + 'px';
    canvas.style.height = Math.floor(canvas.height * fit * scale) + 'px';
    canvas.style.maxWidth = 'none'; canvas.style.maxHeight = 'none';
    stage.style.display = scale > 1 ? 'block' : 'flex';
    updateTouch();
  }
  zoom.onchange = sizeCanvas;
  new ResizeObserver(sizeCanvas).observe(el('stage'));
  async function draw(blob) {
    pending = blob; if (decoding) return; decoding = true;
    while (pending) {
      const next = pending; pending = null;
      try { const image = await createImageBitmap(next); canvas.width = image.width; canvas.height = image.height; ctx.drawImage(image, 0, 0); image.close(); sizeCanvas(); frames++; canvas.dataset.frames = frames; } catch { /* A malformed frame never becomes input. */ }
    }
    decoding = false;
  }
  launch.onclick = () => {
    panel.hidden = false;
    if (ws && ws.readyState < 2) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__browser/stream`);
    ws.onmessage = e => {
      if (typeof e.data !== 'string') { draw(e.data); return; }
      const m = JSON.parse(e.data);
      if (m.type === 'viewport') viewport = m;
      if (m.type === 'viewerState') { mode = m.mode; updateTouch(); el('mode').value = mode; el('input').disabled = mode !== 'manual'; el('status').textContent = `Steel: ${m.session.status}; target ${m.session.target}; ${mode === 'view' ? 'просмотр' : 'ручное управление — не запускайте автоматизацию одновременно'}`; }
      if (m.data) draw(new Blob([Uint8Array.from(atob(m.data), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
      if (m.type === 'targetClosed') el('status').textContent = 'Страница закрыта';
    };
    ws.onclose = () => { el('status').textContent = 'Поток завершён / соединение закрыто'; mode = 'view'; el('input').disabled = true; };
    ws.onerror = () => { el('status').textContent = 'Ошибка подключения к live-view'; };
  };
  el('mode').onchange = e => send({ type: 'mode', value: e.target.value });
  el('close').onclick = () => { send({ type: 'mode', value: 'view' }); panel.hidden = true; panel.classList.remove('full'); ws?.close(); };
  el('full').onclick = async () => {
    panel.classList.toggle('full');
    el('full').textContent = panel.classList.contains('full') ? 'Обычный размер' : 'На весь экран';
    try { if (panel.classList.contains('full')) await panel.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* CSS full-screen remains available. */ }
  };
  const coords = e => { const r = canvas.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * (viewport?.width || canvas.width) / r.width), y: Math.round((e.clientY - r.top) * (viewport?.height || canvas.height) / r.height) }; };
  for (const [event, type] of [['pointerdown', 'mousePressed'], ['pointerup', 'mouseReleased']]) canvas.addEventListener(event, e => {
    if (mode !== 'manual') return; e.preventDefault(); canvas.focus(); send({ type: 'mouseEvent', event: { type, ...coords(e), button: 'left', clickCount: 1 } });
  });
  canvas.addEventListener('wheel', e => { if (mode !== 'manual') return; e.preventDefault(); send({ type: 'mouseEvent', event: { type: 'mouseWheel', ...coords(e), deltaX: e.deltaX, deltaY: e.deltaY } }); }, { passive: false });
  canvas.onkeydown = e => { if (mode !== 'manual') return; e.preventDefault(); send({ type: 'keyEvent', event: { type: 'keyDown', key: e.key, code: e.code, keyCode: e.keyCode, text: e.key.length === 1 ? e.key : undefined } }); };
  canvas.onkeyup = e => { if (mode !== 'manual') return; e.preventDefault(); send({ type: 'keyEvent', event: { type: 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode } }); };
  el('input').onkeydown = e => { if (e.key !== 'Enter' || mode !== 'manual') return; e.preventDefault(); const text = e.target.value; send({ type: 'keyEvent', event: { type: 'char', text } }); e.target.value = ''; };
})();
