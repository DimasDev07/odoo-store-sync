import { describe, expect, it } from 'vitest';
import { InvalidQuantityError, InvalidSkuError } from './errors.js';
import { createStockLevel, Sku } from './product.js';

describe('Sku', () => {
  it('trims surrounding whitespace', () => {
    expect(Sku.of('  DESK-001 \n').value).toBe('DESK-001');
  });

  it('keeps case, because the store decides how to compare references', () => {
    expect(Sku.of('Desk-001').value).toBe('Desk-001');
  });

  it.each(['', '   ', '\t\n'])('rejects blank input %j', (raw) => {
    expect(() => Sku.of(raw)).toThrow(InvalidSkuError);
  });

  it('compares by value', () => {
    expect(Sku.of('A').equals(Sku.of(' A '))).toBe(true);
    expect(Sku.of('A').equals(Sku.of('B'))).toBe(false);
  });

  it('prints as its value', () => {
    expect(`${Sku.of('A-1')}`).toBe('A-1');
  });
});

describe('createStockLevel', () => {
  it('builds a level from a raw sku string', () => {
    const level = createStockLevel({ sku: ' A-1 ', quantity: 5 });

    expect(level.sku.value).toBe('A-1');
    expect(level.quantity).toBe(5);
    expect(level).not.toHaveProperty('warehouseId');
    expect(level).not.toHaveProperty('sourceVersion');
  });

  it('accepts an existing Sku and optional metadata', () => {
    const sku = Sku.of('A-1');
    const level = createStockLevel({ sku, quantity: 0, warehouseId: '3', sourceVersion: 'v1' });

    expect(level.sku).toBe(sku);
    expect(level.warehouseId).toBe('3');
    expect(level.sourceVersion).toBe('v1');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects quantity %s: it must be a non-negative integer',
    (quantity) => {
      expect(() => createStockLevel({ sku: 'A', quantity })).toThrow(InvalidQuantityError);
    },
  );

  it('propagates invalid sku errors', () => {
    expect(() => createStockLevel({ sku: ' ', quantity: 1 })).toThrow(InvalidSkuError);
  });
});
