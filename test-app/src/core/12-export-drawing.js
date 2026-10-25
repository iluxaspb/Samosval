  // === ОТЧЁТЫ PNG ===
  async function generatePNGFromHTML(innerHtml) {
    const deadline = (task, ms, message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      Promise.resolve(task).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    try { if (document.fonts && document.fonts.load) await deadline(Promise.all([document.fonts.load('700 18px Caveat'), document.fonts.load('400 18px Caveat'), document.fonts.ready]), 2000, 'Шрифт недоступен'); } catch(e) {}
    const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:fixed;left:-99999px;top:0;width:1400px;background:#fdfdfd;padding:10px;z-index:-1;';
    const inner = document.createElement('div'); inner.className = 'paper-report-container'; inner.style.cssText = 'zoom:1;background:#fdfdfd;width:1400px;'; inner.innerHTML = innerHtml;
    wrapper.appendChild(inner); document.body.appendChild(wrapper);
    let worker;
    try {
      const width = Math.max(1400, inner.scrollWidth), height = Math.max(1, inner.scrollHeight);
      const scale = Math.min(2, Math.sqrt(16000000 / (width * height)), 16384 / Math.max(width, height));
      // Reuse the bundled rasterizer only: no PDF pages, A4 clipping or JPEG conversion.
      worker = html2pdf().set({ margin: 0, pagebreak: { mode: [], before: [], after: [], avoid: [] }, html2canvas: { scale, useCORS: true, logging: false, backgroundColor: '#fdfdfd', imageTimeout: 10000 } }).from(inner).toContainer().then(function () {
        this.prop.container.style.width = width + 'px';
        this.prop.container.style.height = 'auto';
        this.prop.container.style.margin = '0';
      });
      const canvas = await deadline(worker.toCanvas().get('canvas'), 45000, 'Не удалось подготовить PNG. Повторите выгрузку отчёта.');
      if (!canvas || !canvas.width || !canvas.height) throw new Error('Получено пустое изображение отчёта');
      return await deadline(new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось сохранить изображение отчёта')), 'image/png')), 15000, 'Сохранение PNG заняло слишком много времени');
    } finally {
      if (worker?.prop?.overlay?.parentNode) worker.prop.overlay.parentNode.removeChild(worker.prop.overlay);
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }
  }
  function downloadReportPNG(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // === STYLUS ===
  function setupStylus(canvasId, containerId) {
    const canvas = document.getElementById(canvasId); const container = document.getElementById(containerId);
    if (!canvas || !container) return;
    canvas.width = container.scrollWidth; canvas.height = container.scrollHeight;
    const ctx = canvas.getContext('2d'); ctx.strokeStyle = '#0000FF'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    let isDrawing = false;
    canvas.addEventListener('pointerdown', (e) => { if (!drawMode) return; e.preventDefault(); isDrawing = true; const rect = canvas.getBoundingClientRect(); ctx.beginPath(); ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top); });
    canvas.addEventListener('pointermove', (e) => { if (!isDrawing) return; e.preventDefault(); const rect = canvas.getBoundingClientRect(); ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top); ctx.stroke(); });
    canvas.addEventListener('pointerup', () => { isDrawing = false; });
    canvas.addEventListener('pointerleave', () => { isDrawing = false; });
  }
  function toggleDrawMode() {
    drawMode = !drawMode;
    const c1 = document.getElementById('draw-canvas-main'); const c2 = document.getElementById('draw-canvas-gai'); const btn = document.getElementById('btnDrawToggle');
    if (drawMode) { if (c1) c1.classList.add('active'); if (c2) c2.classList.add('active'); btn.innerHTML = '🖐 Отключить'; btn.classList.replace('btn-secondary', 'btn-quick'); showToastEl('✏️ Рисование ВКЛ', false); }
    else { if (c1) c1.classList.remove('active'); if (c2) c2.classList.remove('active'); btn.innerHTML = '✏️ Рисовать'; btn.classList.replace('btn-quick', 'btn-secondary'); showToastEl('🖐 Рисование ВЫКЛ', false); }
  }
  function clearDrawings() { ['draw-canvas-main', 'draw-canvas-gai'].forEach(id => { const c = document.getElementById(id); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); }); showToastEl('🗑 Очищено', false); }
  function toggleDrawModeArchive() {
    const c = document.getElementById('draw-canvas-archive'); const btn = document.getElementById('btnDrawToggleArchive'); if (!c) return;
    const isActive = c.classList.contains('active');
    if (isActive) { c.classList.remove('active'); btn.innerHTML = '✏️ Рисовать'; btn.classList.replace('btn-quick', 'btn-secondary'); drawMode = false; }
    else { c.classList.add('active'); btn.innerHTML = '🖐 Отключить'; btn.classList.replace('btn-secondary', 'btn-quick'); drawMode = true; }
  }
  function clearDrawingsArchive() { const c = document.getElementById('draw-canvas-archive'); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); showToastEl('🗑 Очищено', false); }

