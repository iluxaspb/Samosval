  // === ОТЧЁТЫ PNG ===
  function reportPNGDeadline(task, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      Promise.resolve(task).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  async function generatePNGFromHTML(innerHtml) {
    try { if (document.fonts && document.fonts.load) await reportPNGDeadline(Promise.all([document.fonts.load('700 18px Caveat'), document.fonts.load('400 18px Caveat'), document.fonts.ready]), 2000, 'Шрифт недоступен'); } catch(e) {}
    const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:fixed;left:-99999px;top:0;width:1400px;background:#fdfdfd;padding:10px;z-index:-1;';
    const inner = document.createElement('div'); inner.className = 'paper-report-container'; inner.style.cssText = 'zoom:1;background:#fdfdfd;width:1400px;'; inner.innerHTML = innerHtml;
    wrapper.appendChild(inner); document.body.appendChild(wrapper);
    let worker;
    try {
      const width = Math.max(1400, inner.scrollWidth), height = Math.max(1, inner.scrollHeight);
      const scale = Math.min(2, Math.sqrt(16000000 / (width * height)), 8192 / Math.max(width, height));
      // Reuse the bundled rasterizer only: no PDF pages, A4 clipping or JPEG conversion.
      worker = html2pdf().set({ margin: 0, pagebreak: { mode: [], before: [], after: [], avoid: [] }, html2canvas: { scale, width, height, windowWidth: Math.max(window.innerWidth || 0, width), windowHeight: Math.max(window.innerHeight || 0, height), scrollX: 0, scrollY: 0, useCORS: true, logging: false, backgroundColor: '#fdfdfd', imageTimeout: 10000 } }).from(inner).toContainer().then(function () {
        this.prop.container.style.width = width + 'px';
        this.prop.container.style.height = 'auto';
        this.prop.container.style.margin = '0';
      });
      const canvas = await reportPNGDeadline(worker.toCanvas().get('canvas'), 45000, 'Не удалось подготовить PNG. Повторите выгрузку отчёта.');
      if (!canvas || !canvas.width || !canvas.height) throw new Error('Получено пустое изображение отчёта');
      if (canvas.width < width * scale * 0.97 || canvas.height < height * scale * 0.97) throw new Error('PNG получился обрезанным');
      return await reportPNGDeadline(new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось сохранить изображение отчёта')), 'image/png')), 15000, 'Сохранение PNG заняло слишком много времени');
    } finally {
      if (worker?.prop?.overlay?.parentNode) worker.prop.overlay.parentNode.removeChild(worker.prop.overlay);
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }
  }
  function downloadReportPNG(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Ручное рисование отключено в рабочей и тестовой версиях.
