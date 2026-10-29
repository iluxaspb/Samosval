// Formula bar highlighting is purely visual: the actual form input remains
// the source of truth, so caret, Android keyboard, IME and undo keep working.
export const FORMULA_REF_COLORS=["#2163c5","#b3448d","#19804b","#a35c12","#6a4dba"];
const rx=/"(?:[^"]|"")*"|\$?[A-Za-z]{1,4}\$?[1-9]\d*|(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?|[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё_0-9.]*|[()+\-*/^%:;,=<>!]|[^\s]|\s+/gy;
const cell=/^\$?[A-Z]{1,4}\$?[1-9]\d*$/i;
export function syntaxParts(raw){
  const source=String(raw??"");
  if(!source.startsWith("="))return [{text:source,kind:"plain"}];
  const parts=[],ids=new Map();
  let at=0;
  while(at<source.length){
    rx.lastIndex=at;
    const m=rx.exec(source);
    if(!m||m.index!==at){parts.push({text:source.slice(at),kind:"plain"});break;}
    const text=m[0];at=rx.lastIndex;
    const following=source.slice(at);
    let kind="plain";
    if(text.startsWith('"'))kind="string";
    else if(cell.test(text))kind="ref";
    else if(/^(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(text))kind="number";
    else if(/^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё_0-9.]*$/.test(text))
      kind=/^\s*\(/.test(following)?"function":"word";
    else if("()+-*/^%:;,=<>!".includes(text))kind="operator";
    const segment={text,kind};
    if(kind==="ref"){
      const id=text.replace(/\$/g,"").toUpperCase();
      if(!ids.has(id))ids.set(id,ids.size%FORMULA_REF_COLORS.length);
      segment.color=FORMULA_REF_COLORS[ids.get(id)];
    }
    parts.push(segment);
  }
  return parts;
}
export function formulaReferences(raw){
  const parts=syntaxParts(raw);
  const groups=[],seen=new Set();
  for(let i=0;i<parts.length;i++){
    if(parts[i].kind!=="ref")continue;
    let id=parts[i].text.replace(/\$/g,"").toUpperCase(),end=id;
    if(parts[i+1]?.text===":"&&parts[i+2]?.kind==="ref"){
      end=parts[i+2].text.replace(/\$/g,"").toUpperCase();
      i+=2;
    }
    const signature=id+":"+end;
    if(!seen.has(signature)){seen.add(signature);groups.push({from:id,to:end,color:parts[i].color||FORMULA_REF_COLORS[groups.length%FORMULA_REF_COLORS.length]});}
  }
  return groups;
}
