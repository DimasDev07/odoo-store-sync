import type { RetryRunner } from '../../application/ports/job-queue-port.js';
import { isRetryable } from '../../domain/errors.js';

/** Test helper: retries retryable errors immediately, up to `maxAttempts` attempts. */
export function immediateRetry(maxAttempts: number): RetryRunner {
  return async <T>(operation: (attempt: number) => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryable(error)) {
          throw error;
        }
      }
    }
  };
}
