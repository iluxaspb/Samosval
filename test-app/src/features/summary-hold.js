

(function () {
  const button = document.getElementById('toggleReportBtn');
  if (!button) return;
  button.style.touchAction = 'none';
  button.style.userSelect = 'none';
  button.style.webkitUserSelect = 'none';
  button.style.webkitTouchCallout = 'none';
  let timer = null, pointer = null, startX = 0, startY = 0, heldKey = null;
  function cancel() { clearTimeout(timer); timer = null; pointer = null; heldKey = null; }
  function start() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (document.hidden || !button.isConnected || !button.getClientRects().length) return;
      toggleReportType();
    }, 800);
  }
  button.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  button.addEventListener('contextmenu', e => e.preventDefault());
  button.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) { cancel(); return; }
    cancel(); pointer = e.pointerId; startX = e.clientX; startY = e.clientY;
    button.setPointerCapture(e.pointerId); start();
  });
  button.addEventListener('pointermove', e => {
    if (e.pointerId !== pointer) return;
    const r = button.getBoundingClientRect();
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12 ||
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cancel();
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(type => button.addEventListener(type, cancel));
  button.addEventListener('keydown', e => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat || heldKey) return;
    heldKey = e.key; start();
  });
  button.addEventListener('keyup', cancel);
  button.addEventListener('blur', cancel);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', cancel);
})();
