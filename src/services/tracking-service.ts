import { HttpError } from '../lib/http-error.js';
import { prisma } from '../lib/prisma.js';
import type { TrackingResponse } from '../types/api.js';
import { assignmentRecencyOrder, committedAssignmentWhere } from './selects.js';

/**
 * Customer-facing tracking lookup. One query, then hand-shaped into a flat DTO
 * so no raw Prisma row is ever exposed on this endpoint.
 */
export async function getTrackingByNumber(trackingNumber: string): Promise<TrackingResponse> {
  const shipment = await prisma.shipment.findUnique({
    where: { trackingNumber },
    select: {
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
    },
  });

  if (!shipment) {
    throw HttpError.notFound(`No shipment found for tracking number ${trackingNumber}`);
  }

  const { truck } = shipment;
  const { route } = truck;
  const assignment = truck.dockAssignments[0];
  const appointment = shipment.appointment;

  return {
    reference: shipment.reference,
    trackingNumber: shipment.trackingNumber,
    trailerId: truck.trailerId,
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
