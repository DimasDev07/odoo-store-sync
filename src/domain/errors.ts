/**
 * Typed errors shared by the core and the adapters.
 *
 * `retryable` tells the job queue whether trying again can help
 * (network failures, 5xx) or not (bad credentials, malformed payloads).
 */
export abstract class SyncError extends Error {
  abstract readonly retryable: boolean;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidSkuError extends SyncError {
  readonly retryable = false;
}

export class InvalidQuantityError extends SyncError {
  readonly retryable = false;
}

export class ErpAuthError extends SyncError {
  readonly retryable = false;
}

export class ErpUnavailableError extends SyncError {
  readonly retryable = true;
}

export class ErpProtocolError extends SyncError {
  readonly retryable = false;
}

export class StoreAuthError extends SyncError {
  readonly retryable = false;
}

export class StoreNotFoundError extends SyncError {
  readonly retryable = false;
}

export class StoreUnavailableError extends SyncError {
  readonly retryable = true;
}

export class StoreProtocolError extends SyncError {
  readonly retryable = false;
}

/** Unknown errors are treated as permanent: retrying blindly can duplicate side effects. */
export function isRetryable(error: unknown): boolean {
  return error instanceof SyncError && error.retryable;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
