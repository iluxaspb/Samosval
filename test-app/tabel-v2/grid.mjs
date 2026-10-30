import { chooseColor, colorField, bindColorFields } from "./color-palette.mjs";
import {FORMULAS} from "./formula-catalog.mjs";
import {openFormulaGuide} from "./formula-help.mjs";
import {syntaxParts,formulaReferences} from "./formula-syntax.mjs";
import {applyBorders,borderLine,BORDER_PRESETS} from './cell-borders.mjs';
import {mergeCells,unmergeCells,intersectingMerges} from './cell-merge.mjs';
import { numberInput } from "./number-input.mjs";
import * as D from "./table-domain.mjs";
import { esc, btn, input, field, dialog, error } from "./messages.mjs";
import { presence, userColors, selectionContains } from './presence.mjs';
export async function mount(s, host) {
  let sheetId = "linked",
    selected = "A1",
    end = "A1",
    sheet,
    base,
    undo = [],
    redo = [],
    disposed = false,
    chain = Promise.resolve(),
    startRow = 0;
  let dirty = false,
    hasSelection = false,
    suppressClick = false,
    referencePick = null,
    pickingReference = false;
  const c = s.config(),
    allDays = s.days();
  s.gridUndo ||= {};
  const stacks = (id) =>
    (s.gridUndo[s.object.id + "/" + id] ||= { undo: [], redo: [] });
  let activeStack = false;
  const saveStacks = () => {
    if (!activeStack) return;
    const st = stacks(sheetId);
    st.undo = undo;
    st.redo = redo;
  };
  let period = "all",
    week = "",
    scale = 0.7;
  const simple = () => sheetId === "linked" && s.config().tableMode !== "full";
  let visibleDays = [],
    linkedRows = [];
  host.innerHTML = `<div class="tn-grid-tools">${btn("‹", "back", 'title="К смене"')}${btn("↶", "undo", 'aria-label="Отменить действие" title="Отменить действие"')}${btn("↷", "redo", 'aria-label="Повторить действие" title="Повторить действие"')}${btn("＋ День", "day")}${btn("Состав", "roster")}${btn("Формат", "format")}${btn("⋯", "menu")}<select data-period aria-label="Период"><option value="all">Весь объект</option><option value="week">Неделя</option></select><select data-week aria-label="Неделя"></select><select data-zoom aria-label="Масштаб"><option value="0.55">55%</option><option value="0.7" selected>70%</option><option value="1">100%</option><option value="0.85">85%</option><option value="1.2">120%</option></select></div><div class="tn-grid-scroll" tabindex="0"><table class="tn-grid"></table></div><output class="tn-selection-total" data-selection-total aria-live="polite">Сумма: 0</output><div class="tn-cell-tools" role="toolbar" aria-label="Инструменты ячеек"></div><div class="tn-sheets"></div><div class="tn-input-dock"><div class="tn-formula-suggestions" hidden></div><div class="tn-formula"><input data-range value="A1" aria-label="Диапазон"><span>ƒx</span><div class="tn-formula-editor"><div class="tn-formula-render" aria-hidden="true"></div><input data-editor aria-label="Значение / формула" autocomplete="off" spellcheck="false"></div>${btn("?", "formula-help", 'class="tn-formula-help-trigger" title="Справка по формулам" aria-label="Справка по формулам"')}${btn("✓", "apply", 'aria-label="Применить"')}</div><div class="tn-symbols">${["=", "+", "−", "*", "/", "(", ")", ",", ":", "СУММ("].map((x) => btn(esc(x), "symbol", `data-symbol="${esc(x)}"`)).join("")}</div></div>`;

  const table = host.querySelector("table"),
    scroll = host.querySelector(".tn-grid-scroll"),
    edit = host.querySelector("[data-editor]"),
    formulaMirror = host.querySelector(".tn-formula-render"),
    selectionBox = document.createElement("div"),
    rangeInput = host.querySelector("[data-range]"),
    symbols = host.querySelector(".tn-symbols"),
    dock = host.querySelector(".tn-input-dock"),
    suggestions = host.querySelector(".tn-formula-suggestions");
  const transferTools=document.createElement('div');
  transferTools.className='tn-transfer-tools';
  transferTools.innerHTML=btn('Импорт Excel','import-excel')+btn('Экспорт Excel','export-excel')+btn('Поделиться PDF','pdf');
  host.querySelector('.tn-grid-tools').after(transferTools);
  const onlineUsers=document.createElement('div');onlineUsers.className='tn-presence';onlineUsers.setAttribute('aria-label','Пользователи этого листа');
  transferTools.after(onlineUsers);
  const numericActions=document.createElement('div');numericActions.className='tn-numeric-actions';numericActions.hidden=true;
  numericActions.innerHTML=btn('Заполнить автоматически','numeric-autofill')+'<span data-numeric-range></span>';
  onlineUsers.after(numericActions);
  const numericFill=numericActions.querySelector('[data-action=numeric-autofill]');
  numericFill.onclick=()=>queue(()=>fill(selected,end));
  let others=[],presenceError='',lastPresence='';
  const actor=s.host.session();
  function paintPresence(){
    if(disposed)return;
    const people=new Map([[actor.uid,{...actor,name:actor.nickname||actor.name||actor.uid}]]);
    for(const peer of others)people.set(peer.uid,peer);
    const colors=userColors([...people.keys()]);
    onlineUsers.replaceChildren();
    for(const [id,person] of people){const name=document.createElement('span');name.style.color=colors[id];name.style.borderColor=colors[id];name.textContent=person.name+(id===actor.uid?' (вы)':'');onlineUsers.append(name);}
    const note=document.createElement('small');note.textContent=presenceError||(navigator.onLine===false?'Офлайн · присутствие не обновляется':'Сейчас на листе: '+people.size);onlineUsers.append(note);
    table.style.setProperty('--tn-own-color',colors[actor.uid]);
    host.style.setProperty('--tn-own-color',colors[actor.uid]);
    table.querySelectorAll('.tn-peer-tag').forEach(n=>n.remove());
    const tagged=new Set();
    table.querySelectorAll('[data-cell]').forEach(td=>{
      td.style.removeProperty('box-shadow');td.removeAttribute('data-peer');
      const {row,day,p}=linkedAt(td.dataset.cell);
      const peers=others.filter(peer=>peer.selection&&selectionContains(peer.selection,td.dataset.cell,row?.id||'header:'+p.r,day?D.dayKey(day.date,day.shift):'label'));
      if(!peers.length)return;
      td.dataset.peer='';
      td.style.boxShadow=peers.map((p,i)=>`inset 0 0 0 ${2+i*2}px ${colors[p.uid]}`).join(',');
      for(const peer of peers){if(tagged.has(peer.id))continue;tagged.add(peer.id);
        const tag=document.createElement('span');tag.className='tn-peer-tag';tag.style.background=colors[peer.uid];tag.textContent=peer.name;td.append(tag);}
    });
  }
  const live=presence(s,(peers,failure)=>{others=peers;presenceError=failure;paintPresence();});
  function announceSelection(){
    let stable={};
    if(sheetId==='linked'&&hasSelection){
      const a=D.coords(selected),b=D.coords(end),rowKeys=[],colKeys=[];
      for(let r=Math.min(a.r,b.r);r<=Math.max(a.r,b.r);r++)rowKeys.push(linkedRows[r-2]?.id||'header:'+r);
      for(let col=Math.min(a.c,b.c);col<=Math.max(a.c,b.c);col++){const day=visibleDays[col-1];colKeys.push(day?D.dayKey(day.date,day.shift):'label');}
      stable={rowKeys,colKeys};
    }
    const signature=JSON.stringify([sheetId,selected,end,hasSelection,stable]);
    if(signature!==lastPresence){lastPresence=signature;live.update(sheetId,selected,end,hasSelection,stable);}
    paintPresence();
  }
  function snapshotSheet(){
    const dim=dimensions(), cells={},widths={},heights={};
    let rows=dim.rows,cols=dim.cols;
    if(sheetId!=='linked'){
      const used=Object.keys(sheet.cells).filter(k=>/^[A-Z]+[1-9]\d*$/.test(k)).map(D.coords);
      for(const merge of sheet.merges||[])used.push(...merge.split(':').map(D.coords));
      rows=Math.max(1,...used.map(p=>p.r+1));cols=Math.max(1,...used.map(p=>p.c+1));
    }
    for(let r=0;r<rows;r++){
      heights[r]=sheet.heights[heightKey(r)]||(sheetId==='linked'&&r===1?36:27);
      for(let col=0;col<cols;col++){
        const k=D.cell(r,col);const entry=sheet.cells[styleKey(k)];
        cells[k]={...D.copy(entry||{}),raw:raw(k),style:cellStyle(k)};
      }
    }
    for(let col=0;col<cols;col++)widths[col]=sheet.widths[widthKey(col)]||(sheetId==='linked'?(col===0?145:autoWidth(col)):80);
    if(sheetId==='linked')cells.A1.raw=c.name||s.object.address||s.object.location;
    return {...D.copy(sheet),name:sheetId==='linked'?'Табель '+c.name:sheet.name,rows,cols,cells,widths,heights,merges:sheetId==='linked'&&cols>1?['A1:'+D.cell(0,cols-1)]:sheet.merges||[]};
  }
  transferTools.querySelector('[data-action=import-excel]').hidden=!s.sheetManager();
  transferTools.querySelector('[data-action=import-excel]').onclick=()=>{
    try{s.require('table','edit');if(!s.sheetManager())throw Error('Импорт доступен прорабу и администратору');
      const el=dialog('Импорт Excel','<p>Каждый лист книги будет добавлен как новый свободный лист. Основной табель сохраняется.</p><input type="file" name="excel" accept=".xlsx" required><p>Сохраняются формулы и оформление. Редактор вычисляет арифметику и SUM; остальные формулы сохраняются для Excel, но здесь показывают ошибку вычисления. Диаграммы, макросы и условное форматирование не импортируются.</p>',async(f)=>{
        const {readExcel}=await import('./file-transfer.mjs');
        const sheets=await readExcel(f.get('excel'));
        if(dirty)await queueCommit();await chain;if(dirty)throw Error('Сначала исправьте значение текущей ячейки');
        s.require('table','edit');if(!s.sheetManager())throw Error('Доступ изменился');
        const importGroup=D.uid();
        const imports=sheets.map(data=>({id:D.uid(),data:{...data,importGroup}}));
        const config=D.copy(s.config());config.sheetAccess||={};
        for(const {id} of imports)config.sheetAccess[id]={roles:{},users:{}};
        await s.saveConfig(config,s.store.get(s.key('config')));
        let count=0;
        try{for(const {id,data} of imports){const k=s.key('sheet:'+id);await s.save(k,data,s.store.get(k),'Импорт Excel: '+data.name,'table');if(!s.store.get(k).data)throw Error('Лист не сохранён');count++;}}
        catch(e){throw Error('Добавлено листов: '+count+' из '+imports.length+'. '+e.message);}
        await load(imports[0].id);
      });el.querySelector('[type=submit]').textContent='Импортировать';
    }catch(e){error(e);}
  };
  transferTools.querySelector('[data-action=export-excel]').onclick=async()=>{try{
    if(dirty)await queueCommit();await chain;if(dirty)throw Error('Сначала исправьте значение текущей ячейки');s.require('table');if(!s.sheetVisible(sheetId))throw Error('Нет доступа к листу');
    const {writeExcel,download}=await import('./file-transfer.mjs');
    const data=snapshotSheet();
    const book=sheet.importGroup?s.store.list(s.key('sheet:')).filter(r=>r.data?.importGroup===sheet.importGroup&&!r.data.deleted):[];
    if(book.some(r=>!s.sheetVisible(r.key.slice(s.key('sheet:').length))))throw Error('Для экспорта всей импортированной книги нужен доступ ко всем её листам');
    const sheets=book.length?book.map(r=>r.key===key()?data:r.data):[data];
    download(await writeExcel(sheets),data.name.replace(/[\\/:*?"<>|]/g,'_')+'.xlsx');
  }catch(e){error(e);}};
  transferTools.querySelector('[data-action=pdf]').onclick=async()=>{try{
    if(dirty)await queueCommit();await chain;if(dirty)throw Error('Сначала исправьте значение текущей ячейки');s.require('table');if(!s.sheetVisible(sheetId))throw Error('Нет доступа к листу');
    const {preparePdf}=await import('./pdf-transfer.mjs');await preparePdf(snapshotSheet());
  }catch(e){error(e);}};
  selectionBox.className = "tn-selection-box";
  selectionBox.setAttribute("aria-hidden", "true");
  scroll.append(selectionBox);
  function outline(keys) {
    const cells = [...table.querySelectorAll("[data-cell]")].filter((td) =>
      keys.has(td.dataset.cell),
    );
    if (!cells.length) {
      selectionBox.hidden = true;
      return;
    }
    selectionBox.hidden = false;
    const parent = scroll.getBoundingClientRect(),
      boxes = cells.map((td) => td.getBoundingClientRect());
    const left = Math.min(...boxes.map((b) => b.left)),
      top = Math.min(...boxes.map((b) => b.top)),
      right = Math.max(...boxes.map((b) => b.right)),
      bottom = Math.max(...boxes.map((b) => b.bottom));
    Object.assign(selectionBox.style, {
      left: left - parent.left + scroll.scrollLeft + "px",
      top: top - parent.top + scroll.scrollTop + "px",
      width: right - left + "px",
      height: bottom - top + "px",
    });
  }
  const key = () => s.key("sheet:" + sheetId);
  const blank = () => ({
    name: "Табель",
    rows: 200,
    cols: 26,
    cells: {},
    widths: {},
    heights: {},
  });
  async function load(id) {
    if (dirty) await queueCommit();
    await chain;
    saveStacks();
    sheetId = id;
    if (!s.sheetVisible(sheetId)) sheetId = visibleIds()[0] || null;
    if (!sheetId) {
      host.innerHTML =
        "<p>Нет доступных листов. Доступ назначает прораб или администратор.</p>";
      return;
    }
    // Server snapshots arrive through the object subscription; open cached sheet immediately.
    base = s.store.get(key());
    sheet = base.data || blank();
    ({ undo, redo } = stacks(sheetId));
    activeStack = true;
    startRow = 0;
    selected = end = "A1";
    referencePick = null;
    hasSelection = false;
    const draft = s.store.get(s.key("draft:grid:" + id)).data;
    if (draft) {
      selected = end = draft.cell;
    }
    draw();
    tabs();
    if (draft) {
      edit.value = draft.raw;
      dirty = true;
      renderFormulaSyntax();
    }
  }
  function visibleIds() {
    return [
      "linked",
      ...s.store
        .list(s.key("sheet:"))
        .filter(
          (r) => r.data && !r.data.deleted && r.key !== s.key("sheet:linked"),
        )
        .map((r) => r.key.slice(s.key("sheet:").length)),
    ].filter(s.sheetVisible);
  }
  function tabs() {
    host.querySelector(".tn-sheets").innerHTML =
      (s.sheetVisible("linked")
        ? btn(
            "Табель",
            "sheet",
            `data-id="linked" aria-pressed="${sheetId === "linked"}"`,
          )
        : "") +
      s.store
        .list(s.key("sheet:"))
        .filter(
          (r) =>
            r.data &&
            !r.data.deleted &&
            r.key !== s.key("sheet:linked") &&
            s.sheetVisible(r.key.slice(s.key("sheet:").length)),
        )
        .map((r) =>
          btn(
            esc(r.data.name),
            "sheet",
            `data-id="${esc(r.key.slice(s.key("sheet:").length))}" aria-pressed="${sheetId === r.key.slice(s.key("sheet:").length)}"`,
          ),
        )
        .join("") +
      (sheetId !== "linked" && s.sheetManager()
        ? btn(
            "⋯ Лист",
            "sheet-options",
            'aria-label="Переименовать или удалить лист"',
          )
        : "") +
      (s.sheetManager()
        ? btn("＋ Лист", "new-sheet") + btn("Доступ к листу", "sheet-access")
        : "");
    host
      .querySelector("[data-action=new-sheet]")
      ?.addEventListener("click", newSheet);
    host
      .querySelector("[data-action=sheet-access]")
      ?.addEventListener("click", sheetAccess);
    host
      .querySelectorAll("[data-action=sheet]")
      .forEach((b) => (b.onclick = () => load(b.dataset.id).catch(error)));

    host
      .querySelector("[data-action=sheet-options]")
      ?.addEventListener("click", sheetOptions);
  }
  function dimensions() {
    if (sheetId === "linked") {
      const config = s.config(),
        last =
          config.end && config.end <= D.today()
            ? config.end
            : allDays.at(-1)?.date || config.start;
      visibleDays = D.days(config.start, last)
        .flatMap((date) => {
          const existing = allDays.filter((d) => d.date === date);
          return existing.length
            ? existing
            : s.store
                  .list(s.key("day:" + date + ":"))
                  .some((r) => r.data?.deleted)
              ? []
              : [
                  {
                    date,
                    shift: "day",
                    equipment: [],
                    people: [],
                    values: {},
                    placeholder: true,
                  },
                ];
        })
        .filter((d) => period !== "week" || D.monday(d.date) === week);
      linkedRows = D.rows(config, allDays).filter(
        (row) => !(sheet.hiddenRows || []).includes(row.id),
      );
      return { rows: linkedRows.length + 2, cols: visibleDays.length + 1 };
    }
    return sheet;
  }
  function linkedAt(k) {
    const p = D.coords(k);
    return { row: linkedRows[p.r - 2], day: visibleDays[p.c - 1], p };
  }
  function styleKey(k) {
    if (sheetId !== "linked") return k;
    const { row, day, p } = linkedAt(k);
    return (
      (row?.id || "header:" + p.r) +
      "|" +
      (day ? D.dayKey(day.date, day.shift) : "label")
    );
  }
  function raw(k) {
    if (sheetId !== "linked") return sheet.cells[k]?.raw ?? "";
    const stored = sheet.cells[styleKey(k)]?.raw;
    if (String(stored || "").startsWith("=")) return stored;
    const { row, day, p } = linkedAt(k);
    if (p.r === 0) return p.c === 0 ? "Адрес" : p.c === 1 ? c.name : "";
    if (p.r === 1)
      return p.c === 0
        ? "Дата"
        : D.display(day.date).slice(0, 5) +
            "\n" +
            (day.shift === "night" ? "Ночь" : "День");
    if (!row) return "";
    if (p.c === 0) return row.name;
    if (row.section) return "";
    return D.fmt(D.value(row, day));
  }
  function formulaCells(candidate = sheet) {
    if (sheetId !== "linked") return candidate.cells;
    const dim = dimensions(),
      cells = {};
    for (let r = 0; r < dim.rows; r++)
      for (let col = 0; col < dim.cols; col++) {
        const k = D.cell(r, col),
          overlay = candidate.cells[styleKey(k)]?.raw;
        cells[k] = { raw: overlay ?? raw(k) };
      }
    return cells;
  }
  function computed(k, cells = formulaCells()) {
    return D.formula(cells, k, dimensions());
  }
  function selectionTotal() {
    try {
      const cells = formulaCells(),
        values = D.range(selected, end)
          .map((k) => computed(k, cells))
          .filter((v) => typeof v === "number" && Number.isFinite(v));
      host.querySelector("[data-selection-total]").textContent =
        "Сумма: " +
        D.fmt(values.reduce((a, b) => a + b, 0)) +
        " · чисел: " +
        values.length;
    } catch {}
  }
  const formulaMode = () => dirty && edit.value.startsWith("=");
  function expectsReference() {
    const prefix = edit.value.slice(0, edit.selectionStart ?? edit.value.length);
    return formulaMode() && /(?:^=|[+*/(:;,−-]|[A-ZА-ЯЁ]+)\s*$/i.test(prefix);
  }
  function referenceParts() {
    const pos = edit.selectionStart ?? edit.value.length,
      to = edit.selectionEnd ?? pos;
    let prefix = edit.value.slice(0, pos), suffix = edit.value.slice(to);
    if (/[A-ZА-ЯЁ]+\s*$/i.test(prefix)) prefix += "(";
    const text = prefix + suffix,
      balance = (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
    if (/\(\s*$/.test(prefix) && balance > 0) suffix = ")" + suffix;
    return { prefix, suffix };
  }
  function paintReference() {
    if (!referencePick) return;
    const { a, b } = referencePick, keys = new Set(D.range(a, b));
    table.querySelectorAll("[data-cell]").forEach(td => {
      td.classList.toggle("tn-formula-ref", keys.has(td.dataset.cell));
      if (!s.gridDragging) td.querySelector(".tn-fill")?.remove();
    });
    if (!s.gridDragging) {
      const td = table.querySelector(`[data-cell="${b}"]`);
      if (td) {
        const handle = document.createElement("span");
        handle.className = "tn-fill tn-reference-handle";
        handle.setAttribute("aria-label", "Потянуть для диапазона формулы");
        td.append(handle);
      }
    }
    outline(keys);
  }
  function pickReference(a, b, parts) {
    const ref = a + (a === b ? "" : ":" + b);
    edit.value = parts.prefix + ref + parts.suffix;
    edit.setSelectionRange(parts.prefix.length + ref.length, parts.prefix.length + ref.length);
    referencePick = { a, b, parts };
    pickingReference = true;
    edit.dispatchEvent(new Event("input"));
    pickingReference = false;
    paintReference();
  }
  // The native text input remains active for cursor, selection, accessibility
  // and Android IME. A visually aligned mirror adds token coloring without
  // altering the typed formula or changing its scroll position.
  function renderFormulaSyntax() {
    const source=edit.value||"",
      active=source.startsWith("="),
      wrapper=edit.closest(".tn-formula-editor");
    wrapper.classList.toggle("tn-syntax-active",active);
    formulaMirror.innerHTML=active ? syntaxParts(source).map(token=>
      `<span class="tn-syntax-${token.kind}"${token.color?` style="color:${token.color}"`:""}>${esc(token.text)}</span>`
    ).join("") : "";
    formulaMirror.scrollLeft=edit.scrollLeft;
    const colorByCell=new Map();
    if(active)for(const group of formulaReferences(source)){
      try {
        const refs=D.range(group.from,group.to);
        for(const key of refs.slice(0,1000))colorByCell.set(key,group.color);
      }catch{}
    }
    table.querySelectorAll("[data-cell]").forEach(td=>{
      const color=colorByCell.get(td.dataset.cell);
      td.classList.toggle("tn-syntax-reference",!!color);
      if(color)td.style.setProperty("--tn-syntax-reference-color",color);
      else td.style.removeProperty("--tn-syntax-reference-color");
    });
  }
  edit.addEventListener("scroll",()=>{formulaMirror.scrollLeft=edit.scrollLeft;});
  host.querySelector('[data-action="formula-help"]').onclick=()=>{
    openFormulaGuide((example)=>{
      edit.value=example;
      edit.focus({preventScroll:true});
      edit.setSelectionRange(edit.value.length,edit.value.length);
      edit.dispatchEvent(new Event("input",{bubbles:true}));
    });
  };
  // Offer only functions supported by the evaluator; picking references is function-independent.
  const functions = FORMULAS.map(f=>({
    name:f.name,aliases:f.aliases,
    label:f.name+"( · "+f.description
  }));
  function suggestFormula() {
    const pos = edit.selectionStart ?? edit.value.length,
      token = edit.value.slice(0, pos).match(/[A-ZА-ЯЁ]+$/i),
      query = token?.[0].toUpperCase();
    const matches = formulaMode() && query
      ? functions.filter(f => f.aliases.some(a => a.startsWith(query))).slice(0,8) : [];
    suggestions.hidden = !matches.length;
    suggestions.innerHTML = matches.map(f => btn(esc(f.label), "suggest-formula", `data-function="${f.name}"`)).join("");
    suggestions.querySelectorAll("button").forEach(b => {
      b.onpointerdown = e => e.preventDefault();
      b.onclick = () => {
        edit.setRangeText(b.dataset.function + "(", pos - token[0].length, pos, "end");
        edit.dispatchEvent(new Event("input"));
        edit.focus({ preventScroll: true });
      };
    });
    viewport();
  }
  function selectCell(k) {
    if (dirty) void queueCommit();
    selected = end = k;
    hasSelection = true;
    mark();
    edit.value = raw(k);
  }
  function cellStyle(k) {
    const { row, p } = linkedAt(k),
      defaultBg =
        sheetId === "linked"
          ? p.r === 0
            ? "#ff9900"
            : p.r === 1
              ? "#ffff00"
              : row?.color || "#fff"
          : "#fff";
    return {
      background: defaultBg,
      color: sheetId === "linked" && row?.section ? "#fff" : "#111",
      ...sheet.cells[styleKey(k)]?.style,
    };
  }
  function css(style) {
    return Object.entries(style)
      .filter(([k]) =>
        [
          "background",
          "color",
          "fontWeight",
          "fontStyle",
          "fontSize",
          "textAlign",
          "whiteSpace",
          "border",
          "borderTop",
          "borderBottom",
          "borderLeft",
          "borderRight",
        ].includes(k),
      )
      .map(
        ([k, v]) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + ":" + v,
      )
      .join(";");
  }
  function draw() {
    saveStacks();
    for (const [action, stack] of [
      ["undo", undo],
      ["redo", redo],
    ])
      host.querySelector(`[data-action=${action}]`).disabled = !stack.length;
    const previousScroll = { top: scroll.scrollTop, left: scroll.scrollLeft };
    host.classList.toggle("tn-simple-table", simple());
    dock.hidden = simple();
    for (const action of ["format", "menu"])
      host.querySelector(`[data-action=${action}]`).hidden = simple();
    host.querySelector(".tn-cell-tools").hidden = simple();
    symbols.hidden = simple();
    for(const action of ['tool-merge','tool-unmerge'])host.querySelector(`[data-action=${action}]`).hidden=sheetId==='linked';
    if (disposed) return;
    const dim = dimensions(),axes=!simple();table.classList.toggle('tn-grid-axis',axes);
    host.querySelector("[data-period]").hidden = sheetId !== "linked";
    host.querySelector("[data-week]").hidden =
      sheetId !== "linked" || period !== "week";
    const merged = new Map();
    if(sheetId!=='linked')for(const merge of sheet.merges||[]){
      const [from,to]=merge.split(':'),a=D.coords(from),b=D.coords(to||from);
      for(let r=a.r;r<=b.r;r++)for(let col=a.c;col<=b.c;col++)merged.set(D.cell(r,col),{master:from,rows:b.r-a.r+1,cols:b.c-a.c+1});
    }
    const max =
        sheetId === "linked" || merged.size ? dim.rows : Math.min(dim.rows, startRow + 80),
      first = sheetId === "linked" || merged.size ? 0 : startRow;
    const memo = new Map(),
      displayCells = formulaCells();
    table.style.width =
      (axes ? 32 : 0) +
      Array.from(
        { length: dim.cols },
        (_, col) =>
          (sheet.widths[widthKey(col)] ||
            (sheetId === "linked" ? (col === 0 ? 145 : autoWidth(col)) : 80)) *
          scale,
      ).reduce((a, b) => a + b, 0) +
      "px";
    table.style.minWidth = "0";
    table.style.fontSize = 12 * scale + "px";
    table.innerHTML =
      "<colgroup>" +
      (axes ? '<col style="width:32px">' : "") +
      Array.from(
        { length: dim.cols },
        (_, col) =>
          `<col style="width:${(sheet.widths[widthKey(col)] || (sheetId === "linked" ? (col === 0 ? 145 : autoWidth(col)) : 80)) * scale}px">`,
      ).join("") +
      "</colgroup>" +
      (!axes
        ? ""
        : '<thead><tr><th class="tn-corner"></th>' +
          Array.from(
            { length: dim.cols },
            (_, col) =>
              `<th data-column="${col}">${D.colName(col)}<span class="tn-resize-col" data-resize-col="${col}"></span></th>`,
          ).join("") +
          "</tr></thead>") +
      "<tbody>" +
      (first
        ? `<tr><td colspan="${dim.cols + 1}">${btn("↑ Предыдущие 60 строк", "prev-rows")}</td></tr>`
        : "") +
      Array.from({ length: max - first }, (_, i) => {
        const r = i + first,
          height =
            (sheet.heights[heightKey(r)] ||
              (sheetId === "linked" && r === 1 ? 36 : 27)) * scale;
        if (sheetId === "linked" && r === 0)
          return `<tr class="tn-address">${axes?'<th data-row="0">1<span class="tn-resize-row" data-resize-row="0"></span></th>':''}<td data-cell="A1" colspan="${dim.cols}" style="background:#ff9900"><div>${esc(c.name || s.object.address || s.object.location)}</div></td></tr>`;
        return (
          `<tr style="height:${height}px">` +
          (!axes
            ? ""
            : `<th data-row="${r}">${r + 1}<span class="tn-resize-row" data-resize-row="${r}"></span></th>`) +
          Array.from({ length: dim.cols }, (_, col) => {
            const k = D.cell(r, col);
            const merge=merged.get(k);
            if(merge&&merge.master!==k)return '';
            let v = D.formula(displayCells, k, dim, new Set(), memo);
            const nf = sheet.cells[styleKey(k)]?.numberFormat;
            if (nf && v !== "" && !isNaN(Number(String(v).replace(",", ".")))) {
              const n = Number(String(v).replace(",", "."));
              v =
                nf === "percent"
                  ? D.fmt(n * 100) + "%"
                  : n.toLocaleString("ru-RU", {
                      minimumFractionDigits: Number(nf),
                      maximumFractionDigits: Number(nf),
                    });
            }
            const dateColumn = sheetId === "linked" && col > 0 ? visibleDays[col - 1] : null;
            const calendarHighlight = dateColumn && D.isRestDay(dateColumn)
              ? "tn-weekend" + (dateColumn.dayOff === true ? " tn-explicit-day-off" : "") +
                (r === 1 ? " tn-weekend-date" : "")
              : "";
            // Rest-day shading is visual only: no extra text in the date header.
            return `<td ${merge?`rowspan="${merge.rows}" colspan="${merge.cols}"`:''} class="${calendarHighlight}" title="${sheetId === "linked" && r === 1 && col > 0 ? D.display(visibleDays[col - 1].date) : ""}" data-cell="${k}" tabindex="-1" style="${esc(css(cellStyle(k)))}">${esc(v)}${sheetId === "linked" && col === 0 && r > 1 && linkedRows[r - 2]?.contractor !== undefined && linkedRows[r - 2]?.contractor !== null ? `<small class="tn-grid-contractor">${esc(linkedRows[r - 2].contractorName)}</small>` : ""}</td>`;
          }).join("") +
          "</tr>"
        );
      }).join("") +
      (max < dim.rows
        ? `<tr><td colspan="${dim.cols + 1}">${btn("↓ Следующие 60 строк", "next-rows")}</td></tr>`
        : "") +
      "</tbody>";
    if (sheetId === "linked") table.classList.add("tn-linked");
    else table.classList.remove("tn-linked");
    if (sheetId === "linked") {
      table
        .querySelectorAll("tbody tr:nth-child(2)>*")
        .forEach(
          (td) =>
            (td.style.top =
              (table.querySelector(".tn-address")?.getBoundingClientRect()
                .height || 27 * scale) + "px"),
        );
    }
    host.querySelector(".tn-object-totals")?.remove();
    if (sheetId === "linked") {
      const panel = document.createElement("details");
      panel.className = "tn-object-totals";
      panel.innerHTML =
        "<summary>Итоги работ и материалов за весь объект</summary>" +
        D.totals(s.config(), allDays)
          .map(
            (x) =>
              `<p>${esc(x.name)}: <b>${D.fmt(x.quantity)}</b> ${esc(x.unit)}</p>`,
          )
          .join("");
      host.querySelector(".tn-sheets").before(panel);
    }
    mark();
    scroll.scrollTop = previousScroll.top;
    scroll.scrollLeft = previousScroll.left;
    host
      .querySelector("[data-action=next-rows]")
      ?.addEventListener("click", () => {
        startRow += 60;
        draw();
        scroll.scrollTop = 0;
      });
    host
      .querySelector("[data-action=prev-rows]")
      ?.addEventListener("click", () => {
        startRow = Math.max(0, startRow - 60);
        draw();
        scroll.scrollTop = 0;
      });
  }
  function autoWidth(col) {
    const day = visibleDays[col - 1];
    let length = 0;
    for (const row of linkedRows) {
      if (!row.section)
        length = Math.max(length, D.fmt(D.value(row, day)).length);
    }
    return Math.max(48, Math.min(150, length * 7 + 12));
  }
  function widthKey(col) {
    return sheetId === "linked"
      ? col === 0
        ? "label"
        : D.dayKey(visibleDays[col - 1].date, visibleDays[col - 1].shift)
      : col;
  }
  function heightKey(row) {
    return sheetId === "linked"
      ? linkedRows[row - 2]?.id || "header:" + row
      : row;
  }
  function mark() {
    let keys;
    try {
      keys = new Set(D.range(selected, end));
    } catch {
      return;
    }
    table.querySelectorAll("[data-cell]").forEach((td) => {
      td.classList.toggle("tn-selected", keys.has(td.dataset.cell));
      td.querySelector(".tn-fill")?.remove();
    });
    const td = table.querySelector(`[data-cell="${end}"]`);
    if (td && hasSelection) {
      const handle = document.createElement("span");
      handle.className = "tn-fill";
      handle.setAttribute("aria-label", "Потянуть для выделения диапазона");
      td.append(handle);
    }
    rangeInput.value = selected === end ? selected : selected + ":" + end;
    if (!dirty) edit.value = raw(selected);
    outline(keys);
    selectionTotal();
    paintReference();
    renderFormulaSyntax();
    announceSelection();
    numericActions.hidden=!simple()||!hasSelection||selected===end;
    if(!numericActions.hidden){
      const valid=D.range(selected,end).every(k=>{const {row,day,p}=linkedAt(k);return row&&!row.section&&p.c>0&&day&&day.date<=D.today();});
      let writable=true;try{s.require('table','edit');}catch{writable=false;}
      numericFill.disabled=!valid||!writable||raw(selected)==='';
      numericActions.querySelector('[data-numeric-range]').textContent=rangeInput.value+' · '+D.range(selected,end).length+' ячеек'+(raw(selected)===''?' · сначала введите исходное число':'');
    }
  }
  async function persist(next, label) {
    s.require("table", "edit");
    const before = D.copy(sheet);
    await s.save(key(), next, base, label, "table");
    undo.push({ sheetBefore: before, sheetAfter: D.copy(next) });
    if (undo.length > 30) undo.shift();
    redo = [];
    base = s.store.get(key());
    sheet = D.copy(next);
    draw();
  }
  function queue(fn) {
    chain = chain.then(fn).catch(error);
    return chain;
  }
  async function linkedWrite(updates, label) {
    const next = D.copy(sheet);
    for (const [k, value] of updates) {
      const id = styleKey(k);
      if (String(value).startsWith("="))
        next.cells[id] = { ...next.cells[id], raw: String(value) };
      else if (next.cells[id]) delete next.cells[id].raw;
    }
    const cells = formulaCells(next);
    for (const [k, value] of updates) cells[k] = { raw: String(value ?? "") };
    const changed = new Map(updates);
    for (const k of Object.keys(cells))
      if (String(cells[k].raw).startsWith("=")) {
        const value = D.formula(cells, k, dimensions());
        if (typeof value !== "number") throw Error(value);
        changed.set(k, value);
      }
    await linkedFacts([...changed], label);
    if (JSON.stringify(next) !== JSON.stringify(sheet))
      await persist(next, "Формулы диапазона");
  }
  async function linkedFacts(updates, label) {
    const changes = new Map();
    for (const [k, rawValue] of updates) {
      const { row, day, p } = linkedAt(k);
      if (!row || !day || row.section || p.c === 0)
        throw Error(
          "Диапазон включает заголовок. Выберите только ячейки факта.",
        );
      const key = s.key(D.dayKey(day.date, day.shift));
      let item = changes.get(key);
      if (!item) {
        const before = s.store.get(key);
        item = {
          key,
          before,
          data: before.data
            ? D.copy(before.data)
            : D.createDay(s.config(), day.date, day.shift),
        };
        changes.set(key, item);
      }
      if (
        row.kind !== "value" &&
        !item.data[row.kind].some((e) => e.id === row.entity)
      ) {
        const config = s.config(),
          source =
            config[row.kind].find((e) => e.id === row.entity) ||
            allDays
              .flatMap((d) => d[row.kind])
              .find((e) => e.id === row.entity);
        if (!source) throw Error("Запись не найдена в справочнике");
        const accepted = await confirmAdd(row.name, day.date);
        if (!accepted)
          throw Error("Добавление в состав отменено. Часы не сохранены.");
        item.data[row.kind].push({
          ...D.copy(source),
          hours: null,
          crewHours: null,
          pumpHours: null,
        });
      }
      if (row.field === "pumpHours") {
        const machine = item.data.equipment.find((e) => e.id === row.entity);
        if (!machine.pump) {
          if (!(await confirmEnable(row.name, day.date)))
            throw Error("Включение помпы отменено. Значение не сохранено.");
          machine.pump = true;
        }
      }
      D.setValue(row, item.data, rawValue);
    }
    const applied = [];
    try {
      for (const item of changes.values()) {
        await s.save(
          item.key,
          item.data,
          item.before,
          label +
            " · " +
            D.display(item.data.date) +
            " · " +
            updates
              .map(([k]) => linkedAt(k).row?.name)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(", "),
          "table",
        );
        applied.push(item);
        const existing = allDays.find(
          (d) => d.date === item.data.date && d.shift === item.data.shift,
        );
        if (existing) Object.assign(existing, item.data);
        else allDays.push(item.data);
      }
      allDays.sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift),
      );
    } finally {
      if (applied.length) {
        undo.push({ fact: applied });
        if (undo.length > 30) undo.shift();
        redo = [];
        draw();
      }
    }
  }
  async function apply(target, rawValue) {
    if (sheetId === "linked") {
      await linkedWrite([[target, rawValue]], "Ввод из таблицы");
    } else {
      const next = D.copy(sheet);
      next.cells[target] = { ...next.cells[target], raw: rawValue };
      await persist(next, "Ячейка " + target);
    }
  }
  // Capture the cell and its input before waiting for storage. New keystrokes belong
  // to the new selection, even when a previous IndexedDB/Firebase save is pending.
  function queueCommit() {
    const target = selected, rawValue = edit.value;
    dirty = false;
    referencePick = null;
    suggestions.hidden = true;
    table.querySelectorAll(".tn-formula-ref").forEach(td => td.classList.remove("tn-formula-ref"));
    return queue(async () => {
      try { await apply(target, rawValue); }
      catch (e) {
        if (selected === target && edit.value === rawValue) dirty = true;
        throw e;
      }
      await s.store.serialize(async () => {
        const draftKey = s.key("draft:grid:" + sheetId),
          draft = s.store.state.records[draftKey]?.data;
        if (draft?.cell === target && draft.raw === rawValue) delete s.store.state.records[draftKey];
        await s.store.persist();
      });
    });
  }
  edit.oninput = () => {
    dirty = true;
    if (!pickingReference) {
      referencePick = null;
      table.querySelectorAll(".tn-formula-ref").forEach(td => td.classList.remove("tn-formula-ref"));
      mark();
    }
    suggestFormula();
    renderFormulaSyntax();
    const data = { cell: selected, raw: edit.value },
      draftKey = s.key("draft:grid:" + sheetId);
    queue(() =>
      s.store.serialize(async () => {
        s.store.state.records[draftKey] = { revision: 0, data };
        await s.store.persist();
      }),
    );
  };
  host.querySelector("[data-action=apply]").onclick = () => queueCommit();
  edit.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      queueCommit();
    }
    if (e.key === "Escape") {
      dirty = false;
      referencePick = null;
      table.querySelectorAll(".tn-formula-ref").forEach(td => td.classList.remove("tn-formula-ref"));
      suggestions.hidden = true;
      edit.value = raw(selected);
      mark();
      edit.blur();
    }
  };
  function openHours(k) {
    if (document.querySelector("dialog.tn-hours-dialog[open]")) return;
    const { row, day, p } = linkedAt(k);
    if (!row || !day || row.section || p.c === 0) return;
    try {
      s.require("table", "edit");
    } catch (e) {
      error(e);
      return;
    }
    selected = end = k;
    mark();
    return numberInput(
      row.name + " · " + D.display(day.date),
      raw(k),
      (value) => linkedWrite([[k, value]], "Цифровой ввод из таблицы"),
      { presets: row.kind !== "value" },
    );
  }
  function activateCell(k) {
    if (
      hasSelection &&
      !dirty &&
      (!simple() || selected !== end) &&
      D.range(selected, end).includes(k)
    ) {
      menu();
      return;
    }
    if(simple()){
      const repeated=hasSelection&&!dirty&&selected===end&&selected===k;
      selectCell(k);
      if(repeated)return openHours(k);
      return;
    }
    if (!simple()) {
      try { s.require("table", "edit"); } catch { selectCell(k); return; }
      // Focus during the user gesture: Android will not open the keyboard after an awaited save.
      edit.readOnly = false;
      edit.focus({ preventScroll: true });
    }
    selectCell(k);
  }
  table.onmousedown = (e) => {
    if (e.target.closest("[data-cell]")) e.preventDefault();
  };
  table.onclick = (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (e.target.closest("[class*=tn-resize]") || e.target.closest(".tn-fill"))
      return;
    const td = e.target.closest("[data-cell]");
    if (td) {
      const k = td.dataset.cell;
      if (expectsReference()) {
        pickReference(k, k, referenceParts());
        return;
      }
      activateCell(k);
      return;
    }
    const col = e.target.closest("[data-column]"),
      row = e.target.closest("[data-row]"),
      dim = dimensions();
    if(col||row){if(dirty)void queueCommit();hasSelection=true;referencePick=null;edit.blur();}
    if (col) {
      selected = D.cell(0, Number(col.dataset.column));
      end = D.cell(dim.rows - 1, Number(col.dataset.column));
    }
    if (row) {
      selected = D.cell(Number(row.dataset.row), 0);
      end = D.cell(Number(row.dataset.row), dim.cols - 1);
    }
    mark();
  };
  table.oncontextmenu = (e) => {
    e.preventDefault();
    const td = e.target.closest("[data-cell]");
    if (simple() && selected === end && td) {
      openHours(td.dataset.cell);
      return;
    }
    if (td && !D.range(selected, end).includes(td.dataset.cell)) {
      selected = end = td.dataset.cell;
      mark();
    }
    menu();
  };
  table.addEventListener("pointerdown", (e) => {
    suppressClick = false;
    const target = e.target.closest("[data-resize-col],[data-resize-row]");
    if (target) {
      e.preventDefault();
      const isCol = target.dataset.resizeCol != null,
        index = Number(isCol ? target.dataset.resizeCol : target.dataset.resizeRow),
        initial = isCol ? e.clientX : e.clientY,
        size = Math.round(isCol
          ? (sheet.widths[widthKey(index)] ?? (sheetId === "linked" ? (index === 0 ? 145 : autoWidth(index)) : 80))
          : (sheet.heights[heightKey(index)] ?? (sheetId === "linked" && index === 1 ? 36 : 27))),
        min = isCol ? 40 : 20,
        max = isCol ? 600 : 300,
        boundary = target.parentElement.getBoundingClientRect(),
        viewport = scroll.getBoundingClientRect();
      const guide = document.createElement("div");
      guide.className = "tn-resize-guide " + (isCol ? "tn-resize-guide-col" : "tn-resize-guide-row");
      guide.setAttribute("aria-hidden", "true");
      const sizeLabel = document.createElement("span");
      sizeLabel.className = "tn-resize-value";
      guide.append(sizeLabel);
      scroll.append(guide);
      const preview = (value) => {
        const offset = (value - size) * scale;
        const edge = (isCol ? boundary.right - viewport.left + scroll.scrollLeft
                            : boundary.bottom - viewport.top + scroll.scrollTop) + offset;
        if (isCol) {
          guide.style.left = edge + "px";
          guide.style.top = scroll.scrollTop + "px";
          guide.style.height = scroll.clientHeight + "px";
        } else {
          guide.style.top = edge + "px";
          guide.style.left = scroll.scrollLeft + "px";
          guide.style.width = scroll.clientWidth + "px";
        }
        sizeLabel.textContent = value + " px";
      };
      const nextSize = (event) => Math.round(Math.max(min, Math.min(max,
        size + ((isCol ? event.clientX : event.clientY) - initial) / scale)));
      preview(size);
      target.setPointerCapture(e.pointerId);
      const move = (event) => {
        const value = nextSize(event);
        target.dataset.size = String(value);
        preview(value);
      };
      const cleanup = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", cancel);
        guide.remove();
        delete target.dataset.size;
      };
      const up = (event) => {
        if(Math.abs((isCol?event.clientX:event.clientY)-initial)<3){
          cleanup();if(dirty)void queueCommit();const dim=dimensions();hasSelection=true;suppressClick=true;edit.blur();
          selected=isCol?D.cell(0,index):D.cell(index,0);end=isCol?D.cell(dim.rows-1,index):D.cell(index,dim.cols-1);mark();return;
        }
        move(event);
        const value = Number(target.dataset.size);
        cleanup();
        const next = D.copy(sheet);
        next[isCol ? "widths" : "heights"][isCol ? widthKey(index) : heightKey(index)] = value;
        queue(() => persist(next, "Размер " + (isCol ? "столбца" : "строки")));
      };
      const cancel = () => cleanup();
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", cancel);
      return;
    }
    if (e.target.closest(".tn-fill")) {
      e.preventDefault();
      suppressClick = false;
      const parts = referencePick?.parts,
        seed = referencePick?.a || selected,
        previousEnd = referencePick?.b || end,
        handle = e.target.closest(".tn-fill");
      s.gridDragging = true;
      handle.setPointerCapture(e.pointerId);
      const preview = document.createElement("output");
      preview.className = "tn-fill-preview";
      host.querySelector(".tn-grid-tools").append(preview);
      const move = (event) => {
        const td = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest("[data-cell]");
        if (!td || !table.contains(td)) return;
        try {
          const keys = new Set(D.range(seed, td.dataset.cell));
          if (parts) pickReference(seed, td.dataset.cell, parts);
          else end = td.dataset.cell;
          table
            .querySelectorAll("[data-cell]")
            .forEach((cell) =>
              cell.classList.toggle(
                "tn-fill-target",
                keys.has(cell.dataset.cell),
              ),
            );
          outline(keys);
          preview.textContent = seed + ":" + td.dataset.cell + " · ячеек: " + keys.size;
        } catch {}
      };
      const cleanup = () => {
        s.gridDragging = false;
        preview.remove();
        table
          .querySelectorAll(".tn-fill-target")
          .forEach((td) => td.classList.remove("tn-fill-target"));
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", cancel);
      };
      const finish = (event) => {
        move(event);
        cleanup();
        if (parts) paintReference();
        else { hasSelection = true; mark(); }
        suppressClick = true;
      };
      const cancel = () => {
        cleanup();
        if (parts) pickReference(seed, previousEnd, parts);
        else { end = previousEnd; mark(); }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", cancel);
      return;
    }
    const td = e.target.closest("[data-cell]");
    if (td && e.pointerType !== "mouse") {
      const anchor = td.dataset.cell,
        x = e.clientX,
        y = e.clientY;
      let moved = false;
      const move = (event) => {
        if (Math.hypot(event.clientX - x, event.clientY - y) > 6) moved = true;
      };
      const cleanup = () => {
        table.removeEventListener("pointermove", move);
        table.removeEventListener("pointerup", up);
        table.removeEventListener("pointercancel", cleanup);
      };
      const up = () => {
        cleanup();
        suppressClick = true;
        if (!moved) {
          // The compatibility click can otherwise land on a newly opened dialog.
          // Consume only this touch's click, never a subsequent pointer gesture.
          const pointerId=e.pointerId;
          const block=event=>{if(event.pointerId===pointerId){event.preventDefault();event.stopImmediatePropagation();document.removeEventListener('click',block,true);}};
          document.addEventListener('click',block,true);setTimeout(()=>document.removeEventListener('click',block,true),500);
          if (expectsReference()) pickReference(anchor, anchor, referenceParts());
          else activateCell(anchor);
        }
      };
      table.addEventListener("pointermove", move);
      table.addEventListener("pointerup", up);
      table.addEventListener("pointercancel", cleanup);
      return;
    }

  });
  rangeInput.onchange = async () => {
    try {
      const [a, b = a] = rangeInput.value.toUpperCase().split(":");
      const dim = dimensions();
      for (const k of [a, b]) {
        const p = D.coords(k);
        if (p.r >= dim.rows || p.c >= dim.cols)
          throw Error("Диапазон вне листа");
      }
      D.range(a, b);
      if (dirty) await queueCommit();
      selected = a;
      end = b;
      hasSelection = true;
      mark();
    } catch (e) {
      error(e);
    }
  };
  async function fill(a, b) {
    if (sheetId === "linked")
      return linkedWrite(
        D.range(a, b).map((k) => [k, raw(a)]),
        "Автозаполнение факта",
      );
    const next = D.copy(sheet),
      p = D.coords(a),
      seed = sheet.cells[a] || { raw: "" };
    for (const k of D.range(a, b)) {
      const q = D.coords(k);
      next.cells[k] = {
        ...D.copy(seed),
        raw: D.translate(seed.raw, q.r - p.r, q.c - p.c),
      };
    }
    await persist(next, "Автозаполнение " + a + ":" + b);
  }
  async function mergeSelection(split=false){
    s.require('table','edit');if(sheetId==='linked')throw Error('Объединение доступно на свободных листах. Учёт часов сохраняется по дням.');
    if(dirty)await queueCommit();
    if(split){await persist(unmergeCells(sheet,selected,end),'Разъединение ячеек');return;}
    const merged=mergeCells(sheet,selected,end);selected=merged.first;end=merged.last;await persist(merged.sheet,'Объединение ячеек');
  }
  function format() {
    const st = cellStyle(selected),
      p = D.coords(selected);
    const el = dialog(
      "Формат диапазона " + rangeInput.value,
      `<div class="tn-format-grid">${field("Фон", colorField("background", st.background, "Заливка"))}${field("Текст", colorField("color", st.color, "Цвет текста"))}${field("Шрифт, px", input("fontSize", parseInt(st.fontSize) || 12, 'type="number" min="8" max="48"'))}${field("Ширина столбцов", input("width", Math.round(sheet.widths[widthKey(p.c)] ?? 80), 'type="number" min="40" max="600" step="1"'))}${field("Высота строк", input("height", Math.round(sheet.heights[heightKey(p.r)] ?? 27), 'type="number" min="20" max="300" step="1"'))}${field("Выравнивание", '<select name="textAlign"><option>left</option><option>center</option><option>right</option></select>')}</div>${field("Числовой формат", '<select name="numberFormat"><option value="">Автоматически</option><option value="0">Целое</option><option value="2">Два знака</option><option value="percent">Проценты</option></select>')}<label><input type="checkbox" name="bold" ${st.fontWeight === "bold" ? "checked" : ""}>Жирный</label><label><input type="checkbox" name="italic" ${st.fontStyle === "italic" ? "checked" : ""}>Курсив</label><label><input type="checkbox" name="wrap" ${st.whiteSpace === "normal" ? "checked" : ""}>Перенос текста</label><label><input type="checkbox" name="border" ${st.border ? "checked" : ""}>Чёткие границы</label>`,
      async (f) => {
        const next = D.copy(sheet);
        for (const k of D.range(selected, end)) {
          const p = D.coords(k),
            id = styleKey(k);
          next.cells[id] = {
            ...next.cells[id],
            numberFormat: f.get("numberFormat"),
            style: {
              background: f.get("background"),
              color: f.get("color"),
              fontSize: Number(f.get("fontSize")) + "px",
              textAlign: f.get("textAlign"),
              fontWeight: f.has("bold") ? "bold" : "normal",
              fontStyle: f.has("italic") ? "italic" : "normal",
              whiteSpace: f.has("wrap") ? "normal" : "nowrap",
              border: f.has("border") ? "1px solid #111" : "1px solid #c6ccd0",
            },
          };
          next.widths[widthKey(p.c)] = Math.min(
            600,
            Math.max(40, Math.round(Number(f.get("width")))),
          );
          next.heights[heightKey(p.r)] = Math.min(
            300,
            Math.max(20, Math.round(Number(f.get("height")))),
          );
        }
        await persist(next, "Оформление диапазона");
      },
    );
    bindColorFields(el);
  }
  async function copySelection(cut = false) {
    const a = D.coords(selected),
      b = D.coords(end),
      lines = [];
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
      const row = [];
      for (let col = Math.min(a.c, b.c); col <= Math.max(a.c, b.c); col++)
        row.push(raw(D.cell(r, col)));
      lines.push(row.join("\t"));
    }
    s.gridClipboard = lines.join("\n");
    s.gridClipboardMeta = {
      cell: D.cell(Math.min(a.r, b.r), Math.min(a.c, b.c)),
      cut,
    };
    try {
      await navigator.clipboard.writeText(s.gridClipboard);
    } catch {}
    if (cut) await clear(false);
  }
  async function paste() {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      if (s.gridClipboard === undefined)
        throw Error("Скопируйте ячейки в таблице перед вставкой");
      text = s.gridClipboard;
    }
    const p = D.coords(selected),
      next = D.copy(sheet),
      dim = dimensions(),
      updates = [];
    for (const [dr, row] of text.replace(/\r/g, "").split("\n").entries())
      for (const [dc, v] of row.split("\t").entries()) {
        if (p.r + dr >= dim.rows || p.c + dc >= dim.cols)
          throw Error("Вставка выходит за границы листа");
        const k = D.cell(p.r + dr, p.c + dc);
        const source =
          s.gridClipboardMeta &&
          text === s.gridClipboard &&
          !s.gridClipboardMeta.cut
            ? D.coords(s.gridClipboardMeta.cell)
            : null;
        const pasted = source
          ? D.translate(v, p.r - source.r, p.c - source.c)
          : v;
        next.cells[k] = { ...next.cells[k], raw: pasted };
        updates.push([k, pasted]);
      }
    if (sheetId === "linked") return linkedWrite(updates, "Вставка факта");
    await persist(next, "Вставка диапазона");
  }
  async function clear(all) {
    if (sheetId === "linked") {
      await linkedWrite(
        D.range(selected, end).map((k) => [k, ""]),
        "Очистка факта",
      );
      if (all) {
        const next = D.copy(sheet);
        for (const k of D.range(selected, end)) delete next.cells[styleKey(k)];
        await persist(next, "Очистка оформления");
      }
      return;
    }
    const next = D.copy(sheet);
    for (const k of D.range(selected, end)) {
      if (all) delete next.cells[k];
      else next.cells[k] = { ...next.cells[k], raw: "" };
    }
    await persist(next, all ? "Очистить всё" : "Очистить содержимое");
  }
  function menu() {
    const keys = D.range(selected, end),
      filled = keys.some((k) => raw(k) !== ""),
      styled = keys.some((k) => sheet.cells[styleKey(k)]?.style);
    let writable = true;
    try {
      s.require("table", "edit");
    } catch {
      writable = false;
    }
    const factRange =
      sheetId !== "linked" ||
      keys.every((k) => {
        const { row, day, p } = linkedAt(k);
        return row && !row.section && p.c > 0 && day && day.date <= D.today();
      });
    const available = {
      copy: filled,
      cut: filled && writable && factRange,
      paste:
        writable &&
        factRange &&
        (s.gridClipboard !== undefined || !!navigator.clipboard?.readText),
      sum: keys.length > 1 && keys.some((k) => typeof computed(k) === "number"),
      edit: keys.length === 1 && writable && factRange,
      merge: sheetId!=='linked'&&writable&&keys.length>1,
      unmerge: sheetId!=='linked'&&writable&&intersectingMerges(sheet,selected,end).length>0,
      fill: keys.length > 1 && raw(selected) !== "" && writable && factRange,
      clear: filled && writable && factRange,
      "clear-all": (filled || styled) && writable && factRange,
      undo: !!undo.length,
      redo: !!redo.length,
      format: writable,
      borders: writable,
      rename: sheetId !== "linked" && s.sheetManager(),
      "add-col": writable,
      "add-row": writable,
      "delete-row":
        writable &&
        !simple() &&
      (sheetId !== "linked" || !!linkedAt(selected).row),
    };
    const labels={copy:'Копировать',cut:'Вырезать',paste:'Вставить',sum:'Сумма выделенного',edit:simple()?'Ввести число':'Значение / формула',fill:'Заполнить автоматически',merge:'Объединить ячейки',unmerge:'Разъединить ячейки',clear:'Очистить содержимое','clear-all':'Очистить всё',undo:'Отменить',redo:'Повторить',format:'Формат ячеек',borders:'Границы',rename:'Переименовать лист','add-col':'Добавить столбцы','add-row':'Добавить строки','delete-row':'Удалить строки'};
    const pictograms={copy:icons.copy,paste:icons.paste,cut:icon('<path d="m8 8 12 12M8 16 12 12l8-8"/><circle cx="5" cy="5" r="3"/><circle cx="5" cy="19" r="3"/>'),edit:icon('<path d="m4 16 12-12 4 4L8 20H4z"/>'),fill:icon('<path d="M5 3h14v18H5zM5 9h14M5 15h14M12 3v18M9 12h6"/>'),merge:icon('<rect x="3" y="5" width="18" height="14"/><path d="M7 12h10m-3-3 3 3-3 3M10 9l-3 3 3 3"/>'),unmerge:icon('<rect x="3" y="5" width="18" height="14"/><path d="M12 5v14"/>'),borders:icons.border,format:icons.text,clear:icons.clear,'clear-all':icons.clear,undo:'↶',redo:'↷',sum:'Σ',rename:'Aa','add-col':'↔','add-row':'↕','delete-row':'−'};
    const actionButton=(a,compact=false)=>btn('<span aria-hidden="true">'+(pictograms[a]||'•')+'</span>'+(compact?'':'<span>'+labels[a]+'</span>'),a,'class="'+(compact?'tn-context-icon':'tn-context-action')+'" aria-label="'+labels[a]+'" title="'+labels[a]+'"');
    const shortcuts=['copy','cut','paste','undo','redo'].filter(a=>available[a]);
    const groups=[['edit','fill','merge','unmerge'],['sum','borders','format'],['clear','clear-all'],['rename','add-col','add-row','delete-row']].map(g=>g.filter(a=>available[a])).filter(g=>g.length);
    const el=dialog('Ячейки '+rangeInput.value,(shortcuts.length?'<div class="tn-context-shortcuts">'+shortcuts.map(a=>actionButton(a,true)).join('')+'</div>':'')+groups.map(g=>'<div class="tn-context-group">'+g.map(a=>actionButton(a)).join('')+'</div>').join(''));
    el.classList.add('tn-context-menu');
    const actions = {
      edit: () => {
        if (simple()) return openHours(selected);
        edit.focus({ preventScroll: true });
        edit.select();
      },
      copy: () => copySelection(),
      cut: () => copySelection(true),
      paste,
      sum: () => {
        const values = D.range(selected, end)
          .map((k) =>
            sheetId === "linked"
              ? Number(raw(k).replace(",", "."))
              : D.formula(sheet.cells, k, sheet),
          )
          .filter((n) => typeof n === "number" && Number.isFinite(n));
        dialog(
          "Сумма",
          "<p>" + D.fmt(values.reduce((a, b) => a + b, 0)) + "</p>",
        );
      },
      fill: () => fill(selected, end),
      merge: () => mergeSelection(),
      unmerge: () => mergeSelection(true),
      clear: () => clear(false),
      "clear-all": () => clear(true),
      format,
      borders,
      undo: () => restore(undo, redo),
      redo: () => restore(redo, undo),
      rename: () => {
        if (sheetId === "linked") throw Error("Первый лист обязателен");
        dialog(
          "Название листа",
          input("name", sheet.name, "required"),
          async (f) =>
            persist({ ...sheet, name: f.get("name") }, "Название листа"),
        );
      },
      "add-col": () => grow("cols"),
      "add-row": () => grow("rows"),
      "delete-row": deleteRows,
    };
    for (const [action, fn] of Object.entries(actions)) {
      const button = el.querySelector("[data-action=" + action + "]");
      if(!button)continue;
      button.onclick = () => {
        el.close();
        queue(fn);
      };
    }
  }
  function deleteRows() {
    const first = Math.min(D.coords(selected).r, D.coords(end).r),
      last = Math.max(D.coords(selected).r, D.coords(end).r),
      rows = linkedRows.slice(Math.max(0, first - 2), last - 1);
    if (sheetId === "linked" && first < 2)
      throw Error("Заголовки адреса и даты удалять нельзя");
    const el = dialog(
      "Удалить строки " + (first + 1) + "–" + (last + 1) + "?",
      "<p>Строки будут удалены из этого листа целиком." +
        (sheetId === "linked"
          ? " Данные смен сохранятся в истории. Действие можно отменить кнопкой ↶."
          : " Действие можно отменить кнопкой ↶.") +
        "</p>",
      async () => {
        if (dirty) await queueCommit();
        const next = D.copy(sheet);
        if (sheetId === "linked")
          next.hiddenRows = [
            ...new Set([...(next.hiddenRows || []), ...rows.map((r) => r.id)]),
          ];
        else {
          const count = last - first + 1,
            cells = {},
            heights = {};
          for (const [key, value] of Object.entries(next.cells)) {
            const p = D.coords(key);
            if (p.r < first || p.r > last)
              cells[D.cell(p.r > last ? p.r - count : p.r, p.c)] = value;
          }
          for (const [r, value] of Object.entries(next.heights))
            if (+r < first || +r > last)
              heights[+r > last ? +r - count : r] = value;
          next.cells = cells;
          next.heights = heights;
          next.rows = Math.max(1, next.rows - count);
        }
        selected = end = "A1";
        await persist(next, "Удаление строк целиком");
      },
    );
    el.querySelector("[type=submit]").textContent = "Удалить";
  }
  async function restore(from, to) {
    if (!from.length) return;
    const target = from.at(-1);
    if (target.fact) {
      const inverse = [];
      for (const item of target.fact) {
        const current = s.store.get(item.key);
        if (JSON.stringify(current.data) !== JSON.stringify(item.data))
          throw Error(
            "После этой правки данные изменились. Автоматическая отмена остановлена без перезаписи.",
          );
      }
      for (const item of target.fact) {
        const current = s.store.get(item.key);
        const data = item.before.data || {
          ...D.copy(item.data),
          equipment: [],
          people: [],
          values: {},
        };
        await s.save(item.key, data, current, "Отмена / повтор факта", "table");
        inverse.push({ key: item.key, before: current, data });
        const existing = allDays.find(
          (d) => d.date === data.date && d.shift === data.shift,
        );
        if (existing) Object.assign(existing, data);
      }
      to.push({ fact: inverse });
      from.pop();
      draw();
      return;
    }
    const current = s.store.get(key());
    if (JSON.stringify(current.data) !== JSON.stringify(target.sheetAfter))
      throw Error(
        "После вашей правки лист изменился. Отмена остановлена, чтобы сохранить чужие изменения.",
      );
    await s.save(
      key(),
      target.sheetBefore,
      current,
      "Отмена / повтор",
      "table",
    );
    to.push({
      sheetBefore: D.copy(target.sheetAfter),
      sheetAfter: D.copy(target.sheetBefore),
    });
    from.pop();
    base = s.store.get(key());
    sheet = D.copy(target.sheetBefore);
    draw();
  }
  async function grow(axis) {
    if (sheetId === "linked") {
      if (axis === "cols") return s.addDay();
      return s.composition();
    }
    const next = D.copy(sheet);
    next[axis] += axis === "cols" ? 1 : 20;
    if (next.cols > 100 || next.rows > 1000)
      throw Error("Лимит облегчённого листа: 100 столбцов × 1000 строк");
    await persist(next, "Размер листа");
  }
  async function sheetAccess() {
    if (!s.sheetManager())
      throw Error("Доступ настраивает прораб или администратор");
    const config = s.config(),
      access = config.sheetAccess?.[sheetId] || {},
      users = (await s.host.users?.()) || [];
    dialog(
      "Кто видит лист «" + (sheetId === "linked" ? "Табель" : sheet.name) + "»",
      "<p>Для серверной защиты доступа должны быть опубликованы правила Firebase из выпуска 3.4.41.</p><p>Администратор и прораб видят все листы. Остальным доступ нужно разрешить отдельно.</p>" +
        [
          ...["master", "lopater", "viewer"].map(
            (role) =>
              `<label class="tn-check"><input type="checkbox" name="role" value="${role}" ${access.roles?.[role] ? "checked" : ""}>${{ master: "Мастера", lopater: "Лопатеры", viewer: "Наблюдатели" }[role]}</label>`,
          ),
          ...users
            .filter(
              (u) =>
                u.status === "active" && !["admin", "foreman"].includes(u.role),
            )
            .map(
              (u) =>
                `<label class="tn-check"><input type="checkbox" name="user" value="${esc(u.id || u.uid)}" ${access.users?.[u.id || u.uid] ? "checked" : ""}>${esc(u.nickname || u.name || u.email || u.id)}</label>`,
            ),
        ].join(""),
      async (f) => {
        const base = s.store.get(s.key("config")),
          next = D.copy(s.config());
        next.sheetAccess ||= {};
        next.sheetAccess[sheetId] = {
          roles: Object.fromEntries(f.getAll("role").map((r) => [r, true])),
          users: Object.fromEntries(f.getAll("user").map((u) => [u, true])),
        };
        await s.saveConfig(next, base);
        tabs();
      },
    );
  }
  function sheetOptions() {
    if (!s.sheetManager())
      throw Error("Управление листами доступно прорабу и администратору");
    if (sheetId === "linked") return;
    const el = dialog(
      sheet.name,
      btn("Переименовать", "rename-sheet") +
        btn("Удалить лист", "delete-sheet"),
    );
    el.querySelector("[data-action=rename-sheet]").onclick = () => {
      el.close();
      dialog(
        "Название листа",
        input("name", sheet.name, 'required maxlength="80"'),
        async (f) => {
          const name = String(f.get("name")).trim();
          if (!name) throw Error("Введите название");
          await persist({ ...sheet, name }, "Переименование листа");
          tabs();
        },
      );
    };
    el.querySelector("[data-action=delete-sheet]").onclick = () => {
      el.close();
      dialog(
        "Удалить лист «" + sheet.name + "»?",
        "<p>Лист исчезнет из списка. Основной табель останется.</p>",
        async () => {
          await s.save(
            key(),
            { ...sheet, deleted: true },
            base,
            "Удаление листа",
            "table",
          );
          await load("linked");
        },
      );
    };
  }
  function confirmEnable(name, date) {
    return new Promise((resolve) => {
      let accepted = false;
      const el = dialog(
        "Помпа выключена в этой смене",
        `<p>${esc(name)} · ${D.display(date)}. Включить и сохранить введённое значение?</p>`,
        async () => {
          accepted = true;
        },
      );
      el.querySelector("[type=submit]").textContent = "Включить";
      el.addEventListener("close", () => resolve(accepted), { once: true });
    });
  }
  function confirmAdd(name, date) {
    return new Promise((resolve) => {
      let accepted = false;
      const el = dialog(
        "Нет в составе смены",
        `<p>${esc(name)} нет в составе смены на ${D.display(date)}. Добавить с введёнными часами?</p>`,
        async () => {
          accepted = true;
        },
      );
      el.querySelector("[type=submit]").textContent = "Добавить";
      el.addEventListener("close", () => resolve(accepted), { once: true });
    });
  }
  function newSheet() {
    if (!s.sheetManager())
      throw Error("Управление листами доступно прорабу и администратору");
    const defaultType = c.newSheet;
    if (defaultType === "ask") {
      dialog(
        "Добавить лист",
        '<select name="type"><option value="blank">Пустой</option><option value="template">Копия шаблона табеля без связи</option></select>',
        async (f) => createSheet(f.get("type")),
      );
    } else createSheet(defaultType).catch(error);
  }
  async function createSheet(type) {
    const id = D.uid(),
      next = {
        ...blank(),
        name: "Лист " + (s.store.list(s.key("sheet:")).length + 1),
      };
    if (type === "template") {
      const rr = D.rows(c, allDays);
      next.cells.A1 = { raw: c.name };
      for (const [i, row] of rr.entries())
        next.cells["A" + (i + 3)] = {
          raw: row.name,
          style: {
            background: row.color,
            color: row.section ? "#fff" : "#111",
          },
        };
      next.widths[0] = 200;
    }
    const cb = s.store.get(s.key("config")),
      config = D.copy(s.config());
    config.sheetAccess ||= {};
    config.sheetAccess[id] = { roles: {}, users: {} };
    await s.saveConfig(config, cb);
    const key = s.key("sheet:" + id);
    await s.save(key, next, s.store.get(key), "Создание листа", "table");
    await load(id);
  }
  async function setStyles(style) {
    const next = D.copy(sheet);
    for (const k of D.range(selected, end)) {
      const id = styleKey(k);
      next.cells[id] = {
        ...next.cells[id],
        style: { ...next.cells[id]?.style, ...style },
      };
    }
    await persist(next, "Оформление " + rangeInput.value);
  }
  function borders() {
    s.require('table','edit');
    const names={all:'Все',outer:'Внешние',inner:'Внутренние',horizontal:'Горизонтальные',vertical:'Вертикальные',top:'Сверху',bottom:'Снизу',left:'Слева',right:'Справа',none:'Убрать все'};
    const drawing=p=>{
      const edges={all:['M4 4h24v24H4z','M16 4v24M4 16h24'],outer:['M4 4h24v24H4z'],inner:['M16 4v24M4 16h24'],horizontal:['M4 16h24'],vertical:['M16 4v24'],top:['M4 4h24'],bottom:['M4 28h24'],left:['M4 4v24'],right:['M28 4v24'],none:['M6 26 26 6']}[p];
      return '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 4h24v24H4zM16 4v24M4 16h24" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 3"/><path d="'+edges.join(' ')+'" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    };
    let preset='all';
    const el=dialog('Границы · '+rangeInput.value,'<div class="tn-border-presets">'+BORDER_PRESETS.map(p=>btn(drawing(p)+'<span>'+names[p]+'</span>','border-'+p,'aria-pressed="'+(p==='all')+'" title="'+names[p]+'"')).join('')+'</div><div class="tn-border-options">'+field('Толщина','<select name="width"><option value="1">Тонкая · 1 px</option><option value="2">Средняя · 2 px</option><option value="3">Жирная · 3 px</option><option value="4">Очень жирная · 4 px</option></select>')+field('Линия','<select name="pattern"><option value="solid">Сплошная</option><option value="dashed">Штриховая</option><option value="dotted">Точечная</option><option value="double">Двойная</option></select>')+field('Цвет','<input type="color" name="color" value="#111111">')+'</div><div class="tn-border-preview" aria-label="Предпросмотр границы"><span>Предпросмотр</span></div>',async f=>{
      const options={preset,width:Number(f.get('width')),pattern:f.get('pattern'),color:f.get('color')};
      const work=chain.then(()=>persist(applyBorders(sheet,selected,end,options,styleKey,dimensions()),'Границы '+rangeInput.value));chain=work.catch(error);await work;
    });
    el.classList.add('tn-borders-dialog');el.querySelector('[type=submit]').textContent='Применить';
    const preview=()=>{const data=new FormData(el.querySelector('form'));el.querySelector('.tn-border-preview span').style.border=preset==='none'?'0px solid transparent':borderLine({width:Number(data.get('width')),pattern:data.get('pattern'),color:data.get('color')});};
    for(const p of BORDER_PRESETS)el.querySelector('[data-action=border-'+p+']').onclick=()=>{preset=p;el.querySelectorAll('.tn-border-presets button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.action==='border-'+p)));preview();};
    el.querySelectorAll('select,input').forEach(input=>input.oninput=preview);preview();
  }
  const icon = (paths) =>
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    paths +
    "</svg>";
  const icons = {
    fill: icon(
      '<path d="m4 11 7-7 9 9-7 7zM7 2l10 10M20 15c3 4 2 6 0 6s-3-2 0-6"/>',
    ),
    text: icon('<path d="m6 18 6-14 6 14M8 13h8M4 22h16"/>'),
    border: icon(
      '<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16"/>',
    ),
    copy: icon(
      '<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/>',
    ),
    paste: icon('<path d="M8 5H4v16h16V5h-4M8 3h8v5H8z"/>'),
    clear: icon('<path d="m5 16 10-12 6 5L11 21H8zM11 21h10M10 10l6 5"/>'),
  };
  const tools = [
    ["tool-fill", icons.fill, "Заливка"],
    ["tool-text", icons.text, "Цвет текста"],
    ["tool-border", icons.border, "Границы"],
    ["tool-bold", "<b>Ж</b>", "Жирный"],
    ["tool-italic", "<i>К</i>", "Курсив"],
    ["tool-align", "≡", "Выравнивание"],
    ["tool-copy", icons.copy, "Копировать"],
    ["tool-paste", icons.paste, "Вставить"],
    ["tool-clear", icons.clear, "Очистить"],
    ["tool-merge", "↔", "Объединить ячейки"],
    ["tool-unmerge", "⋮", "Разъединить ячейки"],
    ["tool-format", "⋯", "Все настройки"],
  ];
  host.querySelector(".tn-cell-tools").innerHTML = tools
    .map(([a, label, title]) =>
      btn(label, a, 'aria-label="' + title + '" title="' + title + '"'),
    )
    .join("");
  const toolActions = {
    "tool-merge":()=>queue(()=>mergeSelection()),
    "tool-unmerge":()=>queue(()=>mergeSelection(true)),
    "tool-fill": () =>
      chooseColor("Заливка ячеек", cellStyle(selected).background, (color) =>
        queue(() => setStyles({ background: color })),
      ),
    "tool-text": () =>
      chooseColor("Цвет текста", cellStyle(selected).color, (color) =>
        queue(() => setStyles({ color })),
      ),
    "tool-border": borders,
    "tool-bold": () =>
      queue(() =>
        setStyles({
          fontWeight:
            cellStyle(selected).fontWeight === "bold" ? "normal" : "bold",
        }),
      ),
    "tool-italic": () =>
      queue(() =>
        setStyles({
          fontStyle:
            cellStyle(selected).fontStyle === "italic" ? "normal" : "italic",
        }),
      ),
    "tool-align": () => {
      const el = dialog(
        "Выравнивание",
        [
          ["left", "Слева"],
          ["center", "По центру"],
          ["right", "Справа"],
        ]
          .map(([a, label]) => btn(label, a))
          .join(""),
      );
      for (const a of ["left", "center", "right"])
        el.querySelector("[data-action=" + a + "]").onclick = () => {
          el.close();
          queue(() => setStyles({ textAlign: a }));
        };
    },
    "tool-copy": () => queue(() => copySelection()),
    "tool-paste": () => queue(paste),
    "tool-clear": () => queue(() => clear(false)),
    "tool-format": format,
  };
  for (const [a, fn] of Object.entries(toolActions))
    host.querySelector("[data-action=" + a + "]").onclick = fn;
  host.querySelector("[data-action=undo]").onclick = () =>
    queue(() => restore(undo, redo));
  host.querySelector("[data-action=redo]").onclick = () =>
    queue(() => restore(redo, undo));
  host.querySelector("[data-action=format]").onclick = format;
  host.querySelector("[data-action=menu]").onclick = menu;
  host.querySelector("[data-action=day]").onclick = () =>
    s.addDay().catch(error);
  host.querySelector("[data-action=roster]").onclick = () => {
    const d = linkedAt(selected).day;
    if (d) {
      s.day = d.date;
      s.shift = d.shift;
    }
    try {
      s.composition();
    } catch (e) {
      error(e);
    }
  };
  host.querySelector("[data-action=back]").onclick = () => {
    s.view = "shift";
    s.refresh();
  };
  const weekSelect = host.querySelector("[data-week]"),
    ww = D.weeks(c.start, allDays.at(-1)?.date || c.start);
  weekSelect.innerHTML = ww
    .map(
      (w) =>
        `<option value="${w.id}">${D.display(w.start)}–${D.display(w.end)}</option>`,
    )
    .join("");
  week = ww.at(-1)?.id || D.monday(c.start);
  weekSelect.value = week;
  weekSelect.onchange = () => {
    week = weekSelect.value;
    selected = end = "A1";
    draw();
  };
  host.querySelector("[data-period]").onchange = (e) => {
    period = e.target.value;
    selected = end = "A1";
    draw();
  };
  host.querySelector("[data-zoom]").onchange = (e) => {
    scale = Number(e.target.value);
    draw();
  };
  let viewportHeight = globalThis.visualViewport?.height || innerHeight;
  const viewport = () => {
    if (disposed) return;
    const focused = document.activeElement === edit && !simple(),
      v = globalThis.visualViewport;
    const inset = Math.max(0, v ? innerHeight - v.height - v.offsetTop : 0);
    if (!focused) viewportHeight = v?.height || innerHeight;
    const raised = focused && (inset > 100 || viewportHeight - (v?.height || innerHeight) > 100);
    dock.classList.toggle("tn-keyboard-dock", raised);
    dock.style.bottom = inset + "px";
    if (raised) {
      const rect = host.getBoundingClientRect();
      dock.style.left = rect.left + "px";
      dock.style.width = rect.width + "px";
    } else {
      dock.style.left = dock.style.width = "";
      if (!focused) suggestions.hidden = true;
    }
    host.style.paddingBottom = raised ? dock.getBoundingClientRect().height + "px" : "";
  };
  edit.onfocus = viewport;
  edit.onblur = () => {
    setTimeout(viewport, 0);
    // Picking a reference must keep the draft and its destination intact.
    if (dirty && !formulaMode()) void queueCommit();
  };
  globalThis.visualViewport?.addEventListener("resize", viewport);
  globalThis.visualViewport?.addEventListener("scroll", viewport);
  globalThis.addEventListener("resize", viewport);
  symbols.querySelectorAll("button").forEach((b) => {
    b.onpointerdown = (e) => e.preventDefault();
    b.onclick = () => {
      const pos = edit.selectionStart ?? edit.value.length,
        to = edit.selectionEnd ?? pos;
      edit.setRangeText(b.dataset.symbol, pos, to, "end");
      edit.dispatchEvent(new Event("input"));
      edit.focus({ preventScroll: true });
    };
  });
  const position = s.gridPositions?.[s.object.id];
  if (position) {
    period = position.period;
    week = position.week;
    scale = position.scale;
  }
  await load(position?.sheetId || "linked");
  if (position && sheetId) {
    selected = position.selected;
    end = position.end;
    mark();
    scroll.scrollTop = position.top;
    scroll.scrollLeft = position.left;
  }
  return {
    finish: () => (dirty ? queueCommit() : chain),
    snapshot() {
      return {
        sheetId,
        selected,
        end,
        period,
        week,
        scale,
        top: scroll.scrollTop,
        left: scroll.scrollLeft,
      };
    },
    dispose() {
      disposed = true;
      live.dispose();
      host.style.paddingBottom = "";
      globalThis.removeEventListener("resize", viewport);
      saveStacks();
      globalThis.visualViewport?.removeEventListener("resize", viewport);
      globalThis.visualViewport?.removeEventListener("scroll", viewport);
    },
    idle: () => chain,
  };
}
