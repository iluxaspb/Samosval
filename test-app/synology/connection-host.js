// Loaded after the classic TEST core, so lexical session state stays private.
(() => {
  if (!document.querySelector('meta[name="test-app-build"]')) return;
  import('./connection-panel.mjs').then(({mountConnectionPanel})=>mountConnectionPanel({
    status:()=>({backend:'firebase',online:navigator.onLine,syncState:getSyncStatus().state,
      signedIn:!!currentUid,uid:currentUid,admin:currentUserRole==='admin'&&currentUserStatus==='active',
      pending:pendingOps+offlinePendingCount()}),
    getIdToken:force=>auth.currentUser?.getIdToken(force),
    diagnostics:()=>showSyncDiagnostics()
  })).catch(error=>console.warn('Индикатор сервера:',error.message));
})();
