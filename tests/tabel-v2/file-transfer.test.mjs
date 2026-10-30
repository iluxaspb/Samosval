import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fromWorksheet,toWorksheet,readExcel,writeExcel} from '../../test-app/tabel-v2/file-transfer.mjs';
import {selectionContains,userColors} from '../../test-app/tabel-v2/presence.mjs';
const require=createRequire(import.meta.url), E=require('../../test-app/vendor/exceljs-4.4.0.min.js');
globalThis.ExcelJS=E;
test('Excel round trip preserves formulas, rich styling, dates, merges and dimensions; edits override imported values',async()=>{
  const book=new E.Workbook(),ws=book.addWorksheet('Часы');
  ws.getCell('A1').value=5;ws.getCell('A2').value=7;
  ws.getCell('B1').value={formula:'SUM(A1:A2)',result:12};
  ws.getCell('B2').value={formula:'IF(A1>0,1,0)',result:1};
  ws.getCell('C1').value='Заголовок';ws.mergeCells('C1:D1');
  ws.getCell('A1').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF12AB34'}};
  ws.getCell('A1').font={bold:true,italic:true,size:14,name:'Arial',color:{argb:'FF102030'}};
  ws.getCell('A1').border={bottom:{style:'double',color:{argb:'FF998877'}}};
  ws.getCell('A2').numFmt='0.000';ws.getCell('C2').value=new Date('2026-10-29T00:00:00Z');ws.getCell('C2').numFmt='dd/mm/yyyy';
  ws.getCell('A4').value='Цвет темы';ws.getCell('A4').fill={type:'pattern',pattern:'solid',fgColor:{theme:4}};
  book.definedNames.add("'Часы'!$A$1",'Количество');
  ws.getColumn(1).width=24;ws.getRow(1).height=30;
  const bytes=await book.xlsx.writeBuffer();
  const sheets=await readExcel({name:'hours.xlsx',size:bytes.length,arrayBuffer:async()=>bytes});
  assert.equal(sheets[0].cells.B1.raw,'=SUM(A1:A2)');assert.equal(sheets[0].cells.A1.style.background,'#12AB34');
  assert.match(sheets[0].cells.A4.style.background,/^#[0-9a-f]{6}$/i);
  const blob=await writeExcel(sheets), restored=new E.Workbook();await restored.xlsx.load(await blob.arrayBuffer());
  const result=restored.worksheets[0];
  assert.equal(result.getCell('B2').formula,'IF(A1>0,1,0)');assert.equal(result.getCell('A1').border.bottom.style,'double');
  assert.equal(result.getCell('A1').font.size,14);assert.equal(result.getCell('A1').font.color.argb,'FF102030');
  assert.equal(result.getCell('A2').numFmt,'0.000');assert.equal(result.getCell('C2').value.toISOString(),'2026-10-29T00:00:00.000Z');
  assert.equal(result.getCell('A4').fill.fgColor.theme,4);assert.equal(restored.model.themes.theme1,sheets[0].excelThemes.theme1);
  assert(restored.model.definedNames.some(n=>n.name==='Количество'));
  assert.equal(result.getCell('D1').master.address,'C1');assert.equal(result.getColumn(1).width,24);assert.equal(result.getRow(1).height,30);
  sheets[0].cells.A1.raw='9';sheets[0].cells.A1.style.background='#abcdef';
  const changed=new E.Workbook();toWorksheet(changed,sheets[0]);
  assert.equal(changed.worksheets[0].getCell('A1').value,9);assert.equal(changed.worksheets[0].getCell('A1').fill.fgColor.argb,'FFABCDEF');
});
test('rejects unsupported extensions and oversized sheets without silently truncating',async()=>{
  await assert.rejects(readExcel({name:'old.xls'}),/\.xlsx/);
  const b=new E.Workbook(),ws=b.addWorksheet('Большой');ws.getCell('CW1').value=1;
  assert.throws(()=>fromWorksheet(ws),/100 столбцов/);
});
test('presence uses consistent distinct colors and includes only cells in the exact range',()=>{
  assert.deepEqual(userColors(['a','b','c']),userColors(['c','b','a']));
  assert.equal(new Set(Object.values(userColors(['a','b','c','d','e','f','g','h','i','j']))).size,10);
  assert(selectionContains({a:'D4',b:'B2'},'C3'));assert(!selectionContains({a:'B2',b:'D4'},'A3'));
  assert(!selectionContains({a:'invalid',b:'D4'},'A3'));
  assert(selectionContains({a:'B3',b:'B3',rowKeys:['water'],colKeys:['day:2026-10-29:day']},'M3','water','day:2026-10-29:day'));
  assert(!selectionContains({a:'B3',b:'B3',rowKeys:['water'],colKeys:['day:2026-10-29:day']},'B3','water','day:2026-10-12:day'));
});

test('new border styles export to Excel and import with matching width, pattern and colour',async()=>{
 const sheet={name:'Границы',rows:3,cols:3,widths:{},heights:{},cells:{A1:{raw:12,style:{borderTop:'3px dashed #2255aa',borderRight:'0px solid transparent'}},B1:{raw:13,style:{borderBottom:'3px double #111111'}},C1:{raw:14,style:{borderLeft:'1px dotted #aa2255'}}},merges:[]};
 const book=new E.Workbook(),ws=toWorksheet(book,sheet);assert.equal(ws.getCell('A1').border.top.style,'mediumDashed');assert.equal(ws.getCell('A1').border.right.style,undefined);assert.equal(ws.getCell('B1').border.bottom.style,'double');assert.equal(ws.getCell('C1').border.left.style,'dotted');
 const round=fromWorksheet(ws);assert.equal(round.cells.A1.raw,12);assert.equal(round.cells.A1.style.borderTop,'2px dashed #2255AA');assert.equal(round.cells.B1.style.borderBottom,'3px double #111111');
});
