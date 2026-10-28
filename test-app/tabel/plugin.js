/* Bundled test extension: visible/editable in Admin → Extensions. No Line writes. */
(function () {
  'use strict';
  const code = `// Табель 1.1.0-test.3. Код загрузчика для менеджера «Расширения».
if (!ctx.ledgerHost || ctx.ledgerHost.session().projectId !== 'samosval-offline') {
  throw new Error('Этот Табель предназначен только для тестовой среды');
}
let runtime = null, loading = null, disposed = false;
ctx.registerTab('tabel', 'Табель', '📋', async function(container) {
  if (!ctx.ledgerHost.session().tabAccess) { container.textContent = 'Нет доступа к табелю'; return; }
  if (runtime) {
    let active = false;
    try { active = await runtime.activate(); } catch (error) { console.warn('Повторное открытие Табеля:', error.message); }
    if (active !== false) return;
    await runtime.dispose(); runtime = null; loading = null;
  }
  if (!loading) {
    container.textContent = 'Открываем Табель…';
    loading = import(new URL('./test-app/tabel/entry.mjs', document.baseURI).href)
      .then(async function(module) {
        if (disposed) return;
        const result = await module.mount(ctx, container);
        if (disposed) await result.dispose(); else runtime = result;
      }).catch(function(error) { if (!disposed) container.textContent = 'Табель: ' + error.message; loading = null; });
  }
  await loading;
});
ctx.onDispose(function() { disposed = true; return runtime && runtime.dispose(); });`;
  window.SamosvalBundledPlugins = [{
    id: 'builtin-tabel', name: 'Табель', icon: '📋', version: '1.1.0-test.3',
    allowedRoles: ['admin'], enabled: true, code, bundled: true
  }];
})();
