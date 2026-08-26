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

  // --- Simulation (Phase 4) ---------------------------------------------
  /** Locked by CLAUDE.md §4: the backend advances trucks every 2 seconds. */
  SIMULATION_TICK_MS: z.coerce.number().int().positive().default(2000),
  /**
   * `z.coerce.boolean()` treats any non-empty string as true, so spell the
   * accepted values out (same reason as `booleanQuery` in src/schemas/common.ts).
   */
  SIMULATION_AUTOSTART: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** 1 = real time. Raise it only to compress a demo; ETA scales with it. */
  SIMULATION_SPEED_MULTIPLIER: z.coerce.number().positive().default(1),
  /** Progress % at which a moving truck flips to ARRIVING. */
  SIMULATION_ARRIVING_PROGRESS: z.coerce.number().min(1).max(100).default(95),
  /**
   * Progress % between periodic database checkpoints. Positions are never
   * written per tick (§24) — only on transitions and these checkpoints.
   */
  SIMULATION_CHECKPOINT_PROGRESS_STEP: z.coerce.number().positive().max(100).default(5),

  // --- Delay scenarios (Phase 6) ----------------------------------------
  /**
   * Effective speed = the truck's base speed x the multiplier for its active
   * scenario (CLAUDE.md §7, "keep these values configurable").
   *
   * Every multiplier must be > 0. The base speed is recovered from a persisted
   * row by dividing the stored speed by its scenario's multiplier, so a zero
   * would make that irreversible — and a zero-speed truck covers no ground,
   * which `advanceTruck` treats as "nothing to report". ROAD_CLOSURE is
   * therefore a very strong slowdown rather than a full stop.
   */
  DELAY_MULTIPLIER_RAIN: z.coerce.number().positive().max(1).default(0.65),
  DELAY_MULTIPLIER_TRAFFIC: z.coerce.number().positive().max(1).default(0.45),
  DELAY_MULTIPLIER_ROAD_CLOSURE: z.coerce.number().positive().max(1).default(0.1),
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

/**
 * Autostart is force-disabled under NODE_ENV=test: the read-API suite asserts on
 * exact seeded values, and a running simulation would mutate them underneath it.
 */
export const simulationAutostart: boolean =
  raw.SIMULATION_AUTOSTART && raw.NODE_ENV !== 'test';

export const env = {
  ...raw,
  corsOrigin,
  simulationAutostart,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
} as const;

export type Env = typeof env;
