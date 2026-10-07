import { z } from 'zod';

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export type AppConfig =
  | { readonly mode: 'memory'; readonly retry: RetryConfig }
  | {
      readonly mode: 'live';
      readonly retry: RetryConfig;
      readonly odoo: {
        readonly url: string;
        readonly db: string;
        readonly username: string;
        readonly apiKey: string;
        readonly warehouseIds: readonly number[];
      };
      readonly prestashop: { readonly url: string; readonly wsKey: string };
    };

export class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const retryVariables = {
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  SYNC_BASE_DELAY_MS: z.coerce.number().int().min(0).default(500),
  SYNC_MAX_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
};

const warehouseIds = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const parts = (raw ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const ids = parts.map(Number);
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of positive integers' });
      return z.NEVER;
    }
    return ids;
  });

const schema = z.discriminatedUnion('SYNC_MODE', [
  z.object({ SYNC_MODE: z.literal('memory'), ...retryVariables }),
  z.object({
    SYNC_MODE: z.literal('live'),
    ODOO_URL: z.url(),
    ODOO_DB: z.string().min(1),
    ODOO_USERNAME: z.string().min(1),
    ODOO_API_KEY: z.string().min(1),
    ODOO_WAREHOUSE_IDS: warehouseIds,
    PRESTASHOP_URL: z.url(),
    PRESTASHOP_WS_KEY: z.string().min(1),
    ...retryVariables,
  }),
]);

/**
 * Parses and validates environment variables. Blank values count as unset
 * (an `.env` file often lists empty placeholders) and SYNC_MODE defaults to
 * `memory`, so a bare checkout never touches real systems. Error messages
 * name variables, never their values.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = schema.safeParse({ SYNC_MODE: 'memory', ...present });
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`),
    );
  }

  const parsed = result.data;
  if (parsed.SYNC_BASE_DELAY_MS > parsed.SYNC_MAX_DELAY_MS) {
    throw new ConfigError(['SYNC_BASE_DELAY_MS: must not exceed SYNC_MAX_DELAY_MS']);
  }
  const retry: RetryConfig = {
    maxAttempts: parsed.SYNC_MAX_ATTEMPTS,
    baseDelayMs: parsed.SYNC_BASE_DELAY_MS,
    maxDelayMs: parsed.SYNC_MAX_DELAY_MS,
  };

  if (parsed.SYNC_MODE === 'memory') {
    return { mode: 'memory', retry };
  }
  return {
    mode: 'live',
    retry,
    odoo: {
      url: parsed.ODOO_URL,
      db: parsed.ODOO_DB,
      username: parsed.ODOO_USERNAME,
      apiKey: parsed.ODOO_API_KEY,
      warehouseIds: parsed.ODOO_WAREHOUSE_IDS,
    },
    prestashop: { url: parsed.PRESTASHOP_URL, wsKey: parsed.PRESTASHOP_WS_KEY },
  };
}
