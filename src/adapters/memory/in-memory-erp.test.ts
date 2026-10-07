import { describe, expect, it } from 'vitest';
import { ErpUnavailableError } from '../../domain/errors.js';
import { createStockLevel } from '../../domain/product.js';
import { InMemoryErp } from './in-memory-erp.js';

describe('InMemoryErp', () => {
  const level = createStockLevel({ sku: 'A-1', quantity: 4 });

  it('lists the seeded levels', async () => {
    expect(await new InMemoryErp([level]).listStockLevels()).toEqual([level]);
  });

  it('starts empty', async () => {
    expect(await new InMemoryErp().listStockLevels()).toEqual([]);
  });

  it('replaces levels and records the since argument of each read', async () => {
    const erp = new InMemoryErp();
    const since = new Date('2026-10-01T00:00:00Z');
    erp.setLevels([level]);

    await erp.listStockLevels(since);
    await erp.listStockLevels();

    expect(erp.sinceArgs).toEqual([since, undefined]);
    expect(await erp.listStockLevels()).toEqual([level]);
  });

  it('returns a copy so callers cannot mutate the fake', async () => {
    const erp = new InMemoryErp([level]);

    (await erp.listStockLevels()).pop();

    expect(await erp.listStockLevels()).toHaveLength(1);
  });

  it('fails on demand and recovers', async () => {
    const erp = new InMemoryErp([level]);
    erp.failWith(new ErpUnavailableError('down'));

    await expect(erp.listStockLevels()).rejects.toThrow('down');

    erp.failWith(undefined);
    expect(await erp.listStockLevels()).toHaveLength(1);
  });
});
