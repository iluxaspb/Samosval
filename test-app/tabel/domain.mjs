/* Isolated ledger domain. No Firebase, DOM, eval, or Line writes. */
export const VERSION = '1.1.0-test.1';
export const ACTIONS = ['table','settings','request','shift','people','equipment','materials','plans','report','history','permissions'];
export const clone = x => JSON.parse(JSON.stringify(x));
export const isoToday = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
export function date(s) {
  if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('Некорректная календарная дата');
  const d=new Date(s+'T12:00:00Z');
  if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)throw Error('Некорректная календарная дата');
  return s;
}
export function addDays(s,n){const d=new Date(date(s)+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
export const displayDate = s => date(s).split('-').reverse().join('.');
export function days(start,end){date(start);date(end);if(end<start)return [];const out=[];for(let d=start;d<=end;d=addDays(d,1)){if(out.length>=3660)throw Error('Период больше 10 лет. Выберите неделю.');out.push(d);}return out;}
export function monday(s){const d=new Date(date(s)+'T12:00:00Z');return addDays(s,-((d.getUTCDay()+6)%7));}
export function weeks(start,end){const out=[];for(let d=monday(start);d<=end;d=addDays(d,7))out.push({id:d,start:d<start?start:d,end:addDays(d,6)>end?end:addDays(d,6)});return out;}
export function number(raw,{max=1e8,empty=null}={}){const s=String(raw??'').trim().replace(',','.');if(!s)return empty;if(!/^\d+(?:\.\d{1,3})?$/.test(s)||Number(s)>max)throw Error('Введите неотрицательное число'+(max===24?' до 24 часов':''));return Number(s);}
export const hours = s => {const n=number(s,{max:24});return n===null?null:Math.round(n*60);};
export const fmt = n => n==null?'':Number(n.toFixed(3)).toLocaleString('ru-RU');
export function defaults(objectId,start=isoToday()){return {objectId,schemaVersion:1,deleted:false,startDate:date(start),endDate:'',period:'all',newSheet:'blank',allowedSheetTypes:['blank','template'],countEquipment:'roster',volumeSource:'manual',showHints:true,showTotals:true,colors:{},acl:{roles:{},users:{}},request:{date:addDays(isoToday(),1),equipment:[],people:[],note:'',lunch:{people:'',note:''}},works:[],materials:[]};}
export function can(actor,config,area,mode='view'){
  if(!actor?.uid||actor.status!=='active'||!actor.tabAccess)return false;
  if(actor.role==='admin')return true;
  const key=area+'.'+mode,acl=config?.acl;
  return !!actor.permissions?.[mode==='view'?'view':'edit']&&(acl?.users?.[actor.uid]?.[key]===true||acl?.roles?.[actor.role]?.[key]===true);
}
export const entryId = (kind,obj,day,shift,id) => [kind,obj,day,shift,id].map(encodeURIComponent).join('~');
export function blankEntry(kind,entity,object,day,shift='day',equipmentId=''){
  return {kind,entityId:entity.id,name:entity.name,group:entity.group||'',ownership:entity.ownership||'',contractor:entity.contractor||'',objectId:object.id,objectName:object.name,date:date(day),shift,scope:encodeURIComponent(object.id)+'|'+day.slice(0,7),minutes:null,idleMinutes:0,status:'unfilled',equipmentId,note:'',deleted:false};
}
export function tone(name){name=String(name).toLowerCase().replace(/ё/g,'е');if(/полив|водовоз/.test(name))return '#a4c2f4';if(/щет|трактор|муп/.test(name))return '#bf9000';if(/фрез|w205/.test(name))return '#00ffff';if(/xcmg/.test(name))return '#8e7cc3';if(/погруз/.test(name))return '#3c78d8';if(/паз|автобус/.test(name))return '#d9d2e9';return '#a4c2f4';}
export function linkedRows(entries,equipment,materials,config){
  const active=entries.filter(x=>!x.deleted),catalog=new Map(equipment.map(x=>[x.id,x]));
  const machines=[...new Map(active.filter(x=>x.kind==='equipment').map(x=>[x.entityId,{...catalog.get(x.entityId),...x}])).values()];
  const sections=[];const section=(label)=>sections.push({id:'section:'+label,label,section:true,color:'#000000'});
  section('Своя техника');
  for(const m of machines.filter(x=>x.ownership!=='hired')){
    sections.push({id:'equipment:'+m.entityId,label:m.name,kind:'equipment',entityId:m.entityId,color:tone(m.name)});
    sections.push({id:'crew:'+m.entityId,label:'Машинисты / водитель — часы',kind:'crew',entityId:m.entityId,color:tone(m.name),computed:true});
  }
  section('Поступление');
  for(const m of [...new Map(materials.filter(x=>!x.deleted).map(x=>[x.material+'|'+x.unit+'|'+x.supplier,x])).values()])sections.push({id:'receipt:'+m.material+'|'+m.unit+'|'+m.supplier,label:m.material+' ('+m.unit+') · '+m.supplier,kind:'receipt',entityId:m.material+'|'+m.unit+'|'+m.supplier,color:'#ffd966',computed:true});
  machines.filter(x=>x.ownership==='hired').forEach(m=>sections.push({id:'equipment:'+m.entityId,label:m.name,kind:'equipment',entityId:m.entityId,color:'#ffd966'}));
  config.materials.filter(m=>m.section==='receipt').forEach(m=>sections.push({id:'material:'+m.id,label:m.name+' ('+m.unit+')',kind:'material',entityId:m.id,color:'#ffd966'}));
  section('Гранулят');
  config.materials.filter(m=>m.section!=='receipt').forEach((m,i)=>sections.push({id:'material:'+m.id,label:m.name+' · '+m.direction+' ('+m.unit+')',kind:'material',entityId:m.id,color:['#ff9900','#ffff00','#00ff00'][i%3]}));
  section('Объём работ');config.works.forEach(w=>sections.push({id:'work:'+w.id,label:w.name+' ('+w.unit+')',kind:'work',entityId:w.id,color:'#a4c2f4'}));
  for(const [group,label] of [['itr','ИТР'],['worker','Рабочие']]){section(label);const seen=new Set();for(const r of active.filter(x=>x.kind==='person'&&x.group===group)){if(seen.has(r.entityId))continue;seen.add(r.entityId);sections.push({id:'person:'+r.entityId,label:r.name,kind:'person',entityId:r.entityId,color:'#fce5cd'});}}
  return sections;
}
export function linkedValue(row,day,shift,entries,values,materials=[]){
  const list=entries.filter(x=>!x.deleted&&x.date===day&&x.shift===shift);
  if(row.kind==='receipt'){const receipts=materials.filter(x=>!x.deleted&&x.date===day&&x.shift===shift&&x.material+'|'+x.unit+'|'+x.supplier===row.entityId);return receipts.length?fmt(receipts.reduce((n,x)=>n+x.quantity,0)):'';}
  if(row.kind==='crew'){const crew=list.filter(x=>x.kind==='person'&&x.equipmentId===row.entityId&&x.group==='operator');return crew.length&&crew.every(x=>x.minutes!==null)?fmt(crew.reduce((n,x)=>n+x.minutes,0)/60):'';}
  if(['person','equipment'].includes(row.kind)){const r=list.find(x=>x.kind===row.kind&&x.entityId===row.entityId);return !r?'':r.status==='unfilled'?'':r.status==='off'?'В':r.status==='absent'?'НЯ':fmt((r.minutes||0)/60);}
  return fmt(values.find(x=>!x.deleted&&x.date===day&&x.shift===shift&&x.kind===row.kind&&x.entityId===row.entityId)?.quantity??null);
}
export function normalizePlate(p){const value=String(p||'').toUpperCase().replace(/[АВЕКМНОРСТУХ]/g,c=>({'А':'A','В':'B','Е':'E','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','У':'Y','Х':'X'}[c])).replace(/[^A-Z0-9]/g,'');return value.match(/[ABEKMHOPCTYX]\d{3}[ABEKMHOPCTYX]{2}\d{2,3}/)?.[0]||value;}
export function equipmentCount(entries,line,{countEquipment='roster'}={}){
  const items=[];
  for(const e of entries.filter(x=>!x.deleted&&x.kind==='equipment'&&(countEquipment!=='hours'||x.minutes>0)))items.push({id:e.entityId,plate:normalizePlate(e.plate||e.name)});
  for(const t of line.filter(x=>x.arrived&&!x.isGAI))items.push({id:t.id,plate:normalizePlate(t.plate||t.name)});
  // Union on either stable ID or normalized registration, including bridge records.
  const groups=[];for(const item of items){const matches=groups.filter(g=>g.ids.has(item.id)||(item.plate&&g.plates.has(item.plate)));const g=matches.shift()||{ids:new Set(),plates:new Set()};g.ids.add(item.id);if(item.plate)g.plates.add(item.plate);for(const other of matches){other.ids.forEach(x=>g.ids.add(x));other.plates.forEach(x=>g.plates.add(x));groups.splice(groups.indexOf(other),1);}if(!groups.includes(g))groups.push(g);}return groups.length;
}
export function report({object,day,entries,values,config,line}){
  const list=entries.filter(x=>!x.deleted&&x.date===day),works=config.works.map(w=>{const v=values.filter(x=>!x.deleted&&x.kind==='work'&&x.entityId===w.id&&x.date===day);return '— '+w.name+': '+(v.length?fmt(v.reduce((n,x)=>n+x.quantity,0))+' '+w.unit:'не заполнено');});
  const count=g=>{const rows=list.filter(x=>x.kind==='person'&&x.group===g);return rows.length?new Set(rows.filter(x=>x.status==='work'&&x.minutes>0).map(x=>x.entityId)).size+' (незаполнено: '+rows.filter(x=>x.status==='unfilled').length+')':'не заполнено';};
  return `Отчёт за ${displayDate(day)}\nОбъект: ${object.name}\nВыполненные работы:\n${works.join('\n')||'не заполнено'}\nИТР: ${count('itr')}\nРабочие: ${count('worker')}\nТехника: ${list.some(x=>x.kind==='equipment')||line.rows.length?equipmentCount(list,line.rows,config)+' ед.':'не заполнено'}${line.complete?'':'\nИсточник «Линия»: неполная история прибытий — итог требует проверки'}${line.note?'\n'+line.note:''}`;
}
export function requestText(object,config,people,equipment){const r=config.request;return `Заявка на ${displayDate(r.date)}\nОбъект: ${object.name}\nТехника:\n${r.equipment.map(x=>'— '+(equipment.find(e=>e.id===x)?.name||x)).join('\n')||'не выбрана'}\nЛюди:\n${r.people.map(x=>'— '+(people.find(p=>p.id===x)?.name||x)).join('\n')||'не выбраны'}\n${r.note}`;}
export function lunchText(object,config,today=isoToday()){return `Заказ обеда на ${displayDate(addDays(today,1))}\nОбъект: ${object.name}\nКоличество: ${config.request.lunch.people||'не заполнено'}\n${config.request.lunch.note}`;}
export const columnName = n => {let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
export function coordinates(ref){const m=/^([A-Z]+)([1-9]\d*)$/i.exec(ref);if(!m)throw Error('#ССЫЛКА!');let c=0;for(const s of m[1].toUpperCase())c=c*26+s.charCodeAt(0)-64;return {row:Number(m[2])-1,col:c-1};}
export const address = (row,col)=>columnName(col)+(row+1);
export function range(a,b){const p=coordinates(a),q=coordinates(b),out=[];if(Math.abs(p.row-q.row)*Math.abs(p.col-q.col)>10000)throw Error('Слишком большой диапазон');for(let r=Math.min(p.row,q.row);r<=Math.max(p.row,q.row);r++)for(let c=Math.min(p.col,q.col);c<=Math.max(p.col,q.col);c++){if(out.length>=10000)throw Error('Слишком большой диапазон');out.push(address(r,c));}return out;}
export function evaluate(cells,key,limits={rows:1000,cols:100},stack=new Set(),memo=new Map()){
  if(memo.has(key))return memo.get(key);if(stack.has(key))return '#ЦИКЛ!';if(stack.size>150)return '#ГЛУБИНА!';
  const pos=coordinates(key);if(pos.row>=limits.rows||pos.col>=limits.cols)return '#ССЫЛКА!';
  const raw=String(cells[key]?.raw??'');if(!raw.startsWith('='))return raw===''?'':/^\d+(?:[.,]\d+)?$/.test(raw)?Number(raw.replace(',','.')):raw;
  stack.add(key);let result;
  try{
    let src=raw.slice(1).toUpperCase().replace(/СУММ/g,'SUM').replace(/−/g,'-');
    const tokens=src.match(/\s+|\d+(?:[.,]\d+)?|[A-Z]+[1-9]\d*|SUM|[()+\-*/:,]/g)||[];
    if(tokens.join('')!==src||tokens.length>1000)throw Error('#ФОРМУЛА!');const t=tokens.filter(x=>!/^\s+$/.test(x));let at=0;
    const numeric=x=>{if(x==='')return 0;if(typeof x!=='number'||!Number.isFinite(x))throw Error(String(x).startsWith('#')?x:'#ЗНАЧ!');return x;};
    const ref=k=>numeric(evaluate(cells,k,limits,new Set(stack),memo));
    function atom(){const token=t[at++];if(token==='+'||token==='-')return (token==='-'?-1:1)*atom();if(token==='('){const v=expr();if(t[at++]!==')')throw Error('#ФОРМУЛА!');return v;}if(token==='SUM'){if(t[at++]!=='(')throw Error('#ФОРМУЛА!');const a=t[at++];if(t[at++]!==':')throw Error('#ФОРМУЛА!');const b=t[at++];if(t[at++]!==')')throw Error('#ФОРМУЛА!');return range(a,b).reduce((n,k)=>n+ref(k),0);}if(/^[A-Z]+\d+$/.test(token||''))return ref(token);if(/^\d+(?:[.,]\d+)?$/.test(token||''))return Number(token.replace(',','.'));throw Error('#ФОРМУЛА!');}
    function term(){let v=atom();while(t[at]==='*'||t[at]==='/'){const op=t[at++],n=atom();if(op==='/'&&n===0)throw Error('#ДЕЛ/0!');v=op==='*'?v*n:v/n;}return v;}
    function expr(){let v=term();while(t[at]==='+'||t[at]==='-'){const op=t[at++],n=term();v=op==='+'?v+n:v-n;}return v;}
    result=expr();if(at!==t.length||!Number.isFinite(result))throw Error('#ФОРМУЛА!');
  }catch(e){result=e.message.startsWith('#')?e.message:'#ФОРМУЛА!';}stack.delete(key);memo.set(key,result);return result;
}
export function shiftFormula(raw,dr,dc){return String(raw).startsWith('=')?raw.replace(/\b([A-Z]+[1-9]\d*)\b/gi,ref=>{const p=coordinates(ref);return p.row+dr<0||p.col+dc<0?'#ССЫЛКА!':address(p.row+dr,p.col+dc);}):raw;}
export function autofill(cells,from,to){const source=coordinates(from),target=coordinates(to),seed=cells[from]||{raw:''};for(const k of range(from,to)){const p=coordinates(k);cells[k]={...clone(seed),raw:shiftFormula(seed.raw,p.row-source.row,p.col-source.col)};}return cells;}
