import test from "node:test";
import assert from "node:assert/strict";
import {syntaxParts,formulaReferences,FORMULA_REF_COLORS} from "../../test-app/tabel-v2/formula-syntax.mjs";
import {FORMULAS,searchFormulas} from "../../test-app/tabel-v2/formula-catalog.mjs";
import * as D from "../../test-app/tabel-v2/table-domain.mjs";

test("formula bar tokens preserve exact text, highlight named functions and cell refs",()=>{
  const raw='=ROUND(A1;2)+SUM(B2:B4)+IF(A2>0;"A5";0)';
  const parts=syntaxParts(raw);
  assert.equal(parts.map(t=>t.text).join(""),raw);
  assert(parts.some(t=>t.text==="ROUND"&&t.kind==="function"));
  assert(parts.some(t=>t.text==="SUM"&&t.kind==="function"));
  assert(parts.some(t=>t.text==="A1"&&t.kind==="ref"&&FORMULA_REF_COLORS.includes(t.color)));
  assert(parts.some(t=>t.text==="2"&&t.kind==="number"));
  assert(parts.some(t=>t.text===";"&&t.kind==="operator"));
  assert(parts.some(t=>t.text==='"A5"'&&t.kind==="string"));
  const groups=formulaReferences(raw);
  assert(groups.some(x=>x.from==="B2"&&x.to==="B4"));
  assert(!groups.some(x=>x.from==="A5"),"String literals must never highlight cells");
  assert.deepEqual(syntaxParts("ordinary text"),[{text:"ordinary text",kind:"plain"}]);
});

test("help search uses English names, Russian names and human explanations",()=>{
  assert(searchFormulas("округл").some(f=>f.name==="ROUND"));
  assert(searchFormulas("SUM","Суммы").some(f=>f.name==="SUM"));
  assert(searchFormulas("среднее","Статистика").some(f=>f.name==="AVERAGE"));
  assert(!searchFormulas("ROUND","Суммы").length);
  assert(FORMULAS.length>=40);
  const uniques=new Set(FORMULAS.map(f=>f.name));
  assert.equal(uniques.size,FORMULAS.length);
  for(const f of FORMULAS){
    assert(f.description&&f.example.startsWith("=")&&f.category);
    assert(f.aliases.includes(f.name));
  }
});

test("guide examples evaluate using real math engine",()=>{
  const cells={
    A1:{raw:"10"},A2:{raw:"20"},A3:{raw:"30"},A4:{raw:"5"},A5:{raw:"8"},
    B1:{raw:"2"},B2:{raw:"3"},B3:{raw:"4"},B4:{raw:"5"},B5:{raw:"6"},
    C1:{raw:"100"},C2:{raw:"200"},C3:{raw:"300"},C4:{raw:"400"},C5:{raw:"500"}
  };
  const sample=["SUM","ROUND","AVERAGE","SUMIF","COUNTIF","SUMIFS","SUMPRODUCT","IFERROR","PRODUCT","MAX"];
  for(const name of sample){
    const f=FORMULAS.find(x=>x.name===name);
    const value=D.formula({...cells,D1:{raw:f.example}},"D1",{rows:40,cols:20});
    assert.equal(typeof value,"number",name+" example: "+value);
    assert(Number.isFinite(value),name+" non-finite result");
  }
});

test("every documented example calculates without spreadsheet errors", () => {
  // The built-in guide must never recommend a formula the Tabel cannot run.
  const cells={
    A1:{raw:"10"},A2:{raw:"20"},A3:{raw:"30"},A4:{raw:"5"},A5:{raw:"8"},
    B1:{raw:"2"},B2:{raw:"3"},B3:{raw:"4"},B4:{raw:"5"},B5:{raw:"6"},
    C1:{raw:"100"},C2:{raw:"200"},C3:{raw:"300"},C4:{raw:"400"},C5:{raw:"500"}
  };
  for(const f of FORMULAS){
    const value=D.formula({...cells,D1:{raw:f.example}},"D1",{rows:40,cols:20});
    assert(!(typeof value==="string" && value.startsWith("#")),
      f.name+": guide example failed with "+value+" ("+f.example+")");
    assert(value===value,f.name+" produced NaN");
  }
});
