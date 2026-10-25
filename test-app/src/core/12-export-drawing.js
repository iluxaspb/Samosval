  // === PDF ===
  function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
  async function generatePDFFromHTML(innerHtml, filename) {
    try { if (document.fonts && document.fonts.load) { await document.fonts.load('700 18px Caveat'); await document.fonts.load('400 18px Caveat'); await document.fonts.ready; } } catch(e) {}
    const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:fixed;left:-99999px;top:0;width:1400px;background:#fdfdfd;padding:10px;z-index:-1;';
    const inner = document.createElement('div'); inner.className = 'paper-report-container'; inner.style.cssText = 'zoom:1;background:#fdfdfd;'; inner.innerHTML = innerHtml;
    wrapper.appendChild(inner); document.body.appendChild(wrapper);
    try { const opt = { margin: 5, filename, image: { type: 'jpeg', quality: 0.96 }, html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#fdfdfd' }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' } }; return await html2pdf().set(opt).from(inner).outputPdf('blob'); }
    finally { document.body.removeChild(wrapper); }
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

