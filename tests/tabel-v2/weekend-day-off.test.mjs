import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../../test-app/tabel-v2/table-domain.mjs";

test("Saturday and Sunday have stable UTC calendar classification", () => {
  assert.equal(D.isWeekendDate("2026-10-24"), true);
  assert.equal(D.isWeekendDate("2026-10-25"), true);
  assert.equal(D.isWeekendDate("2026-10-26"), false);
  assert.equal(D.restDayLabel({date:"2026-10-24"}), "Сб");
  assert.equal(D.restDayLabel({date:"2026-10-25"}), "Вс");
  assert.equal(D.restDayLabel({date:"2026-10-26"}), "");
});

test("manual day off can be marked on a Wednesday without losing its date", () => {
  const cfg=D.config({id:"site",name:"Производственная площадка",startDate:"2026-10-01"});
  const d={...D.createDay(cfg,"2026-10-28","day"),dayOff:true};
  assert.equal(D.isRestDay(d),true);
  assert.equal(D.restDayLabel(d),"Выходной");
  assert.equal(d.date,"2026-10-28");
  assert.equal(D.dayKey(d.date,d.shift),"day:2026-10-28:day");
  assert.equal(D.isRestDay({...d,dayOff:false}),false);
});

test("explicit holiday on existing shift retains all hours and volumes", () => {
  const original={
    date:"2026-10-28",shift:"day",equipment:[{id:"mill",hours:12,crewHours:24}],
    people:[{id:"itr",hours:12}],values:{gravel:{quantity:25}},dayOff:false
  };
  const changed={...D.copy(original),dayOff:true};
  assert.deepEqual(changed.equipment, original.equipment);
  assert.deepEqual(changed.people, original.people);
  assert.deepEqual(changed.values, original.values);
  assert.equal(D.isRestDay(changed),true);
  assert.equal(original.dayOff,false);
});

test("calendar keeps weekend dates and explicit off dates as independent columns",()=>{
  assert.deepEqual(D.days("2026-10-23","2026-10-27"),
    ["2026-10-23","2026-10-24","2026-10-25","2026-10-26","2026-10-27"]);
  const sunday={date:"2026-10-25",shift:"day",dayOff:true};
  const saturday={date:"2026-10-24",shift:"day"};
  assert(D.isRestDay(saturday)&&D.isRestDay(sunday));
});
