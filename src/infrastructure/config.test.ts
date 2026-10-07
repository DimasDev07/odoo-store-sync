import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const liveEnv = {
  SYNC_MODE: 'live',
  ODOO_URL: 'https://erp.example.com',
  ODOO_DB: 'prod',
  ODOO_USERNAME: 'sync@example.com',
  ODOO_API_KEY: 'odoo-secret',
  PRESTASHOP_URL: 'https://shop.example.com',
  PRESTASHOP_WS_KEY: 'ps-secret',
};

const retryDefaults = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 };

describe('loadConfig', () => {
  it('defaults to memory mode so a bare checkout never touches real systems', () => {
    expect(loadConfig({})).toEqual({ mode: 'memory', retry: retryDefaults });
  });

  it('does not require live credentials in memory mode', () => {
    expect(loadConfig({ SYNC_MODE: 'memory', ODOO_URL: '' }).mode).toBe('memory');
  });

  it('parses a complete live configuration', () => {
    expect(loadConfig(liveEnv)).toEqual({
      mode: 'live',
      retry: retryDefaults,
      odoo: {
        url: 'https://erp.example.com',
        db: 'prod',
        username: 'sync@example.com',
        apiKey: 'odoo-secret',
        warehouseIds: [],
      },
      prestashop: { url: 'https://shop.example.com', wsKey: 'ps-secret' },
    });
  });

  it('parses a comma-separated warehouse list', () => {
    const config = loadConfig({ ...liveEnv, ODOO_WAREHOUSE_IDS: '1, 3' });

    expect(config.mode === 'live' && config.odoo.warehouseIds).toEqual([1, 3]);
  });

  it('treats empty values from an .env file as unset', () => {
    const config = loadConfig({ ...liveEnv, ODOO_WAREHOUSE_IDS: '', SYNC_MAX_ATTEMPTS: '  ' });

    expect(config.mode === 'live' && config.odoo.warehouseIds).toEqual([]);
    expect(config.retry.maxAttempts).toBe(4);
  });

  it('reads retry tuning', () => {
    const config = loadConfig({
      SYNC_MAX_ATTEMPTS: '6',
      SYNC_BASE_DELAY_MS: '250',
      SYNC_MAX_DELAY_MS: '5000',
    });

    expect(config.retry).toEqual({ maxAttempts: 6, baseDelayMs: 250, maxDelayMs: 5_000 });
  });

  it('lists every missing live variable by name', () => {
    const error = catchError(() => loadConfig({ SYNC_MODE: 'live' }));

    expect(error).toBeInstanceOf(ConfigError);
    for (const name of [
      'ODOO_URL',
      'ODOO_DB',
      'ODOO_USERNAME',
      'ODOO_API_KEY',
      'PRESTASHOP_URL',
      'PRESTASHOP_WS_KEY',
    ]) {
      expect(error.message).toContain(name);
    }
  });

  it('rejects malformed values without echoing secrets', () => {
    const error = catchError(() =>
      loadConfig({ ...liveEnv, ODOO_URL: 'not a url', PRESTASHOP_WS_KEY: 'ps-secret', ODOO_WAREHOUSE_IDS: 'a,b' }),
    );

    expect(error.message).toContain('ODOO_URL');
    expect(error.message).toContain('ODOO_WAREHOUSE_IDS');
    expect(error.message).not.toContain('ps-secret');
    expect(error.message).not.toContain('odoo-secret');
  });

  it('rejects unknown modes', () => {
    expect(() => loadConfig({ SYNC_MODE: 'turbo' })).toThrow(ConfigError);
  });

  it('rejects out-of-range retry settings', () => {
    expect(() => loadConfig({ SYNC_MAX_ATTEMPTS: '0' })).toThrow(ConfigError);
  });

  it('rejects a base delay above the cap', () => {
    expect(() => loadConfig({ SYNC_BASE_DELAY_MS: '9000', SYNC_MAX_DELAY_MS: '1000' })).toThrow(
      /SYNC_BASE_DELAY_MS/,
    );
  });
});

function catchError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the action to throw');
}
