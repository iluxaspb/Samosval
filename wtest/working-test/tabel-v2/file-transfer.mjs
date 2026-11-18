import * as D from './table-domain.mjs';
import {cssToExcelBorder,excelToCssBorder} from './cell-borders.mjs';
import {toExcelFormula} from './formula-engine.mjs';
const clone = x => JSON.parse(JSON.stringify(x));
let loading;
export function excel() {
  if (globalThis.ExcelJS) return Promise.resolve(globalThis.ExcelJS);
  return loading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/exceljs-4.4.0.min.js', import.meta.url);
    script.onload = () => resolve(globalThis.ExcelJS);
    script.onerror = () => { loading = null; script.remove(); reject(Error('Не удалось загрузить модуль Excel')); };
    document.head.append(script);
  });
}
const color = (x,themes={}) => {
  let rgb=/^[0-9a-f]{8}$/i.test(x?.argb || '') ? x.argb.slice(2) : undefined;
  if(!rgb&&Number.isInteger(x?.theme)){
    const key=['lt1','dk1','lt2','dk2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'][x.theme];
    const content=themes.theme1?.match(new RegExp('<a:'+key+'>([\\s\\S]*?)</a:'+key+'>'))?.[1];
    rgb=content?.match(/(?:lastClr|val)="([0-9a-f]{6})"/i)?.[1];
  }
  if(!rgb)return undefined;
  if(typeof x.tint==='number')rgb=rgb.match(/../g).map(v=>{const n=parseInt(v,16),t=x.tint;return Math.round(t<0?n*(1+t):n+(255-n)*t).toString(16).padStart(2,'0');}).join('');
  return '#'+rgb;
};
export function fromWorksheet(ws, themes={}) {
  const rows = Math.max(1, ws.rowCount), cols = Math.max(1, ws.columnCount);
  if (rows > 1000 || cols > 100) throw Error('Лист «'+ws.name+'» превышает 1000 строк или 100 столбцов');
  const sheet = {name: ws.name, rows, cols, cells:{}, widths:{}, heights:{}, merges:clone(ws.model.merges || [])};
  ws.columns.forEach((col, i) => { if (col.width) sheet.widths[i] = Math.round(col.width * 7 + 5); });
  ws.eachRow({includeEmpty:true}, (row, r) => {
    if (row.height) sheet.heights[r-1] = row.height * 4/3;
    row.eachCell({includeEmpty:true}, (cell, c) => {
      if (cell.isMerged && cell.master.address !== cell.address) return;
      const value = cell.value;
      const formula = cell.formula;
      let raw = formula ? '=' + formula : value;
      if (value instanceof Date) raw = value.toLocaleDateString('ru-RU', {timeZone:'UTC'});
      else if (value && typeof value === 'object' && !formula)
        raw = value.richText?.map(t=>t.text).join('') ?? value.text ?? value.error ?? '';
      const style = {};
      const f = cell.font || {}, a = cell.alignment || {};
      if (color(cell.fill?.fgColor,themes)) style.background = color(cell.fill.fgColor,themes);
      if (color(f.color,themes)) style.color = color(f.color,themes);
      if (f.bold) style.fontWeight = 'bold';
      if (f.italic) style.fontStyle = 'italic';
      if (f.size) style.fontSize = f.size * 4/3 + 'px';
      if (['left','right','center'].includes(a.horizontal)) style.textAlign = a.horizontal;
      if (a.wrapText) style.whiteSpace = 'normal';
      for (const side of ['top','bottom','left','right']) {
        const b = cell.border?.[side];
        if (b?.style) style['border'+side[0].toUpperCase()+side.slice(1)] = excelToCssBorder(b.style,color(b.color,themes)||'#555555');
      }
      if (raw != null || Object.keys(cell.style).length)
        sheet.cells[D.cell(r-1,c-1)] = {raw: raw ?? '', style, importedStyle:clone(style), excelStyle:clone(cell.style), excelValue:clone(value), excelDate:value instanceof Date, importedRaw:raw ?? '',
          ...(/%/.test(cell.numFmt||'')?{numberFormat:'percent'}:/^0\.00$/.test(cell.numFmt||'')?{numberFormat:'2'}:{})};
    });
  });
  if (new TextEncoder().encode(JSON.stringify(sheet)).length > 350000)
    throw Error('Лист «'+ws.name+'» превышает 350 КБ. Разделите его на несколько листов');
  return sheet;
}
export async function readExcel(file) {
  if (!/\.xlsx$/i.test(file.name)) throw Error('Выберите файл .xlsx. Старый .xls сначала сохраните в Excel как .xlsx');
  if (file.size > 8*1024*1024) throw Error('Размер файла превышает 8 МБ');
  const E = await excel(), book = new E.Workbook();
  await book.xlsx.load(await file.arrayBuffer());
  if (!book.worksheets.length || book.worksheets.length > 20) throw Error('В книге должно быть от 1 до 20 листов');
  // Validate every sheet before writing anything to the store.
  const sheets=book.worksheets.map(ws=>({...fromWorksheet(ws,book.model.themes),excelThemes:clone(book.model.themes||{}),excelNames:clone(book.model.definedNames||[])}));
  for(const sheet of sheets)if(new TextEncoder().encode(JSON.stringify(sheet)).length>350000)throw Error('Лист «'+sheet.name+'» превышает 350 КБ');
  return sheets;
}
const argb = x => /^#[0-9a-f]{6}$/i.test(x || '') ? 'FF'+x.slice(1).toUpperCase() : undefined;
export function toWorksheet(book, sheet, name=sheet.name) {
  const ws = book.addWorksheet(name.slice(0,31).replace(/[\\/*?:\[\]]/g,'_') || 'Лист');
  for (const [i,width] of Object.entries(sheet.widths || {})) ws.getColumn(Number(i)+1).width = Math.max(1,(width-5)/7);
  for (const [i,height] of Object.entries(sheet.heights || {})) ws.getRow(Number(i)+1).height = height*3/4;
  for (const [k,data] of Object.entries(sheet.cells)) {
    if (!/^[A-Z]+[1-9]\d*$/.test(k)) continue;
    const cell = ws.getCell(k), raw = data.raw ?? '';
    cell.style = clone(data.excelStyle || {});
    if (String(raw).startsWith('=')) {
      const formula = toExcelFormula(raw);
      const result = D.formula(sheet.cells,k,sheet);
      cell.value = {formula, ...(typeof result === 'number' ? {result} : {})};
    } else if(data.excelValue !== undefined && raw === data.importedRaw) cell.value = data.excelDate ? new Date(data.excelValue) : clone(data.excelValue);
    else cell.value = typeof raw === 'number' ? raw : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : String(raw);
    const s = Object.fromEntries(Object.entries(data.style || {}).filter(([k,v])=>v!==data.importedStyle?.[k]));
    cell.font = {...cell.font,
      ...(argb(s.color) ? {color:{argb:argb(s.color)}} : {}),
      ...(s.fontSize ? {size:parseFloat(s.fontSize)*3/4} : {}),
      ...(s.fontWeight ? {bold:s.fontWeight==='bold'} : {}),
      ...(s.fontStyle ? {italic:s.fontStyle==='italic'} : {})};
    if (argb(s.background)) cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:argb(s.background)}};
    cell.alignment = {...cell.alignment, ...(s.textAlign ? {horizontal:s.textAlign} : {}), ...(s.whiteSpace ? {wrapText:s.whiteSpace==='normal'} : {})};
    const borders = {...cell.border};
    for (const side of ['top','bottom','left','right']) {
      const line = s['border'+side[0].toUpperCase()+side.slice(1)] ?? s.border;
      if (line !== undefined) borders[side] = cssToExcelBorder(line);
    }
    cell.border = borders;
    if (data.numberFormat !== undefined) cell.numFmt = {'0':'0','2':'0.00',percent:'0.00%'}[data.numberFormat] || 'General';
  }
  for (const merge of sheet.merges || []) ws.mergeCells(merge);
  ws.pageSetup = {orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,paperSize:9};
  return ws;
}
export async function writeExcel(sheets) {
  const E = await excel(), book = new E.Workbook();
  if(sheets[0]?.excelThemes)book.model={...book.model,themes:clone(sheets[0].excelThemes),definedNames:clone(sheets[0].excelNames||[])};
  book.calcProperties.fullCalcOnLoad = true;
  const names = new Set();
  for (const sheet of sheets) {
    let name = sheet.name.slice(0,31).replace(/[\\/*?:\[\]]/g,'_') || 'Лист', n=1, unique=name;
    while (names.has(unique.toLowerCase())) {const suffix=' '+n++;unique=name.slice(0,31-suffix.length)+suffix;}
    names.add(unique.toLowerCase()); toWorksheet(book,sheet,unique);
  }
  return new Blob([await book.xlsx.writeBuffer()],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),30000);
}
