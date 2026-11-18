import {dialog,btn,esc} from './messages.mjs';
export const colorFamilies=[['neutral','Серый',0,0],['red','Красный',0,70],['orange','Оранжевый',28,82],['yellow','Жёлтый',48,85],['green','Зелёный',128,46],['teal','Бирюзовый',175,48],['blue','Синий',215,64],['purple','Фиолетовый',270,52],['pink','Розовый',330,62]];
function hex(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l),f=n=>{const k=(n+h/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};return '#'+f(0)+f(8)+f(4);}
export const shades=family=>[15,27,39,51,63,75,87,96].map(l=>hex(family[2],family[3],l));
export function chooseColor(title,current,apply){
 let family=colorFamilies[0];
 const el=dialog(title,`<p>Основной цвет</p><div class="tn-color-families">${colorFamilies.map(f=>btn('', 'color-family',`data-family="${f[0]}" class="tn-swatch" style="--swatch:${hex(f[2],f[3],51)}" aria-label="${f[1]}" title="${f[1]}"`)).join('')}</div><p data-family-label></p><div class="tn-color-shades"></div><div class="tn-tools">${btn('Белый','white')}${btn('Чёрный','black')}</div><p class="tn-hint">Выберите основной цвет, затем один из восьми оттенков — от тёмного до бледного.</p>`);
 const commit=async color=>{try{await apply(color);el.close();}catch(e){el.querySelector('[role=alert]').textContent=e.message||e;}};
 const draw=()=>{
  el.querySelector('[data-family-label]').textContent=family[1]+' · 8 оттенков';
  el.querySelectorAll('[data-family]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.family===family[0])));
  el.querySelector('.tn-color-shades').innerHTML=shades(family).map((color,i)=>btn('', 'color-shade',`data-color="${color}" class="tn-swatch" style="--swatch:${color}" aria-label="${family[1]} · оттенок ${i+1} из 8" title="${color}"`)).join('');
  el.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>commit(b.dataset.color));
 };
 el.querySelectorAll('[data-family]').forEach(b=>b.onclick=()=>{family=colorFamilies.find(f=>f[0]===b.dataset.family);draw();});
 el.querySelector('[data-action=white]').onclick=()=>commit('#ffffff');el.querySelector('[data-action=black]').onclick=()=>commit('#000000');
 const n=parseInt(String(current).slice(1),16);if(Number.isFinite(n))family=colorFamilies.reduce((best,f)=>{const c=parseInt(shades(f)[4].slice(1),16),dist=x=>Math.abs((x>>16)-(n>>16))+Math.abs(((x>>8)&255)-((n>>8)&255))+Math.abs((x&255)-(n&255));return dist(c)<dist(parseInt(shades(best)[4].slice(1),16))?f:best;},family);
 draw();return el;
}
export function colorField(name,value,label){return `<input type="hidden" name="${name}" value="${esc(value)}">${btn(esc(label),'pick-color',`data-color-field="${name}" class="tn-color-field" style="--swatch:${esc(value)}"`)}`;}
export function bindColorFields(el){el.querySelectorAll('[data-color-field]').forEach(b=>b.onclick=()=>{const input=el.querySelector('[name="'+b.dataset.colorField+'"]');chooseColor(b.textContent,input.value,color=>{input.value=color;b.style.setProperty('--swatch',color);});});}
