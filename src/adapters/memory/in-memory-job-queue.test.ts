import { describe, expect, it } from 'vitest';
import { StoreAuthError, StoreUnavailableError } from '../../domain/errors.js';
import { immediateRetry } from '../test-support/retry-runner.js';
import { InMemoryJobQueue } from './in-memory-job-queue.js';

const job = (idempotencyKey: string, payload = idempotencyKey) => ({ idempotencyKey, payload });

describe('InMemoryJobQueue', () => {
  it('processes jobs in FIFO order', async () => {
    const queue = new InMemoryJobQueue<string>();
    await queue.enqueue(job('a'));
    await queue.enqueue(job('b'));
    const seen: string[] = [];

    const summary = await queue.process(async (j) => {
      seen.push(j.payload);
    });

    expect(seen).toEqual(['a', 'b']);
    expect(summary).toEqual({ succeeded: 2, failed: [] });
  });

  it('rejects a second job with the same idempotency key', async () => {
    const queue = new InMemoryJobQueue<string>();

    expect(await queue.enqueue(job('a'))).toBe('enqueued');
    expect(await queue.enqueue(job('a'))).toBe('duplicate');

    const seen: string[] = [];
    await queue.process(async (j) => {
      seen.push(j.payload);
    });
    expect(seen).toEqual(['a']);
  });

  it('remembers keys of successful jobs across runs', async () => {
    const queue = new InMemoryJobQueue<string>();
    await queue.enqueue(job('a'));
    await queue.process(async () => {});

    expect(await queue.enqueue(job('a'))).toBe('duplicate');
  });

  it('is empty after a run', async () => {
    const queue = new InMemoryJobQueue<string>();
    await queue.enqueue(job('a'));
    await queue.process(async () => {});

    expect(await queue.process(async () => {})).toEqual({ succeeded: 0, failed: [] });
  });

  it('runs the handler once by default, without retries', async () => {
    const queue = new InMemoryJobQueue<string>();
    await queue.enqueue(job('a'));
    let calls = 0;

    const summary = await queue.process(async () => {
      calls += 1;
      throw new StoreUnavailableError('503');
    });

    expect(calls).toBe(1);
    expect(summary.failed).toHaveLength(1);
  });

  it('retries through the injected runner and reports the attempt number', async () => {
    const queue = new InMemoryJobQueue<string>({ retry: immediateRetry(3) });
    await queue.enqueue(job('a'));
    const attempts: number[] = [];

    const summary = await queue.process(async (_job, attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new StoreUnavailableError('503');
    });

    expect(attempts).toEqual([1, 2, 3]);
    expect(summary).toEqual({ succeeded: 1, failed: [] });
  });

  it('reports a job that exhausts its attempts and keeps going', async () => {
    const queue = new InMemoryJobQueue<string>({ retry: immediateRetry(2) });
    await queue.enqueue(job('bad'));
    await queue.enqueue(job('good'));
    const error = new StoreUnavailableError('503');

    const summary = await queue.process(async (j) => {
      if (j.payload === 'bad') throw error;
    });

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toEqual([{ job: job('bad'), attempts: 2, error }]);
  });

  it('does not retry permanent errors', async () => {
    const queue = new InMemoryJobQueue<string>({ retry: immediateRetry(5) });
    await queue.enqueue(job('a'));

    const summary = await queue.process(async () => {
      throw new StoreAuthError('401');
    });

    expect(summary.failed[0]?.attempts).toBe(1);
  });

  it('releases the key of a job that failed for good', async () => {
    const queue = new InMemoryJobQueue<string>();
    await queue.enqueue(job('a'));
    await queue.process(async () => {
      throw new StoreAuthError('401');
    });

    expect(await queue.enqueue(job('a'))).toBe('enqueued');
  });

  it('processes jobs enqueued by a handler within the same run', async () => {
    const queue = new InMemoryJobQueue<string>();
    await queue.enqueue(job('first'));
    const seen: string[] = [];

    await queue.process(async (j) => {
      seen.push(j.payload);
      if (j.payload === 'first') await queue.enqueue(job('second'));
    });

    expect(seen).toEqual(['first', 'second']);
  });
});
