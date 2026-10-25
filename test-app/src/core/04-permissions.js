  // === ПРАВА ===
  function isForcedAdminEmail(email) { return String(email || '').toLowerCase() === FORCED_ADMIN_EMAIL; }
  function canAdmin() { return currentUserStatus === 'active' && currentUserRole === 'admin'; }

  // === SECURITY: пока permissionsLoaded === false, разрешаем только 'line' (и админа) ===
  function hasTabAccess(tabName) {
    if(currentUserStatus!=='active')return false;
    if (currentUserRole === 'admin') return true;
    if (!permissionsLoaded) return tabName === 'line';
    if (!permissionsConfig[currentUserRole]) return false;
    return Array.isArray(permissionsConfig[currentUserRole].tabs) && permissionsConfig[currentUserRole].tabs.includes(tabName);
  }

  function hasPermission(action) { if(currentUserStatus!=='active')return false; if (currentUserRole === 'admin') return true; if (!permissionsLoaded) return false; const actions = permissionsConfig[currentUserRole]?.actions; return Array.isArray(actions) && actions.includes(action); }
  function requireEdit(action, actionName) { if (hasPermission(action)) return true; showError('👁 Нет прав на ' + (actionName || 'это действие')); return false; }

  // === SECURITY: обновляем классы perm-blocked для кнопок ===
  function updateNavUI() {
    ALL_TABS.forEach(tab => {
      const btn = document.getElementById('nav-' + tab);
      if (btn) {
        const allowed = tab === 'admin' ? canAdmin() : hasTabAccess(tab);
        btn.style.display = allowed ? '' : 'none';
        if (allowed) btn.classList.remove('perm-blocked');
        else btn.classList.add('perm-blocked');
      }
    });
  }

