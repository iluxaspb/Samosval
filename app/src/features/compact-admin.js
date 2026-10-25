try { (function(){
  if (window.__adminCompactV2) return;
  window.__adminCompactV2=true;
  const css=document.createElement('style');css.id='admin-compact-css';
  css.textContent=`body.admin-active-page #statusTicker,body.admin-active-page #headerExtraContent{display:none!important}.admin-tabs{display:grid!important;grid-template-columns:repeat(4,1fr)!important;gap:4px!important;overflow:visible!important;padding:0!important;margin-bottom:12px!important}.admin-tab-btn{padding:6px 3px!important;font-size:9.5px!important;min-height:34px!important;border-radius:6px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}body.admin-active-page .container{padding-top:10px!important}`;
  document.head.append(css);
  function update(){const tab=document.getElementById('tab-admin');document.body.classList.toggle('admin-active-page',!!tab?.classList.contains('active'));}
  const tab=document.getElementById('tab-admin');if(tab)new MutationObserver(update).observe(tab,{attributes:true,attributeFilter:['class']});update();
})();; }
catch (e) { console.error('[baked patch: Компактная админка]', e); }
