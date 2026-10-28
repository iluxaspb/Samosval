/* Independent second extension. Existing bundled extensions are preserved. */
(function () {
  const code = `if (!ctx.ledgerHost || ctx.ledgerHost.session().projectId !== 'samosval-offline') throw Error('Только тестовая среда');
let app=null, loading=null, disposed=false;
ctx.registerTab('tabel-next','Табель новый','▦',async container=>{
 if(!ctx.ledgerHost.session().tabAccess){container.textContent='Нет доступа к табелю';return;}
 if(app){app.show();return;}
 if(!loading)loading=import(new URL('./test-app/tabel-next/app.mjs',document.baseURI).href).then(async m=>{if(disposed)return;app=await m.mount(ctx,container);if(disposed)await app.dispose();}).catch(e=>{container.textContent=e.message;loading=null;});
 await loading;
});
ctx.onDispose(async()=>{disposed=true;if(app)await app.dispose();});`;
  window.SamosvalBundledPlugins = [
    ...(window.SamosvalBundledPlugins || []),
    {
      id: "builtin-tabel-next",
      name: "Табель новый",
      icon: "▦",
      version: "2.0.0-test.1",
      allowedRoles: ["admin"],
      enabled: true,
      code,
      bundled: true,
    },
  ];
})();
