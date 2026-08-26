import { z } from 'zod';

/**
 * Route geometry math. The geometry is FIXED (CLAUDE.md §4) — nothing here ever
 * mutates it. Only the truck's `progress` along it changes.
 *
 * `prisma/seed.ts` carries its own copy of `haversineKm`/`pointAtProgress`
 * because it runs outside the app; this is the version the running server uses,
 * and the two agree so seeded coordinates stay consistent.
 */

export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** The shape of a `Route` row the simulation needs. `geometry` is untyped Json. */
export interface RouteInput {
  id: string;
  distanceKm: number;
  averageSpeedKmph: number;
  geometry: unknown;
}

export interface RouteProfile {
  routeId: string;
  /** Ordered, read-only polyline. */
  coordinates: readonly Coordinate[];
  /** `cumulativeKm[i]` is the geometry distance from the origin to `coordinates[i]`. */
  cumulativeKm: readonly number[];
  /** Total length measured from the polyline itself. */
  geometryKm: number;
  /** The route's declared road distance — what ETA and progress are based on. */
  distanceKm: number;
  averageSpeedKmph: number;
}

const EARTH_RADIUS_KM = 6371;

const coordinateSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

const geometrySchema = z.array(coordinateSchema).min(2);

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineKm(a: Coordinate, b: Coordinate): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** `Route.geometry` is a bare Json column, so narrow it before trusting it. */
export function parseGeometry(json: unknown): Coordinate[] {
  const result = geometrySchema.safeParse(json);
  if (!result.success) {
    throw new Error('Route geometry must be an array of at least two {latitude, longitude} points');
  }
  return result.data;
}

/**
 * Profiles are memoised: geometry is parsed and measured once per route, never
 * per tick (§24). Routes are immutable during a run.
 */
const profileCache = new Map<string, RouteProfile>();

export function buildRouteProfile(route: RouteInput): RouteProfile {
  const cached = profileCache.get(route.id);
  if (cached) return cached;

  const coordinates = parseGeometry(route.geometry);

  const cumulativeKm: number[] = [0];
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const from = coordinates[i - 1];
    const to = coordinates[i];
    if (!from || !to) continue;
    total += haversineKm(from, to);
    cumulativeKm.push(total);
  }

  const profile: RouteProfile = {
    routeId: route.id,
    coordinates,
    cumulativeKm,
    geometryKm: total,
    distanceKm: route.distanceKm,
    averageSpeedKmph: route.averageSpeedKmph,
  };

  profileCache.set(route.id, profile);
  return profile;
}

/** Only for tests and `SimulationManager.reset()`. */
export function clearRouteProfileCache(): void {
  profileCache.clear();
}

export const clampProgress = (progress: number): number =>
  Math.min(100, Math.max(0, progress));

/** The point on the polyline at `progress` (0-100) of its length. */
export function pointAtProgress(profile: RouteProfile, progress: number): Coordinate {
  const { coordinates, cumulativeKm, geometryKm } = profile;

  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (!first || !last) {
    throw new Error(`Route ${profile.routeId} has no geometry`);
  }

  const clamped = clampProgress(progress);
  if (clamped <= 0 || geometryKm === 0) return first;
  if (clamped >= 100) return last;

  const target = (clamped / 100) * geometryKm;

  for (let i = 1; i < coordinates.length; i += 1) {
    const legEnd = cumulativeKm[i];
    const legStart = cumulativeKm[i - 1];
    const from = coordinates[i - 1];
    const to = coordinates[i];
    if (legEnd === undefined || legStart === undefined || !from || !to) continue;
    if (target > legEnd) continue;

    const legKm = legEnd - legStart;
    const t = legKm === 0 ? 0 : (target - legStart) / legKm;
    return {
      latitude: from.latitude + (to.latitude - from.latitude) * t,
      longitude: from.longitude + (to.longitude - from.longitude) * t,
    };
  }

  return last;
}

/**
 * Progress after travelling `km` further. Uses the route's declared road
 * distance (1490 / 680 / 400 km) rather than the polyline length, so progress
 * and ETA agree with the distance the API already reports.
 */
export function progressAfterKm(profile: RouteProfile, progress: number, km: number): number {
  if (profile.distanceKm <= 0) return 100;
  return clampProgress(progress + (km / profile.distanceKm) * 100);
}

/** Road kilometres still to drive. */
export function remainingKm(profile: RouteProfile, progress: number): number {
  return ((100 - clampProgress(progress)) / 100) * profile.distanceKm;
}
