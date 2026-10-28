import test from 'node:test';
import assert from 'node:assert/strict';
import {lineCalendarDate, createShift} from '../../test-app/tabel-v2/domain.mjs';
test('real Line ru-RU date creates the intended calendar shift', () => {
  for (const [input, expected] of [['28.10.2026','2026-10-28'],['1.2.2026','2026-02-01'],['31.12.2026','2026-12-31'],['29.02.2024','2024-02-29'],['2026-10-28','2026-10-28']]) {
    const date=lineCalendarDate(input);
    assert.equal(date, expected);
    assert.equal(createShift({objectId:'site',date,kind:'night',startDate:'2000-01-01',settings:{}}).date,expected);
  }
});
test('invalid Line dates never silently become today or another month', () => {
  for(const value of [undefined,'','31.02.2026','29.02.2026','10/28/2026','2026-13-01']) assert.throws(()=>lineCalendarDate(value),/Неверная дата/);
});
