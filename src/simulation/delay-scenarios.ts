import { env } from '../config/index.js';
import type { AlertSeverity, DelayScenario } from '../generated/prisma/enums.js';

/**
 * The delay scenario table (CLAUDE.md §7). Deterministic constants — no traffic
 * API, no weather API, no model. The numbers are configurable through the
 * environment and injected into the simulation manager, so tests pin their own.
 *
 * The model is one multiplier applied to a truck's *base* speed:
 *
 *     effective speed = base speed x multiplier[scenario]
 *
 * `speedKmph` on the truck row and on every payload stays the effective speed,
 * which is why nothing downstream of this file had to change.
 */

export type DelayMultipliers = Record<DelayScenario, number>;

/** Only one primary scenario is active per truck for now (§7). */
export type ActiveDelayScenario = Exclude<DelayScenario, 'NORMAL'>;

export const delayMultipliersFromEnv: DelayMultipliers = {
  NORMAL: 1,
  RAIN: env.DELAY_MULTIPLIER_RAIN,
  TRAFFIC: env.DELAY_MULTIPLIER_TRAFFIC,
  ROAD_CLOSURE: env.DELAY_MULTIPLIER_ROAD_CLOSURE,
};

export function multiplierFor(scenario: DelayScenario, multipliers: DelayMultipliers): number {
  const multiplier = multipliers[scenario];
  // Defensive: a non-positive multiplier would freeze the truck and make the
  // base-speed inverse below undefined. env.ts already rejects those.
  return multiplier > 0 ? multiplier : 1;
}

/** The speed a truck actually drives at under `scenario`. */
export function effectiveSpeedKmph(
  baseSpeedKmph: number,
  scenario: DelayScenario,
  multipliers: DelayMultipliers,
): number {
  return baseSpeedKmph * multiplierFor(scenario, multipliers);
}

/**
 * The inverse, used once per truck at load time.
 *
 * There is no `baseSpeedKmph` column: a persisted row carries the *effective*
 * speed plus the scenario that produced it, so dividing recovers the base. The
 * seed is built this way already — the RAIN truck is 39 km/h (60 x 0.65) and the
 * TRAFFIC truck is 27 km/h (60 x 0.45), and both come back to exactly 60.
 */
export function baseSpeedKmphFrom(
  effectiveSpeed: number,
  scenario: DelayScenario,
  multipliers: DelayMultipliers,
): number {
  return effectiveSpeed / multiplierFor(scenario, multipliers);
}

/** A road closure is the one scenario serious enough to page the control tower. */
export const DELAY_SEVERITY: Record<ActiveDelayScenario, AlertSeverity> = {
  RAIN: 'WARNING',
  TRAFFIC: 'WARNING',
  ROAD_CLOSURE: 'CRITICAL',
};

/** Human wording for alert titles and messages. */
export const DELAY_LABEL: Record<DelayScenario, string> = {
  NORMAL: 'Normal',
  RAIN: 'Rain',
  TRAFFIC: 'Traffic',
  ROAD_CLOSURE: 'Road closure',
};
