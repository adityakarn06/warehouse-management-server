import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  CORS_ORIGIN: z.string().default('*'),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /** How far ahead the yard overview looks when listing upcoming arrivals. */
  ARRIVAL_HORIZON_MINUTES: z.coerce.number().int().positive().default(120),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

export const corsOrigin: '*' | string[] =
  raw.CORS_ORIGIN.trim() === '*'
    ? '*'
    : raw.CORS_ORIGIN.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

export const env = {
  ...raw,
  corsOrigin,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
} as const;

export type Env = typeof env;
