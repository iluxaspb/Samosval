  // === PDF ===
  function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
  async function generatePDFFromHTML(innerHtml, filename) {
    try { if (document.fonts && document.fonts.load) { await document.fonts.load('700 18px Caveat'); await document.fonts.load('400 18px Caveat'); await document.fonts.ready; } } catch(e) {}
    const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:fixed;left:-99999px;top:0;width:1400px;background:#fdfdfd;padding:10px;z-index:-1;';
    const inner = document.createElement('div'); inner.className = 'paper-report-container'; inner.style.cssText = 'zoom:1;background:#fdfdfd;'; inner.innerHTML = innerHtml;
    wrapper.appendChild(inner); document.body.appendChild(wrapper);
    try { const opt = { margin: 5, filename, image: { type: 'jpeg', quality: 0.96 }, html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#fdfdfd' }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' } }; return await html2pdf().set(opt).from(inner).outputPdf('blob'); }
    finally { document.body.removeChild(wrapper); }
  }

  // Ручное рисование отключено в рабочей и тестовой версиях.
