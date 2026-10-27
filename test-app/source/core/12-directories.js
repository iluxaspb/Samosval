  function renderGlobalTrucksManage() {
    if (!hasTabAccess('trucks')) return; // === SECURITY ===
    let c = document.getElementById('globalTrucksManageList'); if(!c) return; let e = hasPermission('manage_trucks');
    c.innerHTML = state.trucks.map(t=>{ let gaiTag = t.isGAI ? '<span style="font-size:10px;background:rgba(148,163,184,0.2);color:#cbd5e1;padding:2px 4px;border-radius:4px;margin-left:8px;">ГАИ</span>' : ''; let volText = t.isGAI ? '' : `(${t.defaultVol}м³)`; return `<div class="log-item"><div><b>${escapeHtml(t.brand)}</b> ${renderRussianPlate(t.number)} ${volText} ${gaiTag}</div>${e?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="editGlobalTruck('${t.id}')">✏️</button><button class="btn-del" onclick="deleteGlobalTruck('${t.id}')">X</button></div>`:''}</div>`; }).join('');
  }
  function renderGlobalObjectsManage() {
    if (!hasTabAccess('trucks')) return; // === SECURITY ===
    let c = document.getElementById('globalObjectsManageList'); if(!c) return; let e = hasPermission('manage_objects');
    c.innerHTML = state.objects.map(o=>`<div class="log-item"><div>${escapeHtml(o.name)}</div>${e?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="editGlobalObject('${o.id}')">✏️</button><button class="btn-del" onclick="deleteGlobalObject('${o.id}')">X</button></div>`:''}</div>`).join('');
  }
  function switchBaseSubTab(n) {
    document.getElementById('subBtnTrucks').style.background = n==='trucks'?'var(--primary)':'var(--border)';
    document.getElementById('subBtnObjects').style.background = n==='objects'?'var(--primary)':'var(--border)';
    document.getElementById('subtab-trucks').style.display = n==='trucks'?'block':'none';
    document.getElementById('subtab-objects').style.display = n==='objects'?'block':'none';
  }

