import * as D from "./domain.mjs";
import { esc, btn, input, field, dialog, error } from "./ui.mjs";
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
  const c = s.config(),
    allDays = s.days();
  let period = "all",
    week = "",
    scale = 1;
  let visibleDays = [],
    linkedRows = [];
  host.innerHTML = `<div class="tn-grid-tools">${btn("‹", "back", 'title="К смене"')}${btn("＋ День", "day")}${btn("Состав", "roster")}${btn("Формат", "format")}${btn("⋯", "menu")}<select data-period aria-label="Период"><option value="all">Весь объект</option><option value="week">Неделя</option></select><select data-week aria-label="Неделя"></select><select data-zoom aria-label="Масштаб"><option value="1">100%</option><option value="0.85">85%</option><option value="1.2">120%</option></select></div><div class="tn-formula"><input data-range value="A1" aria-label="Диапазон"><span>ƒx</span><input data-editor aria-label="Значение / формула" autocomplete="off">${btn("✓", "apply", 'aria-label="Применить"')}</div><div class="tn-grid-scroll" tabindex="0"><table class="tn-grid"></table></div><div class="tn-sheets"></div><div class="tn-symbols" hidden>${["=", "+", "−", "*", "/", "(", ")", ",", ":", "СУММ("].map((x) => btn(esc(x), "symbol", `data-symbol="${esc(x)}"`)).join("")}</div>`;
  const table = host.querySelector("table"),
    scroll = host.querySelector(".tn-grid-scroll"),
    edit = host.querySelector("[data-editor]"),
    rangeInput = host.querySelector("[data-range]"),
    symbols = host.querySelector(".tn-symbols");
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
    await chain;
    sheetId = id;
    await s.store.pull(key());
    base = s.store.get(key());
    sheet = base.data || blank();
    undo = [];
    redo = [];
    startRow = 0;
    selected = end = "A1";
    const draft = s.store.get(s.key("draft:grid:" + id)).data;
    if (draft) {
      selected = end = draft.cell;
    }
    draw();
    tabs();
    if (draft) edit.value = draft.raw;
  }
  function tabs() {
    host.querySelector(".tn-sheets").innerHTML =
      btn(
        "Табель",
        "sheet",
        `data-id="linked" aria-pressed="${sheetId === "linked"}"`,
      ) +
      s.store
        .list(s.key("sheet:"))
        .filter((r) => r.data && r.key !== s.key("sheet:linked"))
        .map((r) =>
          btn(
            esc(r.data.name),
            "sheet",
            `data-id="${esc(r.key.slice(s.key("sheet:").length))}" aria-pressed="${sheetId === r.key.slice(s.key("sheet:").length)}"`,
          ),
        )
        .join("") +
      btn("＋", "new-sheet", 'aria-label="Добавить лист"');
    host
      .querySelectorAll("[data-action=sheet]")
      .forEach((b) => (b.onclick = () => load(b.dataset.id).catch(error)));
    host.querySelector("[data-action=new-sheet]").onclick = () => newSheet();
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
      linkedRows = D.rows(config, allDays);
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
    const { row, day, p } = linkedAt(k);
    if (p.r === 0) return p.c === 0 ? "Адрес" : p.c === 1 ? c.name : "";
    if (p.r === 1) return p.c === 0 ? "Дата" : D.shiftLabel(day);
    if (!row) return "";
    if (p.c === 0) return row.name;
    if (row.section) return "";
    return D.fmt(D.value(row, day));
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
        ].includes(k),
      )
      .map(
        ([k, v]) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + ":" + v,
      )
      .join(";");
  }
  function draw() {
    if (disposed) return;
    const dim = dimensions();
    host.querySelector("[data-period]").hidden = sheetId !== "linked";
    host.querySelector("[data-week]").hidden =
      sheetId !== "linked" || period !== "week";
    const max =
        sheetId === "linked" ? dim.rows : Math.min(dim.rows, startRow + 80),
      first = sheetId === "linked" ? 0 : startRow;
    const memo = new Map();
    table.style.fontSize = 12 * scale + "px";
    table.innerHTML =
      '<colgroup><col style="width:32px">' +
      Array.from(
        { length: dim.cols },
        (_, col) =>
          `<col style="width:${(sheet.widths[widthKey(col)] || (sheetId === "linked" && col === 0 ? 200 : 80)) * scale}px">`,
      ).join("") +
      '</colgroup><thead><tr><th class="tn-corner"></th>' +
      Array.from(
        { length: dim.cols },
        (_, col) =>
          `<th data-column="${col}">${D.colName(col)}<span class="tn-resize-col" data-resize-col="${col}"></span></th>`,
      ).join("") +
      "</tr></thead><tbody>" +
      (first
        ? `<tr><td colspan="${dim.cols + 1}">${btn("↑ Предыдущие 60 строк", "prev-rows")}</td></tr>`
        : "") +
      Array.from({ length: max - first }, (_, i) => {
        const r = i + first,
          height = (sheet.heights[heightKey(r)] || 27) * scale;
        return (
          `<tr style="height:${height}px"><th data-row="${r}">${r + 1}<span class="tn-resize-row" data-resize-row="${r}"></span></th>` +
          Array.from({ length: dim.cols }, (_, col) => {
            const k = D.cell(r, col);
            let v =
              sheetId === "linked"
                ? raw(k)
                : D.formula(sheet.cells, k, dim, new Set(), memo);
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
            return `<td data-cell="${k}" tabindex="-1" style="${esc(css(cellStyle(k)))}">${esc(v)}</td>`;
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
              26 + (sheet.heights["header:0"] || 27) * scale + "px"),
        );
    }
    mark();
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
    if (td) {
      const handle = document.createElement("span");
      handle.className = "tn-fill";
      handle.setAttribute("aria-label", "Маркер автозаполнения");
      td.append(handle);
    }
    rangeInput.value = selected === end ? selected : selected + ":" + end;
    if (document.activeElement !== edit) edit.value = raw(selected);
  }
  async function persist(next, label) {
    s.require("table", "edit");
    undo.push(D.copy(sheet));
    if (undo.length > 30) undo.shift();
    redo = [];
    await s.save(key(), next, base, label, "table");
    base = s.store.get(key());
    sheet = D.copy(next);
    draw();
  }
  function queue(fn) {
    chain = chain.then(fn).catch(error);
    return chain;
  }
  async function linkedWrite(updates, label) {
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
        redo = [];
        draw();
      }
    }
  }
  async function apply() {
    const rawValue = edit.value;
    if (sheetId === "linked")
      await linkedWrite([[selected, rawValue]], "Ввод из таблицы");
    else {
      const next = D.copy(sheet);
      next.cells[selected] = { ...next.cells[selected], raw: rawValue };
      await persist(next, "Ячейка " + selected);
    }
  }
  const commit = async () => {
    await apply();
    await s.store.serialize(async () => {
      delete s.store.state.records[s.key("draft:grid:" + sheetId)];
      await s.store.persist();
    });
  };
  edit.oninput = () => {
    const data = { cell: selected, raw: edit.value },
      draftKey = s.key("draft:grid:" + sheetId);
    queue(() =>
      s.store.serialize(async () => {
        s.store.state.records[draftKey] = { revision: 0, data };
        await s.store.persist();
      }),
    );
  };
  host.querySelector("[data-action=apply]").onclick = () => queue(commit);
  edit.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      queue(commit);
    }
    if (e.key === "Escape") {
      edit.value = raw(selected);
      edit.blur();
    }
  };
  table.onclick = (e) => {
    if (e.target.closest("[class*=tn-resize]") || e.target.closest(".tn-fill"))
      return;
    const td = e.target.closest("[data-cell]");
    if (td) {
      selected = td.dataset.cell;
      end = selected;
      mark();
      edit.value = raw(selected);
      edit.focus({ preventScroll: true });
      return;
    }
    const col = e.target.closest("[data-column]"),
      row = e.target.closest("[data-row]"),
      dim = dimensions();
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
    if (td) {
      selected = end = td.dataset.cell;
      mark();
    }
    menu();
  };
  let hold, origin;
  table.addEventListener("pointerdown", (e) => {
    const target = e.target.closest("[data-resize-col],[data-resize-row]");
    if (target) {
      e.preventDefault();
      const isCol = target.dataset.resizeCol != null,
        index = Number(
          isCol ? target.dataset.resizeCol : target.dataset.resizeRow,
        ),
        initial = isCol ? e.clientX : e.clientY,
        size = isCol
          ? sheet.widths[widthKey(index)] ||
            (sheetId === "linked" && index === 0 ? 200 : 80)
          : sheet.heights[heightKey(index)] || 27;
      target.setPointerCapture(e.pointerId);
      const move = (event) => {
        target.dataset.size = Math.max(
          isCol ? 40 : 20,
          Math.min(
            isCol ? 600 : 300,
            size + ((isCol ? event.clientX : event.clientY) - initial) / scale,
          ),
        );
      };
      const up = () => {
        target.removeEventListener("pointermove", move);
        const next = D.copy(sheet);
        next[isCol ? "widths" : "heights"][
          isCol ? widthKey(index) : heightKey(index)
        ] = Number(target.dataset.size || size);
        queue(() => persist(next, "Размер " + (isCol ? "столбца" : "строки")));
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up, { once: true });
      return;
    }
    if (e.target.closest(".tn-fill")) {
      e.preventDefault();
      const seed = selected;
      const finish = (event) => {
        table.removeEventListener("pointerup", finish);
        const td = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest("[data-cell]");
        if (td) {
          end = td.dataset.cell;
          queue(() => fill(seed, end));
        }
      };
      table.addEventListener("pointerup", finish, { once: true });
      return;
    }
    const td = e.target.closest("[data-cell]");
    if (td) {
      origin = { x: e.clientX, y: e.clientY };
      hold = setTimeout(() => {
        selected = end = td.dataset.cell;
        mark();
        menu();
      }, 650);
    }
  });
  table.addEventListener("pointermove", (e) => {
    if (origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 8)
      clearTimeout(hold);
  });
  for (const ev of ["pointerup", "pointercancel"])
    table.addEventListener(ev, () => clearTimeout(hold));
  rangeInput.onchange = () => {
    try {
      const [a, b = a] = rangeInput.value.toUpperCase().split(":");
      const dim = dimensions();
      for (const k of [a, b]) {
        const p = D.coords(k);
        if (p.r >= dim.rows || p.c >= dim.cols)
          throw Error("Диапазон вне листа");
      }
      D.range(a, b);
      selected = a;
      end = b;
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
  function format() {
    const st = cellStyle(selected),
      p = D.coords(selected);
    dialog(
      "Формат диапазона " + rangeInput.value,
      `<div class="tn-format-grid">${field("Фон", input("background", st.background, 'type="color"'))}${field("Текст", input("color", st.color, 'type="color"'))}${field("Шрифт, px", input("fontSize", parseInt(st.fontSize) || 12, 'type="number" min="8" max="48"'))}${field("Ширина столбцов", input("width", sheet.widths[widthKey(p.c)] || 80, 'type="number" min="40" max="600"'))}${field("Высота строк", input("height", sheet.heights[heightKey(p.r)] || 27, 'type="number" min="20" max="300"'))}${field("Выравнивание", '<select name="textAlign"><option>left</option><option>center</option><option>right</option></select>')}</div>${field("Числовой формат", '<select name="numberFormat"><option value="">Автоматически</option><option value="0">Целое</option><option value="2">Два знака</option><option value="percent">Проценты</option></select>')}<label><input type="checkbox" name="bold" ${st.fontWeight === "bold" ? "checked" : ""}>Жирный</label><label><input type="checkbox" name="italic" ${st.fontStyle === "italic" ? "checked" : ""}>Курсив</label><label><input type="checkbox" name="wrap" ${st.whiteSpace === "normal" ? "checked" : ""}>Перенос текста</label><label><input type="checkbox" name="border" ${st.border ? "checked" : ""}>Чёткие границы</label>`,
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
            Math.max(40, Number(f.get("width"))),
          );
          next.heights[heightKey(p.r)] = Math.min(
            300,
            Math.max(20, Number(f.get("height"))),
          );
        }
        await persist(next, "Оформление диапазона");
      },
    );
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
    await navigator.clipboard.writeText(lines.join("\n"));
    if (cut) await clear(false);
  }
  async function paste() {
    const text = await navigator.clipboard.readText(),
      p = D.coords(selected),
      next = D.copy(sheet),
      dim = dimensions(),
      updates = [];
    for (const [dr, row] of text.replace(/\r/g, "").split("\n").entries())
      for (const [dc, v] of row.split("\t").entries()) {
        if (p.r + dr >= dim.rows || p.c + dc >= dim.cols)
          throw Error("Вставка выходит за границы листа");
        const k = D.cell(p.r + dr, p.c + dc);
        next.cells[k] = { ...next.cells[k], raw: v };
        updates.push([k, v]);
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
    const el = dialog(
      "Ячейки " + rangeInput.value,
      `<div class="tn-menu">${[
        ["copy", "Копировать"],
        ["cut", "Вырезать"],
        ["paste", "Вставить"],
        ["sum", "Сумма выделенного"],
        ["fill", "Заполнить диапазон"],
        ["clear", "Очистить содержимое"],
        ["clear-all", "Очистить всё"],
        ["undo", "Отменить"],
        ["redo", "Повторить"],
        ["format", "Форматирование"],
        ["rename", "Переименовать лист"],
        ["add-col", "Добавить столбцы"],
        ["add-row", "Добавить строки"],
      ]
        .map(([a, l]) => btn(l, a))
        .join("")}</div>`,
    );
    const actions = {
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
      clear: () => clear(false),
      "clear-all": () => clear(true),
      format,
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
    };
    for (const [action, fn] of Object.entries(actions))
      el.querySelector("[data-action=" + action + "]").onclick = () => {
        el.close();
        queue(fn);
      };
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
    await s.save(key(), target, base, "Отмена / повтор", "table");
    to.push(D.copy(sheet));
    from.pop();
    base = s.store.get(key());
    sheet = D.copy(target);
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
  function newSheet() {
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
    const key = s.key("sheet:" + id);
    await s.save(key, next, s.store.get(key), "Создание листа", "table");
    await load(id);
  }
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
  const viewport = () => {
    const v = visualViewport;
    symbols.style.bottom =
      (v ? Math.max(0, innerHeight - v.height - v.offsetTop) : 0) + "px";
    symbols.hidden = document.activeElement !== edit;
  };
  edit.onfocus = viewport;
  edit.onblur = () => setTimeout(viewport, 0);
  globalThis.visualViewport?.addEventListener("resize", viewport);
  globalThis.visualViewport?.addEventListener("scroll", viewport);
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
  await load("linked");
  return {
    dispose() {
      disposed = true;
      clearTimeout(hold);
      globalThis.visualViewport?.removeEventListener("resize", viewport);
      globalThis.visualViewport?.removeEventListener("scroll", viewport);
    },
    idle: () => chain,
  };
}
