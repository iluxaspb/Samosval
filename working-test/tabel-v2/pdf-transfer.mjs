import * as D from './table-domain.mjs';
import {esc,dialog,btn} from './messages.mjs';
import {download} from './file-transfer.mjs';
let loading;
async function library() {
  if(globalThis.html2pdf)return globalThis.html2pdf;
  return loading ||= new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL('../vendor/html2pdf-0.10.1.bundle.min.js',import.meta.url);
    script.onload=()=>resolve(globalThis.html2pdf);script.onerror=()=>{loading=null;script.remove();reject(Error('Не удалось загрузить модуль PDF'));};document.head.append(script);
  });
}
export async function preparePdf(sheet) {
  const el=dialog('Поделиться PDF','<p data-pdf-status>Подготавливается PDF…</p><div data-pdf-buttons></div>');
  let node;
  try {
    if(sheet.rows*sheet.cols>30000)throw Error('Для PDF выберите лист до 30 000 ячеек');
    const html2pdf=await library();
    node=document.createElement('div');node.style.cssText='width:1000px;background:white;color:#111;font:12px Arial';
    const groups=[];let current=[],width=0;
    for(let c=0;c<sheet.cols;c++){
      const w=Math.min(500,sheet.widths[c]||80);
      if(width+w>1000&&current.length){groups.push(current);current=[];width=0;}
      current.push(c);width+=w;
    }
    if(current.length)groups.push(current);
    const memo=new Map(),merges=(sheet.merges||[]).map(m=>{const [a,b]=m.split(':');return {a:D.coords(a),b:D.coords(b||a),master:a};});
    for(const cols of groups)for(let start=0;start<sheet.rows;start+=24){
      const section=document.createElement('section');
      section.style.cssText='padding:8px 0;break-after:page;page-break-after:always;font:12px Arial;color:#111;background:white';
      section.innerHTML='<h3>'+esc(sheet.name)+' · '+D.colName(cols[0])+'–'+D.colName(cols.at(-1))+' · '+(start+1)+'–'+Math.min(sheet.rows,start+24)+'</h3>';
      const table=document.createElement('table');table.style.cssText='border-collapse:collapse;table-layout:fixed;width:100%';
      table.innerHTML='<colgroup>'+cols.map(c=>'<col style="width:'+Math.min(500,sheet.widths[c]||80)+'px">').join('')+'</colgroup>';
      for(let r=start;r<Math.min(sheet.rows,start+24);r++){
        const tr=table.insertRow();
        for(const c of cols){
          const merge=merges.find(m=>r>=m.a.r&&r<=m.b.r&&c>=m.a.c&&c<=m.b.c);
          if(merge&&(r!==Math.max(start,merge.a.r)||c!==Math.max(cols[0],merge.a.c)))continue;
          const k=merge?.master||D.cell(r,c),cell=sheet.cells[k]||{},td=tr.insertCell();
          if(merge){td.colSpan=Math.min(cols.at(-1),merge.b.c)-c+1;td.rowSpan=Math.min(start+23,merge.b.r)-r+1;}
          td.style.cssText='border:1px solid #ccc;padding:4px;overflow-wrap:anywhere;white-space:pre-wrap';
          for(const key of ['background','color','fontWeight','fontStyle','fontSize','textAlign','border','borderTop','borderBottom','borderLeft','borderRight'])
            if(cell.style?.[key])td.style[key]=cell.style[key];
          const value=D.formula(sheet.cells,k,sheet,new Set(),memo);
          td.textContent=String(value);
          if(cell.numberFormat==='percent'&&typeof value==='number')td.textContent=D.fmt(value*100)+'%';
          if(cell.numberFormat==='2'&&typeof value==='number')td.textContent=value.toFixed(2);
        }
      }
      section.append(table);node.append(section);
    }
    if(node.lastChild)node.lastChild.style.breakAfter=node.lastChild.style.pageBreakAfter='auto';
    const fileName=sheet.name.replace(/[\\/:*?"<>|]/g,'_')+'.pdf';
    // Render one page at a time: a long table must not exceed the browser's canvas height.
    let pdf;
    for(const section of [...node.children]){
      if(!el.isConnected)return;
      section.style.width='1000px';section.style.breakAfter=section.style.pageBreakAfter='auto';
      const worker=html2pdf().set({margin:8,filename:fileName,html2canvas:{scale:1.5,backgroundColor:'#ffffff'},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(section).toCanvas();
      const canvas=await worker.get('canvas');
      if(!pdf){await worker.toPdf();pdf=await worker.get('pdf');while(pdf.internal.getNumberOfPages()>1)pdf.deletePage(pdf.internal.getNumberOfPages());pdf.setFillColor(255,255,255);pdf.rect(0,0,297,210,'F');}
      else pdf.addPage();
      const ratio=Math.min(281/canvas.width,194/canvas.height);
      pdf.addImage(canvas.toDataURL('image/jpeg',0.94),'JPEG',8,8,canvas.width*ratio,canvas.height*ratio);
      worker.get('container').then(container=>container?.parentNode?.remove());
    }
    const blob=pdf.output('blob');
    if(!el.isConnected)return;
    el.querySelector('[data-pdf-status]').textContent='PDF готов';
    el.querySelector('[data-pdf-buttons]').innerHTML=btn('Скачать PDF','download-pdf')+btn('Поделиться PDF','share-pdf');
    el.querySelector('[data-action=download-pdf]').onclick=()=>download(blob,fileName);
    el.querySelector('[data-action=share-pdf]').onclick=async()=>{
      const file=new File([blob],fileName,{type:'application/pdf'});
      try{if(navigator.canShare?.({files:[file]}))await navigator.share({files:[file]});else {download(blob,fileName);el.querySelector('[data-pdf-status]').textContent='PDF скачан. Отправьте его из папки загрузок';}}
      catch(e){el.querySelector('[data-pdf-status]').textContent=e.name==='AbortError'?'Отправка отменена':e.message;}
    };
  }catch(e){if(el.isConnected)el.querySelector('[data-pdf-status]').textContent=e.message;}
  finally{node?.remove();}
}
