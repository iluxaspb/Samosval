// Safe local spreadsheet formula evaluator. No eval, network, or dynamic code.
// Supports arithmetic, cell/range refs, rounding, aggregates, conditional math.
const aliases = {
  "СУМ":"SUM","СУММ":"SUM","СУММА":"SUM",
  "СРЗНАЧ":"AVERAGE","СРЗНАЧА":"AVERAGE","МИН":"MIN","МАКС":"MAX",
  "СЧЁТ":"COUNT","СЧЕТ":"COUNT","СЧЁТЗ":"COUNTA","СЧЕТЗ":"COUNTA",
  "ОКРУГЛ":"ROUND","ОКРУГЛВВЕРХ":"ROUNDUP","ОКРУГЛВНИЗ":"ROUNDDOWN",
  "ЦЕЛОЕ":"INT","ОТБР":"TRUNC","ОСТАТ":"MOD","СТЕПЕНЬ":"POWER",
  "КОРЕНЬ":"SQRT","ПРОИЗВЕД":"PRODUCT","СУММКВ":"SUMSQ",
  "МЕДИАНА":"MEDIAN","ЕСЛИ":"IF","ЕСЛИОШИБКА":"IFERROR",
  "И":"AND","ИЛИ":"OR","НЕ":"NOT",
  "СЛЧИС":"RAND","СЛУЧМЕЖДУ":"RANDBETWEEN",
  "ЧАСТНОЕ":"QUOTIENT","ФАКТР":"FACT","НОД":"GCD","НОК":"LCM",
  "ЛОГ":"LOG","ЛОГ10":"LOG10","ЛН":"LN","ЭКСП":"EXP",
  "СИН":"SIN","КОС":"COS","ТАН":"TAN",
  "ГРАДУСЫ":"DEGREES","РАДИАНЫ":"RADIANS",
  "СУММЕСЛИ":"SUMIF","СЧЁТЕСЛИ":"COUNTIF","СЧЕТЕСЛИ":"COUNTIF",
  "СРЗНАЧЕСЛИ":"AVERAGEIF","СУММЕСЛИМН":"SUMIFS","СЧЁТЕСЛИМН":"COUNTIFS","СЧЕТЕСЛИМН":"COUNTIFS",
  "СУММПРОИЗВ":"SUMPRODUCT"
};
const EPS = 1e-10;
const error = code => {throw Error(code);};
function lex(source) {
  // Semicolon/translated formulas use Russian decimal commas. English
  // formulas use commas as argument separators, e.g. ROUND(1.25,2).
  const russian = /[А-ЯЁ]|;/.test(source.toUpperCase());
  const src = (russian ? source.replace(/(\d),(\d)/g,"$1.$2") : source)
    .replace(/\$/g,"").replace(/\u2212/g,"-");
  const tokens = [], re = /\s+|"(?:[^"]|"")*"|(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?|[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё_0-9.]*|(?:<=|>=|<>|!=)|[()+\-*/^%:,;=<>]/gy;
  let at=0, m;
  while(at<src.length) {
    re.lastIndex=at;
    m=re.exec(src);
    if(!m || m.index!==at)error("#ФОРМУЛА!");
    at=re.lastIndex;
    if(!/^\s+$/.test(m[0]))tokens.push(m[0]);
    if(tokens.length>600)error("#ФОРМУЛА!");
  }
  return tokens;
}
function parse(source) {
  const t=lex(source), len=t.length;
  let i=0, depth=0;
  const peek=()=>t[i], pop=()=>t[i++], expect=s=>{if(pop()!==s)error("#ФОРМУЛА!");};
  const node=(type,a,b)=>({type,a,b});
  function primary(){
    if(++depth>120)error("#ГЛУБИНА!");
    try {
      const v=pop();
      if(v===undefined)error("#ФОРМУЛА!");
      if(v==="("){const x=comparison();expect(")");return x;}
      if(v[0]==='"')return node("text",v.slice(1,-1).replace(/""/g,'"'));
      if(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(v))
        return node("number",Number(v));
      if(/^[A-Z]+[1-9]\d*$/i.test(v)){
        if(peek()===":"){pop();const to=pop();if(!/^[A-Z]+[1-9]\d*$/i.test(to||""))error("#ССЫЛКА!");return node("range",v.toUpperCase(),to.toUpperCase());}
        return node("ref",v.toUpperCase());
      }
      if(/^[A-ZА-ЯЁ_][A-ZА-ЯЁ_0-9.]*$/i.test(v)){
        const name=aliases[v.toUpperCase()]||v.toUpperCase();
        if(name==="TRUE" || name==="ИСТИНА")return node("number",1);
        if(name==="FALSE" || name==="ЛОЖЬ")return node("number",0);
        if(peek()!=="(")error("#ИМЯ?");
        pop();const args=[];
        if(peek()!==")"){
          while(true){
            args.push(comparison());
            if(peek()!==";"&&peek()!==",")break;
            pop();
            if(args.length>200)error("#ФОРМУЛА!");
          }
        }
        expect(")");
        return node("func",name,args);
      }
      error("#ФОРМУЛА!");
    }finally{depth--;}
  }
  function unary(){
    if(peek()==="+"||peek()==="-"){const op=pop();return node(op==="-"?"neg":"pos",unary());}
    return percent();
  }
  function percent(){let n=primary();while(peek()==="%"){pop();n=node("percent",n);}return n;}
  function power(){let n=unary();if(peek()==="^"){pop();n=node("pow",n,power());}return n;}
  function multiplication(){let n=power();while(peek()==="*"||peek()==="/"){const op=pop();n=node(op==="*"?"mul":"div",n,power());}return n;}
  function addition(){let n=multiplication();while(peek()==="+"||peek()==="-"){const op=pop();n=node(op==="+"?"add":"sub",n,multiplication());}return n;}
  function comparison(){let n=addition();while(["=","<>","!=","<",">","<=",">="].includes(peek())){const op=pop();n=node("compare",op,[n,addition()]);}return n;}
  const tree=comparison();if(i!==len)error("#ФОРМУЛА!");return tree;
}
function numeric(v) {
  if(v===null || v==="")return 0;
  if(typeof v==="boolean")return v?1:0;
  if(typeof v==="number" && Number.isFinite(v))return v;
  error(typeof v==="string"&&v.startsWith("#")?v:"#ЗНАЧ!");
}
const flatten=items=>items.flatMap(x=>Array.isArray(x)?flatten(x):[x]);
const nums=(items,skipText=true)=>flatten(items).filter(x=>x!==null&&x!=="").flatMap(x=>{
  if(typeof x==="number" && Number.isFinite(x))return [x];
  if(skipText)return [];
  return [numeric(x)];
});
function round(n,d,mode="nearest"){
  n=numeric(n);d=Math.trunc(numeric(d));
  if(d>15||d< -15)error("#ЧИСЛО!");
  const p=10**d,scaled=Math.abs(n)*p;
  const result=mode==="up"?Math.ceil(scaled-EPS):mode==="down"?Math.floor(scaled+EPS):Math.floor(scaled+0.5+EPS);
  return Math.sign(n)*result/p;
}
const avg=n=>{if(!n.length)error("#ДЕЛ/0!");return n.reduce((a,b)=>a+b,0)/n.length;};
const prod=n=>n.reduce((a,b)=>a*b,1);
const fact=n=>{n=numeric(n);if(n<0||n>170)error("#ЧИСЛО!");let v=1;for(let j=2;j<=Math.floor(n);j++)v*=j;return v;};
function gcd(a,b){a=Math.abs(Math.trunc(a));b=Math.abs(Math.trunc(b));while(b)[a,b]=[b,a%b];return a;}
const matchesCriteria=(value,criterion)=>{
  const source=String(criterion??"");
  const m=/^(<=|>=|<>|!=|=|<|>)(.*)$/.exec(source);
  const op=m?.[1]||"=",right=(m?m[2]:source).trim();
  const rightNum=right!==""?Number(right.replace(",",".")):null;
  const compareNumeric=typeof value==="number" && Number.isFinite(rightNum);
  const a=compareNumeric?value:String(value??"").toLocaleLowerCase();
  const b=compareNumeric?rightNum:right.toLocaleLowerCase();
  if(op==="=")return a===b;
  if(op==="<>"||op==="!=")return a!==b;
  if(op==="<")return a<b;if(op===">")return a>b;
  if(op==="<=")return a<=b;if(op===">=")return a>=b;
  return false;
};
const functions={
  SUM:a=>nums(a).reduce((x,y)=>x+y,0),SUMSQ:a=>nums(a).reduce((x,y)=>x+y*y,0),
  PRODUCT:a=>prod(nums(a)),AVERAGE:a=>avg(nums(a)),
  MIN:a=>{const x=nums(a);return x.length?Math.min(...x):0;},
  MAX:a=>{const x=nums(a);return x.length?Math.max(...x):0;},
  COUNTIF:a=>{const data=flatten([a[0]]);return data.filter(v=>matchesCriteria(v,a[1])).length;},
  SUMIF:a=>{const data=flatten([a[0]]),sum=flatten([a[2]??a[0]]);return data.reduce((total,v,i)=>total+(matchesCriteria(v,a[1])&&typeof sum[i]==="number"?sum[i]:0),0);},
  AVERAGEIF:a=>{const data=flatten([a[0]]),sum=flatten([a[2]??a[0]]);return avg(data.flatMap((v,i)=>matchesCriteria(v,a[1])&&typeof sum[i]==="number"?[sum[i]]:[]));},
  COUNTIFS:a=>{
    if(!a.length||a.length%2)error("#АРГУМ!");
    const first=flatten([a[0]]);
    return first.filter((_,i)=>a.every((arg,j)=>j%2===1||matchesCriteria(flatten([arg])[i],a[j+1]))).length;
  },
  SUMIFS:a=>{
    if(a.length<3||a.length%2===0)error("#АРГУМ!");
    const sums=flatten([a[0]]);
    return sums.reduce((total,v,i)=>total+(typeof v==="number"&&a.slice(1).every((arg,j)=>j%2===1||matchesCriteria(flatten([arg])[i],a[j+2]))?v:0),0);
  },
  SUMPRODUCT:a=>{
    const arrays=a.map(x=>flatten([x])),len=arrays[0]?.length||0;
    if(arrays.some(x=>x.length!==len))error("#ЗНАЧ!");
    return Array.from({length:len},(_,i)=>arrays.reduce((m,x)=>m*(typeof x[i]==="number"?x[i]:0),1)).reduce((v,w)=>v+w,0);
  },
  COUNT:a=>nums(a).length,COUNTA:a=>flatten(a).filter(x=>x!==""&&x!==null).length,
  MEDIAN:a=>{const n=nums(a).sort((x,y)=>x-y);if(!n.length)error("#ЧИСЛО!");return (n[(n.length-1)>>1]+n[n.length>>1])/2;},
  ROUND:a=>round(a[0],a[1]??0),ROUNDUP:a=>round(a[0],a[1]??0,"up"),
  ROUNDDOWN:a=>round(a[0],a[1]??0,"down"),TRUNC:a=>round(a[0],a[1]??0,"down"),
  INT:a=>Math.floor(numeric(a[0])),ABS:a=>Math.abs(numeric(a[0])),
  SIGN:a=>Math.sign(numeric(a[0])),
  MOD:a=>{const x=numeric(a[0]),y=numeric(a[1]);if(!y)error("#ДЕЛ/0!");return ((x%y)+y)%y;},
  QUOTIENT:a=>{const x=numeric(a[0]),y=numeric(a[1]);if(!y)error("#ДЕЛ/0!");return Math.trunc(x/y);},
  POWER:a=>numeric(a[0])**numeric(a[1]),SQRT:a=>Math.sqrt(numeric(a[0])),
  SQRTPI:a=>Math.sqrt(numeric(a[0])*Math.PI),EXP:a=>Math.exp(numeric(a[0])),
  LN:a=>Math.log(numeric(a[0])),LOG10:a=>Math.log10(numeric(a[0])),
  LOG:a=>Math.log(numeric(a[0]))/Math.log(numeric(a[1]??10)),
  PI:a=>Math.PI,DEGREES:a=>numeric(a[0])*180/Math.PI,
  RADIANS:a=>numeric(a[0])*Math.PI/180,
  SIN:a=>Math.sin(numeric(a[0])),COS:a=>Math.cos(numeric(a[0])),
  TAN:a=>Math.tan(numeric(a[0])),ASIN:a=>Math.asin(numeric(a[0])),
  ACOS:a=>Math.acos(numeric(a[0])),ATAN:a=>Math.atan(numeric(a[0])),
  ATAN2:a=>Math.atan2(numeric(a[1]),numeric(a[0])),
  SINH:a=>Math.sinh(numeric(a[0])),COSH:a=>Math.cosh(numeric(a[0])),
  TANH:a=>Math.tanh(numeric(a[0])),
  CEILING:a=>{const n=numeric(a[0]),s=Math.abs(numeric(a[1]??1));if(!s)error("#ДЕЛ/0!");return Math.ceil(n/s)*s;},
  FLOOR:a=>{const n=numeric(a[0]),s=Math.abs(numeric(a[1]??1));if(!s)error("#ДЕЛ/0!");return Math.floor(n/s)*s;},
  MROUND:a=>{const n=numeric(a[0]),s=numeric(a[1]);if(!s)return 0;if(n*s<0)error("#ЧИСЛО!");return round(n/s,0)*s;},
  EVEN:a=>{const n=numeric(a[0]);return Math.sign(n)*Math.ceil(Math.abs(n)/2)*2;},
  ODD:a=>{const n=numeric(a[0]);return Math.sign(n)*(Math.ceil((Math.abs(n)+1)/2)*2-1);},
  FACT:a=>fact(a[0]),FACTDOUBLE:a=>{const n=Math.floor(numeric(a[0]));if(n<0||n>300)error("#ЧИСЛО!");let v=1;for(let j=n;j>1;j-=2)v*=j;return v;},
  COMBIN:a=>{const n=Math.floor(numeric(a[0])),k=Math.floor(numeric(a[1]));if(n<0||k<0||k>n||n>170)error("#ЧИСЛО!");let v=1;for(let i=1;i<=Math.min(k,n-k);i++)v=v*(n-i+1)/i;return Math.round(v);},
  PERMUT:a=>{const n=Math.floor(numeric(a[0])),k=Math.floor(numeric(a[1]));if(n<0||k<0||k>n||n>170)error("#ЧИСЛО!");let v=1;for(let i=n-k+1;i<=n;i++)v*=i;return v;},
  GCD:a=>nums(a).reduce(gcd,0),
  LCM:a=>nums(a).reduce((x,y)=>x===0||y===0?0:Math.abs(x*y)/gcd(x,y),1),
  LARGE:a=>{const n=nums([a[0]]).sort((x,y)=>y-x),k=numeric(a[1]);if(k<1||k>n.length||k%1)error("#ЧИСЛО!");return n[k-1];},
  SMALL:a=>{const n=nums([a[0]]).sort((x,y)=>x-y),k=numeric(a[1]);if(k<1||k>n.length||k%1)error("#ЧИСЛО!");return n[k-1];},
  STDEV:a=>{const n=nums(a);if(n.length<2)error("#ДЕЛ/0!");const mean=avg(n);return Math.sqrt(n.reduce((x,y)=>x+(y-mean)**2,0)/(n.length-1));},
  "STDEV.P":a=>{const n=nums(a);if(!n.length)error("#ДЕЛ/0!");const mean=avg(n);return Math.sqrt(n.reduce((x,y)=>x+(y-mean)**2,0)/n.length);},
  VAR:a=>{const v=functions.STDEV(a);return v*v;},
  "VAR.P":a=>{const v=functions["STDEV.P"](a);return v*v;},
  RAND:()=>Math.random(),RANDBETWEEN:a=>{const lo=Math.ceil(numeric(a[0])),hi=Math.floor(numeric(a[1]));if(hi<lo)error("#ЧИСЛО!");return lo+Math.floor(Math.random()*(hi-lo+1));}
};
const expected = {PI:[0,0],RAND:[0,0],IF:[2,3],IFERROR:[2,2],IFNA:[2,2],NOT:[1,1],
  ROUND:[1,2],ROUNDUP:[1,2],ROUNDDOWN:[1,2],TRUNC:[1,2],LOG:[1,2],
  COUNTIF:[2,2],SUMIF:[2,3],AVERAGEIF:[2,3],
  CEILING:[1,2],FLOOR:[1,2],
  POWER:[2,2],MOD:[2,2],MROUND:[2,2],QUOTIENT:[2,2],
  RANDBETWEEN:[2,2],COMBIN:[2,2],PERMUT:[2,2],LARGE:[2,2],SMALL:[2,2],ATAN2:[2,2]};
export function evaluateWorkbookFormula(cells,key,size,stack,memo,coords,range) {
  if(memo.has(key))return memo.get(key);
  if(stack.has(key))return "#ЦИКЛ!";
  if(stack.size>100)return "#ГЛУБИНА!";
  const p=coords(key);
  if(p.r>=size.rows || p.c>=size.cols)return "#ССЫЛКА!";
  const raw=String(cells[key]?.raw??"");
  if(!raw.startsWith("="))return /^-?\d+(?:[.,]\d+)?$/.test(raw)?Number(raw.replace(",",".")):raw;
  stack.add(key);let result;
  try {
    const tree=parse(raw.slice(1));
    const ref=(name)=>{
      const k=name.toUpperCase(),loc=coords(k);
      if(loc.r>=size.rows||loc.c>=size.cols)error("#ССЫЛКА!");
      const value=evaluateWorkbookFormula(cells,k,size,new Set(stack),memo,coords,range);
      if(typeof value==="string"&&value.startsWith("#"))error(value);
      return value;
    };
    const compute=(n)=>{
      switch(n.type){
        case "number":case "text":return n.a;
        case "ref":return ref(n.a);
        case "range":{
          const keys=range(n.a,n.b);
          if(keys.length>10000)error("#ССЫЛКА!");
          return keys.map(ref);
        }
        case "neg":return -numeric(compute(n.a));
        case "pos":return numeric(compute(n.a));
        case "percent":return numeric(compute(n.a))/100;
        case "add":return numeric(compute(n.a))+numeric(compute(n.b));
        case "sub":return numeric(compute(n.a))-numeric(compute(n.b));
        case "mul":return numeric(compute(n.a))*numeric(compute(n.b));
        case "div":{const x=numeric(compute(n.a)),y=numeric(compute(n.b));if(!y)error("#ДЕЛ/0!");return x/y;}
        case "pow":return numeric(compute(n.a))**numeric(compute(n.b));
        case "compare":{
          const a=compute(n.b[0]),b=compute(n.b[1]),op=n.a;
          if(op==="=")return a===b?1:0;
          if(op==="<>"||op==="!=")return a!==b?1:0;
          if(op==="<")return a<b?1:0;if(op===">")return a>b?1:0;
          if(op==="<=")return a<=b?1:0;if(op===">=")return a>=b?1:0;
          error("#ФОРМУЛА!");
        }
        case "func":{
          const name=n.a,args=n.b,limits=expected[name];
          if(limits&&(args.length<limits[0]||args.length>limits[1]))error("#АРГУМ!");
          if(name==="IF")return compute(args[numeric(compute(args[0]))?1:2]||{type:"number",a:0});
          if(name==="IFERROR"||name==="IFNA"){
            try {const v=compute(args[0]);if(typeof v==="string"&&v.startsWith("#"))return compute(args[1]);return v;}
            catch(e){if(name==="IFNA"&&!e.message.includes("#Н/Д"))throw e;return compute(args[1]);}
          }
          if(name==="AND")return args.every(x=>!!numeric(compute(x)))?1:0;
          if(name==="OR")return args.some(x=>!!numeric(compute(x)))?1:0;
          if(name==="NOT")return numeric(compute(args[0]))?0:1;
          const fn=functions[name];
          if(!fn)error("#ИМЯ?");
          return fn(args.map(compute));
        }
        default:error("#ФОРМУЛА!");
      }
    };
    result=compute(tree);
    if(Array.isArray(result))error("#ЗНАЧ!");
    if(typeof result==="number"&&!Number.isFinite(result))error("#ЧИСЛО!");
  }catch(e){result=typeof e.message==="string"&&e.message.startsWith("#")?e.message:"#ФОРМУЛА!";}
  stack.delete(key);memo.set(key,result);return result;
}

// Excel/Sheets export: preserve the formula, translating Russian function
// names, separators and decimal commas to the invariant Excel dialect.
export function toExcelFormula(source) {
  let formula=String(source??"").replace(/^=/,"");
  const isRussian=/[А-ЯЁ]|;/.test(formula.toUpperCase());
  if(isRussian)formula=formula.replace(/(\d),(\d)/g,"$1.$2");
  formula=formula.replace(/[A-ZА-ЯЁ_][A-ZА-ЯЁ_0-9.]*/gi,
    word=>aliases[word.toUpperCase()]||word.toUpperCase());
  return formula.replace(/;/g,",");
}
