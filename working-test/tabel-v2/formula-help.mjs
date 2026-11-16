import {FORMULAS,CATEGORIES,searchFormulas} from "./formula-catalog.mjs";
import {dialog,esc,btn} from "./messages.mjs";

// Search + one-tap insertion, identical on Android and desktop. The dialog never
// edits a sheet until the user explicitly chooses a formula.
export function openFormulaGuide(insert) {
  const body=`<p class="tn-formula-guide-intro">Формула начинается с <b>=</b>. Ячейка: <code>A1</code>, диапазон: <code>A1:A5</code>. Между аргументами ставьте <b>;</b>, а десятичные значения можно писать через запятую. Нажмите «Вставить пример» — формула появится в строке ввода выбранной ячейки.</p>
    <div class="tn-formula-guide-search">
      <input type="search" data-formula-search placeholder="Поиск: сумма, округлить, среднее…" aria-label="Поиск по формулам">
      <select data-formula-category aria-label="Категория функций">${CATEGORIES.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </div>
    <p class="tn-formula-guide-note">Вычисления работают в этом табеле; это расширенный, но не полный набор функций Excel и Google Таблиц. Формулы могут ссылаться на ячейки текущего листа.</p>
    <div data-formula-results class="tn-formula-guide-results"></div>`;
  const el=dialog("ƒx · Справка по формулам",body);
  el.classList.add("tn-formula-help-dialog");
  const query=el.querySelector("[data-formula-search]"),
    category=el.querySelector("[data-formula-category]"),
    list=el.querySelector("[data-formula-results]");
  const draw=()=>{
    const matches=searchFormulas(query.value,category.value);
    if(!matches.length){list.innerHTML='<p class="tn-hint">Ничего не найдено. Попробуйте другой запрос.</p>';return;}
    list.innerHTML=matches.map(f=>{
      const index=FORMULAS.indexOf(f);
      return `<article class="tn-formula-help-item" data-function-name="${esc(f.name)}">
        <div class="tn-formula-help-title"><strong>${esc(f.name)}</strong>
          ${f.ru?`<span>${esc(f.ru)}</span>`:""}
          <small>${esc(f.category)}</small>
        </div>
        <p>${esc(f.description)}</p>
        <code>${esc(f.example)}</code>
        <small class="tn-formula-help-detail">${esc(f.details)}</small>
        ${btn("Вставить пример","insert-formula",`data-formula-index="${index}" aria-label="Вставить формулу ${esc(f.name)}"`)}
      </article>`;
    }).join("");
    list.querySelectorAll("[data-formula-index]").forEach(button=>{
      button.onclick=()=>{
        const f=FORMULAS[Number(button.dataset.formulaIndex)];
        if(!f)return;
        el.close();
        insert(f.example);
      };
    });
  };
  query.oninput=draw;
  category.onchange=draw;
  draw();
  return el;
}
