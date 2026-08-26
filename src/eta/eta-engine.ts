/**
 * ETA is calculated by the backend and nowhere else (CLAUDE.md §6). It is never
 * a hardcoded countdown: every tick recomputes it from the distance still to
 * drive and the truck's current effective speed.
 *
 * Delay scenarios (RAIN / TRAFFIC / ROAD_CLOSURE speed multipliers) arrive in
 * Phase 6. Until then the truck's own `speedKmph` is the effective speed —
 * which is why the seeded DELAYED trucks already crawl.
 */

const MS_PER_HOUR = 3_600_000;

export interface EtaInput {
  /** Road kilometres still to drive. */
  remainingKm: number;
  /** Effective ground speed. Zero or less means "not moving" — no ETA. */
  speedKmph: number;
  /** Wall-clock reference point. */
  now: Date;
  /** 1 = real time. Higher compresses the journey into a shorter demo. */
  speedMultiplier?: number;
}

/** Real milliseconds until arrival, or `null` when the truck is not moving. */
export function remainingMs(input: EtaInput): number | null {
  const multiplier = input.speedMultiplier ?? 1;
  if (input.speedKmph <= 0 || multiplier <= 0) return null;
  if (input.remainingKm <= 0) return 0;

  return (input.remainingKm / input.speedKmph) * (MS_PER_HOUR / multiplier);
}

/**
 * Authoritative arrival timestamp. Always a real wall-clock instant, so a
 * frontend countdown against it stays honest even when the multiplier is > 1.
 */
export function calculateEta(input: EtaInput): Date | null {
  const ms = remainingMs(input);
  if (ms === null) return null;
  return new Date(input.now.getTime() + ms);
}

/** Kilometres covered in `elapsedMs` at `speedKmph`. Elapsed-time based, never a step count. */
export function distanceTravelledKm(
  speedKmph: number,
  elapsedMs: number,
  speedMultiplier = 1,
): number {
  if (speedKmph <= 0 || elapsedMs <= 0) return 0;
  return speedKmph * ((elapsedMs * speedMultiplier) / MS_PER_HOUR);
}
