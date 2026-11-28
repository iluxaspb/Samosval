// SVG-значки кнопок линии: листок ТТН и перечёркнутый самосвал.
// Эмодзи не годятся: в узкой квадратной кнопке они рендерятся по-разному на
// разных телефонах, а монетка начисления влезала в них впритык и обрезалась.
// Векторный значок наследует currentColor и всегда рисуется одинаково.
(function(){
  'use strict';

  // Листок документа с линиями текста; для забранной ТТН — листок с галочкой.
  window.svgTtnIcon = function(collected) {
    return collected
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.8 14.4l2.3 2.3 4.2-4.4"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 12.5h6M9 16h6"/></svg>';
  };

  // Дорожный знак «нельзя»: круг с диагональю, внутри целый силуэт самосвала.
  // Диагональ рисуется под самосвалом (сначала линия, потом фигура), поэтому
  // машина читается целиком, а запрет задают круг и штрих по диагонали.
  // Колёса «вырезаны» цветом кнопки (CSS-переменная --icon-hole, тёмно-серый
  // фон карточной кнопки), чтобы силуэт не сливался в пятно.
  window.svgNoReturnIcon = function() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/>'
      + '<path d="M5.6 17.9 18.4 6.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
      + '<path d="M4.8 15.6v-3.8h7.2V9.9h3l2.4 3v2.7z" fill="currentColor"/>'
      + '<circle cx="7.4" cy="16.5" r="1.5" fill="var(--icon-hole, #4b5563)"/>'
      + '<circle cx="15.3" cy="16.5" r="1.5" fill="var(--icon-hole, #4b5563)"/>'
      + '</svg>';
  };
})();
