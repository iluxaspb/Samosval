export const uid=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
export const clone=x=>JSON.parse(JSON.stringify(x));
export const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
export const sources={text:'Свой текст',date:'Дата задания',number:'Номер документа',plate:'Госномер',driver:'Водитель',brand:'Марка',company:'Перевозчик',volume:'Объём кузова',sender:'Грузоотправитель',recipient:'Грузополучатель',material:'Материал',from:'Место погрузки',to:'Место выгрузки'};
const field=(label,source,x,y,w=60)=>({id:uid(),label,source,x,y,w,size:11,bold:false,align:'left',text:'',customKey:''});
export function initial(){return {version:1,trucks:[],templates:[{id:'ttn',name:'ТТН АБЗ',width:210,height:297,background:'assets/ttn.jpg',offsetX:0,offsetY:0,fields:[field('Дата','date',58,14,45),field('Номер заявки','number',145,14,45),field('Отправитель','sender',10,26,87),field('Получатель','recipient',108,26,87),field('Материал','material',51,44,140),field('Погрузка','from',35,99,65),field('Выгрузка','to',131,99,65),field('Перевозчик','company',35,182,158),field('Машина','brand',12,198,125),field('Госномер','plate',150,198,45),field('Водитель','driver',12,188,87)]}],settings:{haptic:true,theme:'light',step:.5,copies:1,nextNumber:1,dateFormat:'ru'},draft:{templateId:'ttn',date:today(),sender:'',recipient:'',material:'',from:'',to:''},jobs:[]}}
export function value(f,truck,job,settings){if(f.source==='text')return f.text||'';if(f.source==='custom')return truck.extra?.[f.customKey]||'';if(f.source==='date'){const d=job.date||today();return settings.dateFormat==='iso'?d:d.split('-').reverse().join('.')}return String(truck[f.source]??job[f.source]??'')}
export function makeJob(state,ids,date,copies){if(!ids.length)throw Error('Выбери хотя бы один самосвал');if(!Number.isInteger(copies)||copies<1||copies>20)throw Error('Количество копий: от 1 до 20');const template=state.templates.find(t=>t.id===state.draft.templateId);if(!template)throw Error('Выбери шаблон');const trucks=ids.map(id=>state.trucks.find(t=>t.id===id));if(trucks.some(t=>!t))throw Error('Машина удалена из базы');let number=state.settings.nextNumber;return {id:uid(),created:new Date().toISOString(),status:'prepared',date,template:clone(template),settings:clone(state.settings),pages:trucks.flatMap(truck=>{const data={...state.draft,date,number:number++};return Array.from({length:copies},(_,i)=>({truck:clone(truck),data:clone(data),copy:i+1}))}),nextNumber:number}}
export function validate(s){if(s?.version!==1||!Array.isArray(s.trucks)||!Array.isArray(s.templates)||!s.templates.length||!Array.isArray(s.jobs)||!s.settings||!s.draft)throw Error('Неизвестный формат резервной копии');if(s.trucks.length>10000||s.templates.length>100||s.jobs.length>500)throw Error('Слишком большая база');const num=(v,a,b)=>typeof v==='number'&&Number.isFinite(v)&&v>=a&&v<=b;for(const t of s.templates){if(!t.id||!num(t.width,50,240)||!num(t.height,50,500)||!Array.isArray(t.fields)||t.fields.length>200||!num(t.offsetX,-50,50)||!num(t.offsetY,-50,50))throw Error('Некорректный шаблон');if(t.background&&!/^data:image\/(png|jpeg|webp);base64,/.test(t.background)&&t.background!=='assets/ttn.jpg')throw Error('Недопустимый фон');for(const f of t.fields){if(!num(f.x,0,t.width)||!num(f.y,0,t.height)||!num(f.w,1,t.width)||!num(f.size,5,72)||!['left','center','right'].includes(f.align))throw Error('Некорректные поля')}}if(!Number.isInteger(s.settings.nextNumber)||s.settings.nextNumber<1||!['ru','iso'].includes(s.settings.dateFormat))throw Error('Некорректные настройки');for(const j of s.jobs){if(!Array.isArray(j.pages)||j.pages.length>200000||typeof j.date!=='string'||!j.settings)throw Error('Некорректное задание');validate({...s,templates:[j.template],jobs:[],settings:j.settings});for(const p of j.pages)if(!p.truck||!p.data)throw Error('Некорректная страница')}return s}
// Epson-compatible 24-pin 180 dpi mode from supplied HPR4915.GPD. Hardware validation required.
export function rasterBytes(rgba,width,height){
  const out=[27,64,27,116,1,27,54,27,82,0,27,91,48,37,116,27,108,1,13,27,91,51,57,33,112,27,51,24];
  for(let y=0;y<height;y+=24){
    const band=new Uint8Array(width*3);let usedWidth=0;
    for(let x=0;x<width;x++)for(let group=0;group<3;group++){
      let v=0;
      for(let bit=0;bit<8;bit++){
        const py=y+group*8+bit,idx=(py*width+x)*4;
        if(py<height&&rgba[idx+3]>128&&(.2126*rgba[idx]+.7152*rgba[idx+1]+.0722*rgba[idx+2])<150)v|=128>>bit;
      }
      band[x*3+group]=v;if(v)usedWidth=x+1;
    }
    // HPR4915.GPD: MasterUnits 360, XMoveUnit 60, ESC $ DestX/6.
    // At 180 dpi each horizontal unit is 3 pixels. Round the start down,
    // retaining up to two blank columns so ink never moves off its grid.
    // Keep the proven vertical line feeds unchanged.
    if(usedWidth){
      out.push(13);
      const occupied=x=>band[x*3]||band[x*3+1]||band[x*3+2];
      let cursor=0;
      while(cursor<usedWidth){
        while(cursor<usedWidth&&!occupied(cursor))cursor++;
        if(cursor===usedWidth)break;
        const start=Math.floor(cursor/3)*3;let last=cursor++;
        // Six blank columns cover a new header, position and rounding padding.
        while(cursor<usedWidth&&cursor-last<=6){if(occupied(cursor))last=cursor;cursor++}
        const count=last-start+1,position=start/3;
        if(position)out.push(27,36,position&255,position>>8);
        out.push(27,42,39,count&255,count>>8);
        for(let i=start*3;i<(last+1)*3;i++)out.push(band[i]);
      }
    }
    if(y+24<height)out.push(13,10);
  }
  out.push(12,27,64);return new Uint8Array(out);
}
