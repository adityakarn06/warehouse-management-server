import { env } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import type {
  YardAlert,
  YardDock,
  YardDockAssignment,
  YardOverview,
  YardTruck,
} from '../types/api.js';
import {
  activeAssignmentWhere,
  assignmentRecencyOrder,
  committedAssignmentWhere,
} from './selects.js';

const UPCOMING_ARRIVALS_LIMIT = 10;
const ALERT_LIMIT = 20;

const assignmentSelect = {
  id: true,
  status: true,
  score: true,
  reasons: true,
  scheduledStart: true,
  scheduledEnd: true,
  dockDoorId: true,
  truckId: true,
  truck: { select: { reference: true, eta: true } },
  shipment: { select: { reference: true } },
  dockDoor: { select: { code: true } },
} as const;

type AssignmentRow = {
  id: string;
  status: YardDockAssignment['status'];
  score: number | null;
  reasons: string[];
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  dockDoorId: string;
  truckId: string;
  truck: { reference: string; eta: Date | null };
  shipment: { reference: string } | null;
  dockDoor: { code: string };
};

function toYardAssignment(row: AssignmentRow): YardDockAssignment {
  return {
    id: row.id,
    status: row.status,
    truckId: row.truckId,
    truckReference: row.truck.reference,
    shipmentReference: row.shipment?.reference ?? null,
    dockDoorId: row.dockDoorId,
    dockCode: row.dockDoor.code,
    score: row.score,
    reasons: row.reasons,
    scheduledStart: row.scheduledStart?.toISOString() ?? null,
    scheduledEnd: row.scheduledEnd?.toISOString() ?? null,
    eta: row.truck.eta?.toISOString() ?? null,
  };
}

/**
 * Everything the operations dashboard renders, in one consistent snapshot.
 * The batch runs at REPEATABLE READ because Postgres' default (READ COMMITTED)
 * gives every statement its own snapshot — under the simulation's writes the
 * summary counts would otherwise disagree with the lists they summarise.
 */
export async function getYardOverview(): Promise<YardOverview> {
  const now = new Date();
  const horizon = new Date(now.getTime() + env.ARRIVAL_HORIZON_MINUTES * 60_000);

  const [truckRows, dockRows, assignmentRows, alertRows, unresolvedAlerts] =
    await prisma.$transaction([
      // "Active" = anything the control tower still cares about.
      prisma.truck.findMany({
        where: { status: { not: 'COMPLETED' } },
        orderBy: { reference: 'asc' },
        select: {
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
          route: {
            select: {
              id: true,
              code: true,
              name: true,
              originName: true,
              destinationName: true,
              distanceKm: true,
            },
          },
          shipment: {
            select: {
              id: true,
              reference: true,
              trackingNumber: true,
              priority: true,
              loadType: true,
              status: true,
            },
          },
          // Committed-only — `assignedDockId` drives the reassignment logic,
          // so a recommendation must not look like an assignment.
          dockAssignments: {
            where: committedAssignmentWhere,
            orderBy: assignmentRecencyOrder,
            take: 1,
            select: { dockDoorId: true },
          },
        },
      }),
      prisma.dockDoor.findMany({
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          zone: true,
          status: true,
          supportedLoadTypes: true,
          unavailableReason: true,
          assignments: {
            where: committedAssignmentWhere,
            orderBy: assignmentRecencyOrder,
            take: 1,
            select: assignmentSelect,
          },
        },
      }),
      prisma.dockAssignment.findMany({
        where: activeAssignmentWhere,
        orderBy: assignmentRecencyOrder,
        select: assignmentSelect,
      }),
      prisma.alert.findMany({
        where: { acknowledged: false },
        orderBy: { createdAt: 'desc' },
        take: ALERT_LIMIT,
        select: {
          id: true,
          type: true,
          severity: true,
          title: true,
          message: true,
          truckId: true,
          shipmentId: true,
          dockDoorId: true,
          acknowledged: true,
          createdAt: true,
        },
      }),
      prisma.alert.count({ where: { acknowledged: false } }),
    ], { isolationLevel: 'RepeatableRead' });

  const activeTrucks: YardTruck[] = truckRows.map((truck) => ({
    id: truck.id,
    reference: truck.reference,
    trailerId: truck.trailerId,
    carrier: truck.carrier,
    status: truck.status,
    activeDelay: truck.activeDelay,
    latitude: truck.currentLatitude,
    longitude: truck.currentLongitude,
    progress: truck.progress,
    speedKmph: truck.speedKmph,
    eta: truck.eta?.toISOString() ?? null,
    lastUpdatedAt: truck.lastUpdatedAt.toISOString(),
    route: truck.route,
    shipment: truck.shipment,
    assignedDockId: truck.dockAssignments[0]?.dockDoorId ?? null,
  }));

  const upcomingArrivals = activeTrucks
    .filter((truck) => {
      if (truck.status === 'ARRIVED' || truck.status === 'DOCKED') return false;
      if (truck.status === 'ARRIVING') return true;
      return truck.eta !== null && new Date(truck.eta) <= horizon;
    })
    // Nulls last: an ARRIVING truck with no ETA is not the most imminent one.
    .sort((a, b) => {
      if (a.eta === null) return b.eta === null ? 0 : 1;
      if (b.eta === null) return -1;
      return a.eta.localeCompare(b.eta);
    })
    .slice(0, UPCOMING_ARRIVALS_LIMIT);

  const docks: YardDock[] = dockRows.map((dock) => {
    const current = dock.assignments[0];
    return {
      id: dock.id,
      code: dock.code,
      name: dock.name,
      zone: dock.zone,
      status: dock.status,
      supportedLoadTypes: dock.supportedLoadTypes,
      unavailableReason: dock.unavailableReason,
      currentAssignment: current ? toYardAssignment(current) : null,
    };
  });

  const alerts: YardAlert[] = alertRows.map((alert) => ({
    ...alert,
    createdAt: alert.createdAt.toISOString(),
  }));

  return {
    generatedAt: now.toISOString(),
    summary: {
      activeTrucks: activeTrucks.length,
      delayedTrucks: activeTrucks.filter((truck) => truck.status === 'DELAYED').length,
      arrivingTrucks: activeTrucks.filter((truck) => truck.status === 'ARRIVING').length,
      dockedTrucks: activeTrucks.filter((truck) => truck.status === 'DOCKED').length,
      docksAvailable: docks.filter((dock) => dock.status === 'AVAILABLE').length,
      docksUnavailable: docks.filter((dock) => dock.status === 'UNAVAILABLE').length,
      activeAssignments: assignmentRows.length,
      unresolvedAlerts,
    },
    activeTrucks,
    upcomingArrivals,
    docks,
    activeAssignments: assignmentRows.map(toYardAssignment),
    alerts,
  };
}
