import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reads a recorded fixture relative to the calling module (`import.meta.url`). */
export function readFixture(moduleUrl: string, relativePath: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(moduleUrl)), relativePath), 'utf8');
}
