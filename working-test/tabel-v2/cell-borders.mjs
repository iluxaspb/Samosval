import {coords,cell,range,copy} from './table-domain.mjs';
export const BORDER_PRESETS=['all','outer','inner','horizontal','vertical','top','bottom','left','right','none'];
const names=['Top','Right','Bottom','Left'],opposite={Top:'Bottom',Bottom:'Top',Left:'Right',Right:'Left'},offset={Top:[-1,0],Bottom:[1,0],Left:[0,-1],Right:[0,1]};
export function borderLine({width=1,pattern='solid',color='#111111'}={}){
 if(![1,2,3,4].includes(Number(width))||!['solid','dashed','dotted','double'].includes(pattern)||!/^#[a-f0-9]{6}$/i.test(color))throw Error('Недопустимое оформление границы');
 return `${width}px ${pattern} ${color}`;
}
export function applyBorders(sheet,from,to,options={},keyFor=k=>k,dimensions=sheet){
 const {preset='all'}=options;if(!BORDER_PRESETS.includes(preset))throw Error('Неизвестный вид границ');
 const line=borderLine(options),none='0px solid transparent',a=coords(from),b=coords(to),top=Math.min(a.r,b.r),bottom=Math.max(a.r,b.r),left=Math.min(a.c,b.c),right=Math.max(a.c,b.c),next=copy(sheet);
 const write=(r,c,side,value)=>{if(r<0||c<0||r>=dimensions.rows||c>=dimensions.cols)return;const k=keyFor(cell(r,c));next.cells[k]={...next.cells[k],style:{...next.cells[k]?.style,['border'+side]:value}};};
 for(const k of range(from,to)){
  const p=coords(k);
  for(const side of names){
   const isOuter=side==='Top'?p.r===top:side==='Bottom'?p.r===bottom:side==='Left'?p.c===left:p.c===right;
   let value;
   if(preset==='all')value=line;
   if(preset==='none')value=none;
   if(preset==='outer')value=isOuter?line:none;
   if(preset==='inner'&&!isOuter)value=line;
   if(preset==='horizontal'&&['Top','Bottom'].includes(side)&&!isOuter)value=line;
   if(preset==='vertical'&&['Left','Right'].includes(side)&&!isOuter)value=line;
   if(preset===side.toLowerCase()&&isOuter)value=line;
   if(value===undefined)continue;
   write(p.r,p.c,side,value);
   // Collapsed table borders also depend on the neighbour's opposite edge.
   const [dr,dc]=offset[side];write(p.r+dr,p.c+dc,opposite[side],value);
  }
 }
 return next;
}

export function cssToExcelBorder(line){
 const raw=String(line||'');if(raw==='none'||/^0(?:px)?(?:\s|$)/.test(raw))return {};
 const width=Number.parseFloat(raw)||1,pattern=raw.match(/\b(solid|dashed|dotted|double)\b/)?.[1]||'solid',color=raw.match(/#[a-f0-9]{6}/i)?.[0]||'#555555';
 const style=pattern==='double'?'double':pattern==='dotted'?'dotted':pattern==='dashed'?(width>1?'mediumDashed':'dashed'):width>=3?'thick':width>=2?'medium':'thin';
 return {style,color:{argb:'FF'+color.slice(1).toUpperCase()}};
}
export function excelToCssBorder(style,color){const name=String(style).toLowerCase(),pattern=name==='double'?'double':name==='dotted'?'dotted':name.includes('dash')?'dashed':'solid',width=name==='double'||name==='thick'?3:name.includes('medium')?2:1;return width+'px '+pattern+' '+color;}
