import type { LoggerPort, LogFields } from '../application/ports/logger-port.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  /** Receives one JSON document per call, without a trailing newline. Defaults to stdout. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  /** Minimum level to emit. Defaults to `info`. */
  readonly level?: LogLevel;
}

/** Tiny structured logger: one JSON object per line, easy to ship to any log stack. */
export function createJsonLogger(options: JsonLoggerOptions = {}): LoggerPort {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const threshold = SEVERITY[options.level ?? 'info'];

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (SEVERITY[level] < threshold) {
      return;
    }
    const time = now().toISOString();
    const record: Record<string, unknown> = { time, level, message };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!(key in record)) {
        record[key] = value;
      }
    }
    try {
      write(JSON.stringify(record, serializeErrors));
    } catch {
      write(JSON.stringify({ time, level: 'error', message: 'log serialization failed' }));
    }
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

function serializeErrors(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}
