import type { AssignmentStatus } from '../generated/prisma/enums.js';

/**
 * Reusable Prisma `select` fragments.
 *
 * `Route.geometry` is deliberately absent from every fragment here — only
 * `GET /api/v1/routes/:id` returns it (CLAUDE.md §24).
 */

export const routeSummarySelect = {
  id: true,
  code: true,
  name: true,
  originName: true,
  destinationName: true,
  distanceKm: true,
} as const;

export const routeDetailSelect = {
  id: true,
  code: true,
  name: true,
  originName: true,
  originLatitude: true,
  originLongitude: true,
  destinationName: true,
  destinationLatitude: true,
  destinationLongitude: true,
  distanceKm: true,
  estimatedDurationMinutes: true,
  averageSpeedKmph: true,
} as const;

export const truckSummarySelect = {
  id: true,
  reference: true,
  trailerId: true,
  carrier: true,
  status: true,
  activeDelay: true,
  currentLatitude: true,
  currentLongitude: true,
  progress: true,
  speedKmph: true,
  eta: true,
  lastUpdatedAt: true,
} as const;

export const shipmentSummarySelect = {
  id: true,
  reference: true,
  trackingNumber: true,
  customerName: true,
  status: true,
  priority: true,
  loadType: true,
} as const;

export const dockSummarySelect = {
  id: true,
  code: true,
  name: true,
  zone: true,
  status: true,
  supportedLoadTypes: true,
} as const;

export const appointmentSelect = {
  id: true,
  reference: true,
  windowStart: true,
  windowEnd: true,
  expectedDurationMinutes: true,
  notes: true,
} as const;

/** Assignments a truck/dock is currently bound to (as opposed to historic ones). */
export const ACTIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = ['ASSIGNED', 'RECOMMENDED'];

/**
 * Assignments that actually commit a truck to a door. A `RECOMMENDED` row is
 * only a proposal, so it must never be reported as *the* dock a truck is on —
 * use this (not `activeAssignmentWhere`) for any "current assignment" lookup.
 */
export const COMMITTED_ASSIGNMENT_STATUSES: AssignmentStatus[] = ['ASSIGNED'];

/**
 * Declared outside any `as const` select so the `in` arrays stay mutable —
 * Prisma's filter types reject `readonly` arrays.
 */
export const activeAssignmentWhere = { status: { in: ACTIVE_ASSIGNMENT_STATUSES } };
export const committedAssignmentWhere = { status: { in: COMMITTED_ASSIGNMENT_STATUSES } };

const DESC = 'desc' as const;

/**
 * `createdAt` is not a unique key — the seed's `createMany` stamps a whole batch
 * with the same timestamp — so ordering by it alone makes every `take: 1`
 * non-deterministic. `id` breaks the tie. Kept out of the `as const` selects for
 * the same `readonly` reason as above.
 */
export const assignmentRecencyOrder = [{ createdAt: DESC }, { id: DESC }];
