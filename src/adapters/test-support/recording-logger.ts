import type { LoggerPort, LogFields } from '../../application/ports/logger-port.js';

export interface LogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

export class RecordingLogger implements LoggerPort {
  readonly calls: LogCall[] = [];

  debug(message: string, fields?: LogFields): void {
    this.calls.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.calls.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.calls.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.calls.push({ level: 'error', message, fields });
  }

  at(level: LogCall['level']): LogCall[] {
    return this.calls.filter((call) => call.level === level);
  }
}
