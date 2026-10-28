  function renderAnalytics() {
    if (!hasTabAccess('analytics')) return; // === SECURITY ===
    let c = document.getElementById('auditLogContainer'); if(!c) return;
    c.innerHTML = renderAuditEntries();
  }
