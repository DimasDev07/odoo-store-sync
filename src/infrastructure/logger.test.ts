import { describe, expect, it } from 'vitest';
import { createJsonLogger } from './logger.js';

const NOW = new Date('2026-10-08T10:00:00.000Z');

function setup(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const logger = createJsonLogger({
    write: (line) => lines.push(line),
    now: () => NOW,
    ...(level !== undefined && { level }),
  });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line)) };
}

describe('createJsonLogger', () => {
  it('writes one JSON object per line with time, level, message and fields', () => {
    const { logger, parsed } = setup();

    logger.info('stock updated', { sku: 'A-1', quantity: 3 });

    expect(parsed()).toEqual([
      { time: '2026-10-08T10:00:00.000Z', level: 'info', message: 'stock updated', sku: 'A-1', quantity: 3 },
    ]);
  });

  it('works without fields', () => {
    const { logger, parsed } = setup();

    logger.warn('heads up');

    expect(parsed()[0]).toEqual({ time: NOW.toISOString(), level: 'warn', message: 'heads up' });
  });

  it('hides debug output by default and honours the configured level', () => {
    const quiet = setup();
    quiet.logger.debug('noise');
    expect(quiet.lines).toEqual([]);

    const verbose = setup('debug');
    verbose.logger.debug('detail');
    expect(verbose.lines).toHaveLength(1);

    const errorsOnly = setup('error');
    errorsOnly.logger.warn('w');
    errorsOnly.logger.info('i');
    errorsOnly.logger.error('e');
    expect(errorsOnly.parsed().map((entry) => entry.level)).toEqual(['error']);
  });

  it('does not let fields overwrite the core keys', () => {
    const { logger, parsed } = setup();

    logger.info('real', { level: 'fake', message: 'fake', time: 'fake' });

    expect(parsed()[0]).toMatchObject({ level: 'info', message: 'real', time: NOW.toISOString() });
  });

  it('serializes errors as name and message', () => {
    const { logger, parsed } = setup();

    logger.error('failed', { error: new TypeError('boom') });

    expect(parsed()[0].error).toEqual({ name: 'TypeError', message: 'boom' });
  });

  it('survives values that cannot be serialized', () => {
    const { logger, parsed } = setup();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    logger.info('loop', { circular });

    expect(parsed()[0]).toMatchObject({ level: 'error', message: 'log serialization failed' });
  });

  it('writes to stdout by default', () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      createJsonLogger().info('hello');
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join('')).toMatch(/"message":"hello"\}\n$/);
  });
});
