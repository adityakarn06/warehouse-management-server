import type { Prisma } from '../generated/prisma/client.js';
import { HttpError } from '../lib/http-error.js';
import { prisma } from '../lib/prisma.js';
import type { TrackingResponse } from '../types/api.js';
import { assignmentRecencyOrder, committedAssignmentWhere } from './selects.js';

const trackingSelect = {
  reference: true,
  trackingNumber: true,
  customerName: true,
  status: true,
  priority: true,
  loadType: true,
  appointment: {
    select: { windowStart: true, windowEnd: true, expectedDurationMinutes: true },
  },
  truck: {
    select: {
      trailerId: true,
      status: true,
      activeDelay: true,
      currentLatitude: true,
      currentLongitude: true,
      progress: true,
      eta: true,
      lastUpdatedAt: true,
      route: {
        select: {
          originName: true,
          originLatitude: true,
          originLongitude: true,
          destinationName: true,
          destinationLatitude: true,
          destinationLongitude: true,
        },
      },
      // Committed-only — a customer must never be told to expect a door
      // that was merely recommended.
      dockAssignments: {
        where: committedAssignmentWhere,
        orderBy: assignmentRecencyOrder,
        take: 1,
        select: {
          status: true,
          scheduledStart: true,
          scheduledEnd: true,
          dockDoor: {
            select: { id: true, code: true, name: true, zone: true, status: true },
          },
        },
      },
    },
  },
} as const;

type TrackingRow = Prisma.ShipmentGetPayload<{ select: typeof trackingSelect }>;

/**
 * Resolves the identifier a customer might type or scan into the shipment it
 * names — a tracking link carries `trackingNumber`, a CS agent might have the
 * shipment's own `reference` or `id`, and a warehouse handoff might only have
 * the physical `trailerId`. Tries each arm in turn and stops at the first hit,
 * mirroring the project's id-then-natural-key convention (`getTruckById`).
 */
async function findShipmentByIdentifier(identifier: string): Promise<{
  row: TrackingRow;
  resolvedBy: TrackingResponse['resolvedBy'];
} | null> {
  const byTrackingNumber = await prisma.shipment.findUnique({
    where: { trackingNumber: identifier },
    select: trackingSelect,
  });
  if (byTrackingNumber) return { row: byTrackingNumber, resolvedBy: 'TRACKING_NUMBER' };

  const byReference = await prisma.shipment.findUnique({
    where: { reference: identifier },
    select: trackingSelect,
  });
  if (byReference) return { row: byReference, resolvedBy: 'SHIPMENT_REFERENCE' };

  const byId = await prisma.shipment.findUnique({
    where: { id: identifier },
    select: trackingSelect,
  });
  if (byId) return { row: byId, resolvedBy: 'SHIPMENT_ID' };

  const byTrailerId = await prisma.shipment.findFirst({
    where: { truck: { trailerId: identifier } },
    select: trackingSelect,
  });
  if (byTrailerId) return { row: byTrailerId, resolvedBy: 'TRAILER_ID' };

  return null;
}

/**
 * Customer-facing tracking lookup. Accepts a tracking number, shipment
 * reference or id, or trailer id (§1 of the problem statement). One matching
 * query, then hand-shaped into a flat DTO so no raw Prisma row is ever exposed
 * on this endpoint.
 */
export async function getTrackingByNumber(identifier: string): Promise<TrackingResponse> {
  const found = await findShipmentByIdentifier(identifier);

  if (!found) {
    throw HttpError.notFound(`No shipment found for ${identifier}`);
  }

  const { row: shipment, resolvedBy } = found;
  const { truck } = shipment;
  const { route } = truck;
  const assignment = truck.dockAssignments[0];
  const appointment = shipment.appointment;

  return {
    reference: shipment.reference,
    trackingNumber: shipment.trackingNumber,
    trailerId: truck.trailerId,
    resolvedBy,
    customerName: shipment.customerName,
    status: shipment.status,
    truckStatus: truck.status,
    activeDelay: truck.activeDelay,
    origin: {
      name: route.originName,
      latitude: route.originLatitude,
      longitude: route.originLongitude,
    },
    destination: {
      name: route.destinationName,
      latitude: route.destinationLatitude,
      longitude: route.destinationLongitude,
    },
    currentPosition: {
      latitude: truck.currentLatitude,
      longitude: truck.currentLongitude,
      lastUpdatedAt: truck.lastUpdatedAt.toISOString(),
    },
    eta: truck.eta?.toISOString() ?? null,
    progress: truck.progress,
    priority: shipment.priority,
    loadType: shipment.loadType,
    appointmentWindow: appointment
      ? {
          start: appointment.windowStart.toISOString(),
          end: appointment.windowEnd.toISOString(),
          expectedDurationMinutes: appointment.expectedDurationMinutes,
        }
      : null,
    assignedDock: assignment
      ? {
          id: assignment.dockDoor.id,
          code: assignment.dockDoor.code,
          name: assignment.dockDoor.name,
          zone: assignment.dockDoor.zone,
          status: assignment.dockDoor.status,
          assignmentStatus: assignment.status,
          scheduledStart: assignment.scheduledStart?.toISOString() ?? null,
          scheduledEnd: assignment.scheduledEnd?.toISOString() ?? null,
        }
      : null,
  };
}
