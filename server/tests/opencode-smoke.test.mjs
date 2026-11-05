import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeControl} from '../src/control-rules.mjs';

test('smoke: normalizeControl trims brand and number', () => {
  const input = {
    id: 'test-smoke-id',
    type: 'truck.create',
    recordId: 'truck-123',
    expectedRevision: 0,
    data: {
      brand: ' KAMAZ ',
      number: ' А123 ',
      defaultVol: 20,
      isGAI: false
    }
  };
  const result = normalizeControl(input);
  assert.equal(result.data.brand, 'KAMAZ');
  assert.equal(result.data.number, 'А123');
});

test('smoke: normalizeControl preserves type and recordId', () => {
  const result = normalizeControl({
    id: 'test-smoke-id',
    type: 'truck.create',
    recordId: 'truck-123',
    expectedRevision: 0,
    data: {
      brand: 'KAMAZ',
      number: 'А123',
      defaultVol: 20,
      isGAI: false
    }
  });
  assert.equal(result.type, 'truck.create');
  assert.equal(result.recordId, 'truck-123');
});
