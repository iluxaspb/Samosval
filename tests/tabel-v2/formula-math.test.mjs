import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../../test-app/tabel-v2/table-domain.mjs";
import {toExcelFormula} from "../../test-app/tabel-v2/formula-engine.mjs";

const base={
  A1:{raw:"10"},A2:{raw:"20"},A3:{raw:"-3"},
  B1:{raw:"текст"},B2:{raw:"0"},B3:{raw:""},
};
const evaluate=(f,extra={})=>D.formula({...base,...extra,D1:{raw:f}},"D1",{rows:50,cols:30});
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,JSON.stringify({a,b}));

test("arithmetic, cell refs, ranges and conditional math",()=>{
  assert.equal(evaluate("=A1+2*A2-3"),47);
  assert.equal(evaluate("=SUM(A1:A3)"),27);
  assert.equal(evaluate("=SUM(1;2;A1)"),13);
  assert.equal(evaluate("=PRODUCT(A1:A3)"),-600);
  assert.equal(evaluate("=SUMPRODUCT(A1:A3;A1:A3)"),509);
  assert.equal(evaluate("=COUNT(A1:A3)"),3);
  assert.equal(evaluate("=COUNTA(A1:B3)"),5);
  assert.equal(evaluate("=COUNTIF(A1:A3;\">0\")"),2);
  assert.equal(evaluate("=SUMIF(A1:A3;\">0\")"),30);
  assert.equal(evaluate("=AVERAGEIF(A1:A3;\">0\")"),15);
  assert.equal(evaluate("=COUNTIFS(A1:A3;\">0\";A1:A3;\"<20\")"),1);
  assert.equal(evaluate("=SUMIFS(A1:A3;A1:A3;\">0\")"),30);
  near(evaluate("=AVERAGE(A1:A3)"),9);
  assert.equal(evaluate("=MEDIAN(A1:A3)"),10);
  assert.equal(evaluate("=MIN(A1:A3)"),-3);
  assert.equal(evaluate("=MAX(A1:A3)"),20);
});

test("Excel-style rounding, Russian syntax and mathematical functions",()=>{
  assert.equal(evaluate("=ROUND(1.255,2)"),1.26);
  assert.equal(evaluate("=ОКРУГЛ(1,255;2)"),1.26);
  assert.equal(evaluate("=ROUNDUP(-1.234;2)"),-1.24);
  assert.equal(evaluate("=ROUNDDOWN(-1.239;2)"),-1.23);
  assert.equal(evaluate("=TRUNC(-1.239;2)"),-1.23);
  assert.equal(evaluate("=INT(-1.2)"),-2);
  assert.equal(evaluate("=ROUND(1234;-2)"),1200);
  assert.equal(evaluate("=POWER(2;3)+SQRT(9)"),11);
  assert.equal(evaluate("=MOD(-7;3)"),2);
  assert.equal(evaluate("=QUOTIENT(7;3)"),2);
  assert.equal(evaluate("=COMBIN(5;2)"),10);
  assert.equal(evaluate("=FACT(5)"),120);
  assert.equal(evaluate("=CEILING(12;5)"),15);
  assert.equal(evaluate("=FLOOR(12;5)"),10);
  near(evaluate("=COS(PI())"),-1);
  near(evaluate("=DEGREES(PI())"),180);
  assert.equal(evaluate("=GCD(12;18)"),6);
  assert.equal(evaluate("=LCM(4;6)"),12);
  assert.equal(evaluate("=SUM(ROUND(2.5;0);ABS(-4))"),7);
});

test("safe errors, cycles, lazy IF and IFERROR",()=>{
  assert.equal(evaluate("=A1+B1"),"#ЗНАЧ!");
  assert.equal(evaluate("=1/0"),"#ДЕЛ/0!");
  assert.equal(evaluate("=INVALIDNAME(5)"),"#ИМЯ?");
  assert.equal(evaluate("=IF(A1>0;ROUND(A2/3;2);1/0)"),6.67);
  assert.equal(evaluate("=IFERROR(1/0;99)"),99);
  assert.equal(evaluate("=IF(FALSE;1/0;3)"),3);
  assert.equal(evaluate("=AND(1;0)"),0);
  assert.equal(evaluate("=OR(1;0)"),1);
  assert.equal(evaluate("=C4",{C4:{raw:"=C4"}}),"#ЦИКЛ!");
});

test("Excel export translates common formulas and preserves decimal precision",()=>{
  assert.equal(toExcelFormula("=ОКРУГЛ(1,255;2)"),"ROUND(1.255,2)");
  assert.equal(toExcelFormula("=СУММ(A1:A3;ОКРУГЛ(B1;0))"),"SUM(A1:A3,ROUND(B1,0))");
  assert.equal(toExcelFormula("=SUM(A1:A3)"),"SUM(A1:A3)");
  assert.equal(toExcelFormula('=ЕСЛИ(A1>0;"День";"Выходной")'),'IF(A1>0,"День","Выходной")');
});
