import { describe, expect, it } from 'vitest';
import {
  ErpAuthError,
  ErpProtocolError,
  ErpUnavailableError,
  errorMessage,
  InvalidQuantityError,
  InvalidSkuError,
  isRetryable,
  StoreAuthError,
  StoreNotFoundError,
  StoreProtocolError,
  StoreUnavailableError,
  SyncError,
} from './errors.js';

const permanent = [
  InvalidSkuError,
  InvalidQuantityError,
  ErpAuthError,
  ErpProtocolError,
  StoreAuthError,
  StoreNotFoundError,
  StoreProtocolError,
] as const;
const transient = [ErpUnavailableError, StoreUnavailableError] as const;

describe('typed errors', () => {
  it.each(permanent)('%o is a permanent SyncError', (ErrorClass) => {
    const error = new ErrorClass('boom');

    expect(error).toBeInstanceOf(SyncError);
    expect(error).toBeInstanceOf(Error);
    expect(error.retryable).toBe(false);
    expect(error.name).toBe(ErrorClass.name);
    expect(error.message).toBe('boom');
  });

  it.each(transient)('%o is a transient SyncError', (ErrorClass) => {
    expect(new ErrorClass('later').retryable).toBe(true);
  });

  it('keeps the original cause', () => {
    const cause = new TypeError('socket hang up');

    expect(new StoreUnavailableError('down', { cause }).cause).toBe(cause);
  });
});

describe('isRetryable', () => {
  it('follows the error flag', () => {
    expect(isRetryable(new StoreUnavailableError('x'))).toBe(true);
    expect(isRetryable(new StoreAuthError('x'))).toBe(false);
  });

  it('treats unknown errors as permanent', () => {
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isRetryable('x')).toBe(false);
  });
});

describe('errorMessage', () => {
  it('reads Error messages and stringifies anything else', () => {
    expect(errorMessage(new Error('bad'))).toBe('bad');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});
