(function(){
  if (window.__analyticsV2) return;
  window.__analyticsV2 = true;

  // ===== CSS (наследуем от v1, пересоздаём) =====
  const oldCss = document.getElementById('analytics-v2-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'analytics-v2-css';
  css.textContent = `
    .an-section {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; padding: 14px; margin-bottom: 12px;
    }
    .an-title { font-size: 14px; font-weight: 800; margin-bottom: 10px; color: var(--text); }
    .an-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(115px, 1fr)); gap: 8px; }
    .an-stat { background: var(--bg); padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
    .an-stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
    .an-stat-value { font-size: 18px; font-weight: 800; color: var(--text); }
    .an-stat-value.green { color: var(--success); }
    .an-stat-value.blue { color: var(--primary); }
    .an-stat-value.orange { color: var(--warning); }
    .an-stat-value.red { color: var(--danger); }
    .an-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .an-table th, .an-table td { padding: 6px 4px; text-align: left; border-bottom: 1px solid var(--border); }
    .an-table th { font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 700; }
    .an-table td.an-num { text-align: right; font-variant-numeric: tabular-nums; }
    .an-bar-wrap { position: relative; height: 22px; background: var(--bg); border-radius: 4px; overflow: hidden; border: 1px solid var(--border); }
    .an-bar-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); border-radius: 4px; }
    .an-bar-row { margin-bottom: 8px; }
    .an-bar-header { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
    .an-filter-row { display: flex; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
    .an-filter-btn {
      flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg); color: var(--text); font-size: 11px; font-weight: 600;
      cursor: pointer; min-height: 30px; min-width: 60px;
    }
    .an-filter-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }
    .an-audit-item { padding: 8px 10px; margin-bottom: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
    .an-audit-meta { font-size: 10px; color: var(--muted); margin-bottom: 3px; display: flex; gap: 8px; flex-wrap: wrap; }
    .an-audit-meta .an-audit-user { color: #93c5fd; font-weight: 600; }
    .an-audit-text { color: var(--text); font-weight: 500; line-height: 1.3; }
    .an-empty { color: var(--muted); text-align: center; padding: 20px; font-size: 12px; }
    .an-warning {
      background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 6px; padding: 8px 10px; font-size: 11px; color: #fca5a5;
      margin-bottom: 10px; line-height: 1.4;
    }
  `;
  document.head.appendChild(css);

  // ===== Хелперы =====
  function isGaiTruck(id) {
    try {
      const t = (typeof findTruck === 'function') ? findTruck(id) : null;
      return !!(t && t.isGAI);
    } catch(e) { return false; }
  }

  function getShiftLogs() {
    const shiftId = state.shift ? state.shift.id : null;
    return shiftId ? state.logs.filter(l => l.shiftId === shiftId) : [];
  }

  function calcTruckCycles(truckId, logs) {
    const truckLogs = logs.filter(l => l.truckId === truckId && !l.isGAI).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (truckLogs.length < 2) return [];
    const cycles = [];
    for (let i = 1; i < truckLogs.length; i++) {
      const d = (truckLogs[i].timestamp || 0) - (truckLogs[i - 1].timestamp || 0);
      if (d > 60000 && d < 4 * 3600000) cycles.push(d);
    }
    return cycles;
  }

  function formatDuration(ms) {
    if (!ms) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'м';
    const h = Math.floor(m / 60);
    return h + 'ч ' + (m % 60) + 'м';
  }

  function parseDate(dateStr) {
    if (!dateStr) return null;
    let m = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return { day: +m[1], month: +m[2], year: +m[3] };
    m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return { day: +m[3], month: +m[2], year: +m[1] };
    return null;
  }

  // ===== Блоки =====

  function renderCurrentShiftStats() {
    if (!state.shift) {
      return `<div class="an-section"><div class="an-title">📊 Текущая смена</div><div class="an-empty">Смена не начата</div></div>`;
    }
    const logs = getShiftLogs();
    // ТОЛЬКО обычные рейсы
    const stdLogs = logs.filter(l => !l.isGAI);
    const totalVol = stdLogs.reduce((s, l) => s + (l.volume || 0), 0);

    let duration = '—';
    if (state.shift.startedAt) {
      const ms = Date.now() - state.shift.startedAt;
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      duration = h > 0 ? `${h}ч ${m}м` : `${m}м`;
    }

    const cyc = (settings.cycleMinutes || 15);

    // Циклы — только по обычным машинам
    const cyclesIds = new Set();
    Object.keys(state.truckStatus).forEach(id => {
      const st = state.truckStatus[id];
      if (st && st.onLine && !isGaiTruck(id)) cyclesIds.add(id);
    });
    // Рейсы — только не-ГАИ
    stdLogs.forEach(l => cyclesIds.add(l.truckId));

    const allCycles = [];
    cyclesIds.forEach(id => allCycles.push(...calcTruckCycles(id, logs)));

    const avgCycle = allCycles.length ? allCycles.reduce((a, b) => a + b, 0) / allCycles.length : null;
    const avgCycleStr = avgCycle ? formatDuration(avgCycle) : '—';
    const avgClass = !avgCycle ? '' : (avgCycle <= cyc * 60000 ? 'green' : avgCycle <= cyc * 1.3 * 60000 ? 'orange' : 'red');

    // На линии — только обычные
    const activeLine = Object.keys(state.truckStatus).filter(id => {
      const st = state.truckStatus[id];
      return st && st.onLine && !isGaiTruck(id);
    }).length;

    return `
      <div class="an-section">
        <div class="an-title">📊 Текущая смена</div>
        <div class="an-grid">
          <div class="an-stat"><div class="an-stat-label">Объект</div><div class="an-stat-value" style="font-size:14px;">${escapeHtml(state.shift.objectName || '—')}</div></div>
          <div class="an-stat"><div class="an-stat-label">Длительность</div><div class="an-stat-value">${duration}</div></div>
          <div class="an-stat"><div class="an-stat-label">Рейсов</div><div class="an-stat-value blue">${stdLogs.length}</div></div>
          <div class="an-stat"><div class="an-stat-label">Объём</div><div class="an-stat-value green">${totalVol} м³</div></div>
          <div class="an-stat"><div class="an-stat-label">Средний цикл</div><div class="an-stat-value ${avgClass}">${avgCycleStr}</div></div>
          <div class="an-stat"><div class="an-stat-label">Норма</div><div class="an-stat-value">${cyc}м</div></div>
          <div class="an-stat"><div class="an-stat-label">На линии</div><div class="an-stat-value">${activeLine}</div></div>
        </div>
      </div>
    `;
  }

  function renderCycles() {
    const logs = getShiftLogs();
    const cyc = (settings.cycleMinutes || 15) * 60000;

    const ids = new Set();
    Object.keys(state.truckStatus).forEach(id => {
      const st = state.truckStatus[id];
      if (st && st.onLine && !isGaiTruck(id)) ids.add(id);
    });
    // Только обычные рейсы
    logs.forEach(l => { if (!l.isGAI) ids.add(l.truckId); });
    // Дополнительная страховка — исключить ГАИ-id
    Array.from(ids).forEach(id => { if (isGaiTruck(id)) ids.delete(id); });

    if (!ids.size) {
      return `<div class="an-section"><div class="an-title">⏱ Циклы по самосвалам</div><div class="an-empty">Нет данных</div></div>`;
    }

    const rows = [];
    ids.forEach(id => {
      const t = (typeof findTruck === 'function') ? findTruck(id) : null;
      const cycles = calcTruckCycles(id, logs);
      const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
      const tripsCount = logs.filter(l => l.truckId === id && !l.isGAI).length;
      rows.push({ id, t, avg, tripsCount });
    });
    rows.sort((a, b) => (b.avg || 0) - (a.avg || 0));
    const maxAvg = Math.max.apply(null, rows.map(r => r.avg || 0).concat([1]));

    return `
      <div class="an-section">
        <div class="an-title">⏱ Циклы по самосвалам (норма ${Math.round(cyc/60000)}м)</div>
        ${rows.map(r => {
          const name = r.t ? (r.t.brand + ' ' + r.t.number) : r.id;
          const avgStr = r.avg ? formatDuration(r.avg) : '—';
          const pct = r.avg ? Math.min(100, (r.avg / maxAvg) * 100) : 0;
          const color = !r.avg ? '#64748b' : (r.avg <= cyc ? '#22c55e' : r.avg <= cyc * 1.3 ? '#f59e0b' : '#ef4444');
          return `
            <div class="an-bar-row">
              <div class="an-bar-header">
                <span>${escapeHtml(name)}</span>
                <span style="font-weight:700; color:${color};">${avgStr} · ${r.tripsCount} рейс</span>
              </div>
              <div class="an-bar-wrap"><div class="an-bar-fill" style="width:${pct}%; background: ${color};"></div></div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderTopTrucks() {
    const cutoff = Date.now() - 30 * 86400000;
    const recent = (state.archive || []).filter(s => (s.closedAt || 0) >= cutoff);

    if (!recent.length) {
      return `<div class="an-section"><div class="an-title">🏆 Топ самосвалов (30 дней)</div><div class="an-empty">Нет данных</div></div>`;
    }

    const byTruck = {};
    recent.forEach(s => {
      (s.logs || []).forEach(l => {
        if (l.isGAI) return; // ← без ГАИ
        const key = l.truckId || l.truckName || '?';
        if (!byTruck[key]) byTruck[key] = { name: l.truckName || key, trips: 0, volume: 0 };
        byTruck[key].trips++;
        byTruck[key].volume += (l.volume || 0);
      });
    });

    const sorted = Object.values(byTruck).sort((a, b) => b.trips - a.trips).slice(0, 10);
    if (!sorted.length) {
      return `<div class="an-section"><div class="an-title">🏆 Топ самосвалов (30 дней)</div><div class="an-empty">Нет данных</div></div>`;
    }

    return `
      <div class="an-section">
        <div class="an-title">🏆 Топ самосвалов (30 дней)</div>
        <table class="an-table">
          <thead><tr><th>#</th><th>Самосвал</th><th class="an-num">Рейсов</th><th class="an-num">Объём</th></tr></thead>
          <tbody>
            ${sorted.map((t, i) => `
              <tr>
                <td><b>${i + 1}</b></td>
                <td>${escapeHtml(t.name)}</td>
                <td class="an-num"><b>${t.trips}</b></td>
                <td class="an-num">${t.volume} м³</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderMonthly() {
    const byMonth = {};
    (state.archive || []).forEach(s => {
      const p = parseDate(s.date);
      if (!p) return;
      const key = p.year + '-' + String(p.month).padStart(2, '0');
      if (!byMonth[key]) byMonth[key] = { shifts: 0, trips: 0, volume: 0 };
      byMonth[key].shifts++;
      // ← без ГАИ
      const logs = (s.logs || []).filter(l => !l.isGAI);
      byMonth[key].trips += logs.length;
      byMonth[key].volume += logs.reduce((sum, l) => sum + (l.volume || 0), 0);
    });

    const months = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6);
    if (!months.length) {
      return `<div class="an-section"><div class="an-title">📅 Месячная статистика</div><div class="an-empty">Нет данных</div></div>`;
    }

    return `
      <div class="an-section">
        <div class="an-title">📅 Месячная статистика</div>
        <table class="an-table">
          <thead><tr><th>Месяц</th><th class="an-num">Смен</th><th class="an-num">Рейсов</th><th class="an-num">Объём</th></tr></thead>
          <tbody>
            ${months.map(m => `
              <tr>
                <td><b>${m[0]}</b></td>
                <td class="an-num">${m[1].shifts}</td>
                <td class="an-num">${m[1].trips}</td>
                <td class="an-num">${m[1].volume} м³</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderUserActivity() {
    const cutoff = Date.now() - 7 * 86400000;
    const recent = (state.audit || []).filter(a => (a.timestamp || 0) >= cutoff);

    if (!recent.length) {
      return `<div class="an-section"><div class="an-title">👥 Активность (7 дней)</div><div class="an-empty">Нет данных</div></div>`;
    }

    const byUser = {};
    recent.forEach(a => {
      const u = a.userName || a.createdBy || '—';
      byUser[u] = (byUser[u] || 0) + 1;
    });
    const sorted = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
    const maxVal = Math.max.apply(null, sorted.map(x => x[1]).concat([1]));

    return `
      <div class="an-section">
        <div class="an-title">👥 Активность (7 дней)</div>
        ${sorted.map(x => {
          const pct = (x[1] / maxVal) * 100;
          return `
            <div class="an-bar-row">
              <div class="an-bar-header">
                <span>👤 ${escapeHtml(x[0])}</span>
                <span style="font-weight:700; color:#93c5fd;">${x[1]} действий</span>
              </div>
              <div class="an-bar-wrap"><div class="an-bar-fill" style="width:${pct}%; background:#3b82f6;"></div></div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  let auditPeriod = 'today';

  function renderAuditLog() {
    let cutoff = 0;
    const now = Date.now();
    if (auditPeriod === 'today') cutoff = now - 86400000;
    else if (auditPeriod === 'week') cutoff = now - 7 * 86400000;
    else if (auditPeriod === 'month') cutoff = now - 30 * 86400000;

    const items = (state.audit || []).filter(a => (a.timestamp || 0) >= cutoff);

    if (!items.length) return '<div class="an-empty">Нет записей за выбранный период</div>';

    return items.slice(0, 200).map(a => {
      const user = a.userName || a.createdBy || a.userEmail || '—';
      const objName = a.objectName && a.objectName !== '—' ? a.objectName : '';
      return `
        <div class="an-audit-item">
          <div class="an-audit-meta">
            <span>${escapeHtml(a.timeStr || new Date(a.timestamp || 0).toLocaleString('ru-RU'))}</span>
            <span class="an-audit-user">👤 ${escapeHtml(user)}</span>
            ${objName ? `<span>🏢 ${escapeHtml(objName)}</span>` : ''}
          </div>
          <div class="an-audit-text">${escapeHtml(a.text || '')}</div>
        </div>
      `;
    }).join('');
  }

  // ===== Main render =====
  let lastRender = 0;
  window.renderAnalytics = function(force) {
    const now = Date.now();
    if (!force && now - lastRender < 500) return;
    lastRender = now;

    if (typeof hasTabAccess === 'function' && !hasTabAccess('analytics')) return;

    const tab = document.getElementById('tab-analytics');
    if (!tab) return;

    tab.innerHTML = `
      <div class="section-title">📊 Аналитика</div>
      ${renderCurrentShiftStats()}
      ${renderCycles()}
      ${renderTopTrucks()}
      ${renderMonthly()}
      ${renderUserActivity()}
      <div class="section-title">📝 Журнал действий</div>
      <div class="an-warning">⚠️ Журнал нельзя очистить. Записываются все действия всех пользователей.</div>
      <div class="an-filter-row" id="auditFilterRow">
        <button class="an-filter-btn ${auditPeriod === 'today' ? 'active' : ''}" data-period="today">Сегодня</button>
        <button class="an-filter-btn ${auditPeriod === 'week' ? 'active' : ''}" data-period="week">Неделя</button>
        <button class="an-filter-btn ${auditPeriod === 'month' ? 'active' : ''}" data-period="month">Месяц</button>
        <button class="an-filter-btn ${auditPeriod === 'all' ? 'active' : ''}" data-period="all">Все</button>
      </div>
      <div id="auditLogContainer">${renderAuditLog()}</div>
    `;

    tab.querySelectorAll('#auditFilterRow .an-filter-btn').forEach(btn => {
      btn.onclick = () => { auditPeriod = btn.dataset.period; window.renderAnalytics(true); };
    });
  };

  setTimeout(() => {
    if (document.getElementById('tab-analytics')?.classList.contains('active')) {
      window.renderAnalytics(true);
    }
  }, 500);

  console.log('[analytics-v2] ✅ Активен. ГАИ исключён из всех расчётов.');
})();