// SVG-значки кнопок линии: лист ТТН и самосвал «больше не приедет».
// Эмодзи не годятся: в узкой квадратной кнопке они рендерятся по-разному на
// разных телефонах и не масштабируются под контур кнопки. Векторный значок
// занимает всю площадь кнопки и одинаков на всех устройствах.
//
// Общие правила оформления (решение владельца 28.11.2026):
// - фон кнопки серый, значки светлые; активное состояние — зелёный фон;
// - галочка «выполнено» выполнена одинаково на обеих кнопках (svgDoneCheck)
//   и лежит поверх значка, не меняя его форму;
// - ни звука, ни анимации: только состояние.
(function(){
  'use strict';

  // Крупная галочка «действие выполнено». Подложка цветом активной кнопки
  // отделяет её от значка под ней, поэтому галочка читается и на белом листе,
  // и на цветном самосвале. Одна функция на обе кнопки — стиль не разойдётся.
  function svgDoneCheck(){
    return '<g>'
      + '<path d="M8.1 12.9 11.1 15.9 16.4 9.6" fill="none" stroke="#166534" stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M8.1 12.9 11.1 15.9 16.4 9.6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</g>';
  }

  // Белый контурный лист документа с загнутым верхним правым углом.
  // Форма и цвет листа одинаковы в обоих состояниях: забранная ТТН отличается
  // только галочкой поверх листа.
  window.svgTtnIcon = function(collected) {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">'
      + '<path d="M14.1 3.4H7.9A1.7 1.7 0 0 0 6.2 5.1v13.8a1.7 1.7 0 0 0 1.7 1.7h8.2a1.7 1.7 0 0 0 1.7-1.7V7.9z"'
      + ' stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M14.1 3.4v4.5h3.7" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M9.2 12.4h5.6M9.2 16.2h5.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>'
      + (collected ? svgDoneCheck() : '')
      + '</svg>';
  };

  // Самосвал как в стандартной клавиатуре: светло-серый кузов, синяя кабина,
  // тёмные колёса. Цветной — таким он остаётся и в активном состоянии.
  function svgTruck(){
    return '<rect x="3.1" y="8.2" width="9.4" height="7.6" rx="0.9" fill="#dbe3ec"/>'
      + '<path d="M12.5 10h3.2l3.1 3.4v2.4h-6.3z" fill="#3b82f6"/>'
      + '<path d="M13.6 11h1.6l1.7 1.9h-3.3z" fill="#bfdbfe"/>'
      + '<circle cx="7" cy="16.6" r="1.8" fill="#1f2937"/><circle cx="7" cy="16.6" r="0.65" fill="#9ca3af"/>'
      + '<circle cx="15.4" cy="16.6" r="1.8" fill="#1f2937"/><circle cx="15.4" cy="16.6" r="0.65" fill="#9ca3af"/>';
  }

  // Самосвал под красным знаком запрета (круг + диагональ): знак лежит поверх
  // машины, композиция единая, кузов остаётся цветным. Значок одинаков в обоих
  // состояниях — после нажатия меняется только фон кнопки и добавляется
  // галочка поверх значка (решение владельца 28.11.2026).
  window.svgNoReturnIcon = function(done) {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">'
      + svgTruck()
      + '<circle cx="12" cy="12" r="9.3" fill="none" stroke="#ef4444" stroke-width="2"/>'
      + '<path d="M5.4 18.6 18.6 5.4" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/>'
      + (done ? svgDoneCheck() : '')
      + '</svg>';
  };
})();
