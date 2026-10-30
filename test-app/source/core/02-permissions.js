  function isForcedAdminEmail(email) { return String(email || '').toLowerCase() === FORCED_ADMIN_EMAIL; }
  function canViewReleaseHistory() { return permissionsLoaded && currentUserStatus === 'active' && ['admin','foreman'].includes(currentUserRole); }
  function canAdmin() { return currentUserStatus === 'active' && currentUserRole === 'admin'; }

  // === SECURITY: пока permissionsLoaded === false, разрешаем только 'line' (и админа) ===
  function hasTabAccess(tabName) {
    if(currentUserStatus!=='active')return false;
    if (currentUserRole === 'admin') return true;
    if (!permissionsLoaded) return tabName === 'line';
    if(tabName==='timesheet'&&currentUserRole==='foreman')return true;
    if (!permissionsConfig[currentUserRole]) return false;
    return Array.isArray(permissionsConfig[currentUserRole].tabs) && permissionsConfig[currentUserRole].tabs.includes(tabName);
  }

  function hasPermission(action) { if(currentUserStatus!=='active')return false; if (currentUserRole === 'admin') return true; if (!permissionsLoaded) return false; const actions = permissionsConfig[currentUserRole]?.actions; return Array.isArray(actions) && actions.includes(action); }
  function requireEdit(action, actionName) { if (hasPermission(action)) return true; showError('👁 Нет прав на ' + (actionName || 'это действие')); return false; }

  // === SECURITY: обновляем классы perm-blocked для кнопок ===
  function updateNavUI() {
    renderTestBackendControls();
    ALL_TABS.forEach(tab => {
      const btn = document.getElementById(tab==='timesheet'?'nav-tabel-v2':'nav-' + tab);
      if (btn) {
        const allowed = tab === 'admin' ? canAdmin() : hasTabAccess(tab);
        btn.style.display = allowed ? '' : 'none';
        if (allowed) btn.classList.remove('perm-blocked');
        else btn.classList.add('perm-blocked');
      }
    });
  }

  // === УТИЛИТЫ ===
  function sanitizeName(name) { if (!name) return ''; let s = String(name).trim(); let at = s.indexOf('@'); if (at > 0) s = s.substring(0, at); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function getUserName() { return currentUserNickname || sanitizeName(currentEmail) || '—'; }
  function resolveUserDisplayName(email, fallbackNick) {
    const clean=value=>String(value||'').trim(),normal=value=>clean(value).toLowerCase();
    const identity=normal(email);
    if(identity&&identity===normal(currentEmail)&&clean(currentUserNickname))return clean(currentUserNickname);
    const user=identity?(state.users||[]).find(u=>normal(u.email)===identity):null;
    if(clean(user?.nickname))return clean(user.nickname);
    const fallback=clean(fallbackNick);
    if(fallback&&fallback!=='—'&&(!identity||normal(fallback)!==identity))return fallback;
    return sanitizeName(email||fallback)||'—';
  }
