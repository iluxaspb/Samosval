import {coords,cell,range,copy} from './table-domain.mjs';
function normalized(a,b){const x=coords(a),y=coords(b);return cell(Math.min(x.r,y.r),Math.min(x.c,y.c))+':'+cell(Math.max(x.r,y.r),Math.max(x.c,y.c));}
export function intersectingMerges(sheet,a,b){const selected=new Set(range(a,b));return (sheet.merges||[]).filter(m=>{const [x,y=x]=m.split(':');return range(x,y).some(k=>selected.has(k));});}
export function mergeCells(sheet,a,b){
 const name=normalized(a,b),[first,last]=name.split(':'),keys=range(first,last),limit=coords(last);
 if(keys.length<2)throw Error('Выделите несколько ячеек');
 if(limit.r>=sheet.rows||limit.c>=sheet.cols)throw Error('Выделение выходит за границы листа');
 if(intersectingMerges(sheet,first,last).length)throw Error('Сначала разъедините пересекающиеся объединённые ячейки');
 if(keys.slice(1).some(k=>sheet.cells?.[k]?.raw!==undefined&&sheet.cells[k].raw!==null&&String(sheet.cells[k].raw)!==''))throw Error('В соседних ячейках есть значения. Перенесите их перед объединением: данные не изменены');
 const next=copy(sheet);next.merges=[...(next.merges||[]),name];return {sheet:next,first,last};
}
export function unmergeCells(sheet,a,b){const found=new Set(intersectingMerges(sheet,a,b));if(!found.size)throw Error('В выделении нет объединённых ячеек');const next=copy(sheet);next.merges=(next.merges||[]).filter(m=>!found.has(m));return next;}
