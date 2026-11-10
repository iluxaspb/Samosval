  function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
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
  // Ручное рисование отключено; маркер раздела сохранён для проверки PNG.
  // === ОТЧЕТ HTML ===
  function buildReportHTML({ objectName, date, logs, activeLineIds, type, checkTTN, isClosed = false, reportTtnStatus = null }) {
    const filteredLogs = type === 'gai' ? logs.filter(l => l.isGAI) : logs.filter(l => !l.isGAI);
    const activeIds = (activeLineIds || []).filter(id => { const t = findTruck(id); if (!t) return false; return type === 'gai' ? !!t.isGAI : !t.isGAI; });
    const truckIds = new Set(activeIds); filteredLogs.forEach(l => truckIds.add(l.truckId));
    const trucks = Array.from(truckIds).map(id => { const t = findTruck(id); if (t) return t; const ref = filteredLogs.find(l => l.truckId === id); return { id, brand: (ref && ref.truckName) || 'Машина', number: '', defaultVol: 0 }; });
    const firstTime = {}; filteredLogs.forEach(l => { if (firstTime[l.truckId] === undefined || l.timestamp < firstTime[l.truckId]) firstTime[l.truckId] = l.timestamp; });
    trucks.sort((a, b) => ((firstTime[a.id] === undefined) - (firstTime[b.id] === undefined)) || ((firstTime[a.id] || 0) - (firstTime[b.id] || 0)) || String(a.id).localeCompare(String(b.id)));
    let maxTrips = 8; trucks.forEach(t => { const c = filteredLogs.filter(l => l.truckId === t.id).length; if (c > maxTrips) maxTrips = c; });
    const totalVol = filteredLogs.reduce((s, l) => s + l.volume, 0);
    let html = `<div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectName || '—')}${type === 'gai' ? ' (ГАИ)' : ''}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(date || '')}</div><div class="paper-total-info">${type === 'gai' ? `Всего рейсов ГАИ: <b>${filteredLogs.length}</b>` : `Общий объем: <b>${totalVol} м³</b>`}</div></div></div><table class="paper-table"><thead><tr><th>№</th><th style="text-align:left;">Самосвал</th>`;
    for (let i = 1; i <= maxTrips; i++) html += `<th>Рейс ${i}</th>`;
    html += `</tr></thead><tbody>`;
    trucks.forEach((t, idx) => {
      const tLogs = filteredLogs.filter(l => l.truckId === t.id).slice().sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0) || String(a.id||'').localeCompare(String(b.id||'')));
      const sum = tLogs.reduce((s, l) => s + l.volume, 0);
      let st = state.truckStatus[t.id] || {};
      let savedTtn = reportTtnStatus ? reportTtnStatus[t.id] : st.ttnStatus;
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (isClosed && tLogs.length > 0 && savedTtn !== true && savedTtn !== 'pending') : (tLogs.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-size:10px; font-weight:bold;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
      const brandCell = type === 'gai' ? `${escapeHtml(t.brand)} <span class="paper-truck-volume">Рейсов: ${tLogs.length}</span>${dupHtml}` : `${escapeHtml(t.brand)} <span class="paper-truck-volume">${sum} м³ / ${tLogs.length} р</span>${dupHtml}`;
      html += `<tr><td style="font-weight:bold;">${idx + 1}</td><td class="truck-cell"><div class="paper-truck-brand">${brandCell}</div>${t.number ? renderRussianPlate(t.number) : ''}</td>`;
      for (let i = 0; i < maxTrips; i++) {
        const l = tLogs[i];
        if (l) {
          const isLast = (i === tLogs.length - 1);
          const cH = (checkTTN && checkTTN(t.id, l.id, isLast)) ? '<div class="hand-drawn-circle"></div>' : '';
          let commHtml = l.comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l.comment)}</div>` : '';
          html += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l.timeStr)}</div><div class="paper-trip-num">${i + 1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l.createdByEmail, l.createdBy))}</div>${commHtml}</div></td>`;
        } else if (type !== 'gai' && i === tLogs.length && st.ttnStatus === 'pending') {
          let dotHtml = st.arriveStatus ? `<div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div>` : '';
          html += `<td><div class="cell-content"><div class="hand-drawn-circle"></div>${dotHtml}</div></td>`;
        } else if (type !== 'gai' && i === tLogs.length && st.arriveStatus) {
          html += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div></div></td>`;
        } else html += '<td></td>';
      }
      html += '</tr>';
    });
    html += `</tbody></table>`;
    return html;
  }

  async function exportCurrentReportPNG(type) {
    if (!state.shift) { showError('Смена не начата'); return; }
    if (type === 'gai' && !hasPermission('view_gai_report')) { showError('Нет прав'); return; }
    const logs = getLogs().filter(l => type === 'gai' ? l.isGAI : !l.isGAI);
    if (!logs.length) { showError('Нет данных'); return; }
    try {
      showToastEl('⏳ Подготовка PNG...', false);
      const html = buildReportHTML({ objectName: objectTitle(state.shift.objectId,state.shift.objectName), date: state.shift.startDate, logs, activeLineIds: getActiveLineIds(), type, checkTTN: type === 'regular' ? (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId : null });
      const blob = await generatePNGFromHTML(html); downloadReportPNG(blob, `report_${type}_${Date.now()}.png`); showToastEl('✅ PNG готов', false);
    } catch(e) { showError('Ошибка PNG: ' + e.message); }
  }
  async function exportArchivePNG() {
    // Export the archive sheet that is currently displayed, not a re-sorted/rebuilt report.
    if (!hasTabAccess('archive') || !viewingArchiveId) return;
    const archiveId = viewingArchiveId;
    const isGAI = viewingArchiveGAITable;
    const archive = state.archive.find(s => s.id === archiveId);
    const modal = document.getElementById('archiveModal');
    const liveWrapper = modal?.querySelector('#modalArchiveBody #archive-paper-wrapper');
    const livePaper = liveWrapper?.querySelector('.paper-report-container');
    const button = modal?.querySelector('#archiveSavePngBtn, button[onclick="exportArchivePNG()"]');
    if (!archive || !livePaper || typeof window.html2pdf !== 'function') {
      showError('Экспорт изображения недоступен');
      return;
    }

    // Snapshot before any await: the user may switch dates or report types while PNG renders.
    const snapshot = liveWrapper.cloneNode(true);
    const sheet = snapshot.querySelector('.paper-report-container');
    const scroller = snapshot.querySelector('.paper-scroll-wrapper');
    snapshot.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    snapshot.style.width = 'max-content';
    snapshot.style.maxWidth = 'none';
    snapshot.style.height = 'auto';
    if (scroller) {
      scroller.style.width = 'max-content';
      scroller.style.maxWidth = 'none';
      scroller.style.overflow = 'visible';
      scroller.style.height = 'auto';
      scroller.style.margin = '0';
    }
    sheet.style.zoom = '1';
    sheet.style.transform = 'none';
    sheet.style.transition = 'none';
    sheet.style.width = 'max-content';
    sheet.style.maxWidth = 'none';

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:max-content;background:#fdfdfd;pointer-events:none;z-index:-1';
    holder.appendChild(snapshot);
    document.body.appendChild(holder);
    if (button) button.disabled = true;
    let worker;
    try {
      if (document.fonts?.ready) await Promise.race([
        document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2500))
      ]);
      const table = snapshot.querySelector('.paper-table');
      const rootBounds = snapshot.getBoundingClientRect();
      const width = Math.ceil(Math.max(
        1, snapshot.scrollWidth, rootBounds.width, sheet.scrollWidth,
        table ? table.getBoundingClientRect().right - rootBounds.left + 12 : 0
      ));
      const height = Math.ceil(Math.max(1, snapshot.scrollHeight, rootBounds.height));
      // Fit very wide/long reports inside browser canvas limits without dropping trips.
      const scale = Math.min(2, Math.sqrt(16000000 / (width * height)), 8192 / width, 8192 / height);
      worker = window.html2pdf().set({
        margin: 0,
        pagebreak: { mode: [], before: [], after: [], avoid: [] },
        html2canvas: {
          scale, width, height, windowWidth: Math.max(window.innerWidth, width),
          windowHeight: Math.max(window.innerHeight, height),
          scrollX: 0, scrollY: 0, useCORS: true, logging: false, backgroundColor: '#fdfdfd'
        },
        jsPDF: { unit: 'px', format: 'a4' }
      }).from(snapshot).toContainer().then(function () {
        // html2pdf normally constrains its intermediate container to A4 width.
        // The PNG must instead cover the full rendered archive table.
        this.prop.container.style.width = width + 'px';
        this.prop.container.style.maxWidth = 'none';
        this.prop.container.style.height = 'auto';
        this.prop.container.style.overflow = 'visible';
      });
      const canvas = await worker.toCanvas().get('canvas');
      if (!canvas || canvas.width < width * scale * 0.97 ||
          canvas.height < height * scale * 0.97) {
        throw new Error('PNG получился обрезанным');
      }
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('Браузер не смог создать PNG')), 'image/png')
      );
      const safeName = String(archive.objectName || 'Объект').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70);
      const safeDate = String(archive.date || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url;
      link.download = safeName + '_' + safeDate + (isGAI ? '_ГАИ' : '') + '.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      showToastEl('Отчёт PNG сохранён', false);
    } catch (e) {
      console.warn('Archive PNG', e);
      showError('Не удалось сохранить PNG: ' + e.message);
    } finally {
      if (worker?.prop?.overlay?.parentNode) worker.prop.overlay.remove();
      holder.remove();
      if (button) button.disabled = false;
    }
  }
  // === ОТЧЕТЫ РЕНДЕР ===
