import {
  alertCreatedPayload,
  dockStatusChangedEvent,
} from '../docking/docking-events.js';
import type {
  LocationSnapshotReason,
  ShipmentStatus,
  TruckStatus,
} from '../generated/prisma/enums.js';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { WmsEvent, WmsEventType } from '../schemas/wms.js';
import type { CreateAlertInput } from '../services/alert-service.js';
import { createAlert } from '../services/alert-service.js';
import { releaseDock } from '../docking/dock-assignment-service.js';
import { getDockById, setDockStatus } from '../services/dock-service.js';
import type { ExternalTruckUpdate } from '../simulation/simulation-manager.js';
import { simulationManager } from '../simulation/simulation-manager.js';
import type { AlertCreatedPayload, RealtimeEventType } from '../websocket/events.js';
import type { WmsTruckSnapshot } from './wms-realtime.js';
import { truckPositionPayloadFor, truckStatusPayloadFor, wmsSink } from './wms-realtime.js';

/**
 * The WMS event handler (CLAUDE.md §15).
 *
 * Translates external warehouse vocabulary into internal domain concepts and
 * drives the services every other phase already writes through — it owns no
 * persistence rules of its own beyond the mapping. The controller above it does
 * nothing but parse and hand over.
 *
 * Layering, as §15 draws it:
 *
 *   WmsEventHandler -> { SimulationManager, DockService, AlertService } -> Prisma
 *                   -> WmsRealtimeSink -> RealtimeService -> Socket.IO
 *
 * The handler never imports Socket.IO, and it never emits truck events for a
 * truck the engine is simulating — `applyExternalUpdate` does that through the
 * engine's own sink, so the single event path stays single (§14).
 */

export interface WmsEventResult {
  eventType: WmsEventType;
  /**
   * False when the event changed nothing. Re-sending a fact that is already
   * true is a success: a feed that retries must not collect errors.
   */
  applied: boolean;
  truckId: string | null;
  dockDoorId: string | null;
  /** Human sentences for the demo panel: "TRK-101 ARRIVED -> DOCKED". */
  effects: string[];
  /** Which realtime events this ingestion raised. */
  emitted: RealtimeEventType[];
  alert: AlertCreatedPayload | null;
}

/** The truck columns the WMS paths read. Narrow on purpose — never a whole row. */
const wmsTruckSelect = {
  id: true,
  reference: true,
  trailerId: true,
  status: true,
  activeDelay: true,
  currentLatitude: true,
  currentLongitude: true,
  progress: true,
  speedKmph: true,
  eta: true,
  arrivedAt: true,
  shipment: { select: { id: true, status: true } },
  route: {
    select: { id: true, destinationLatitude: true, destinationLongitude: true },
  },
} as const;

type WmsTruck = NonNullable<Awaited<ReturnType<typeof findTruckByAnyKey>>>;

async function findTruckByAnyKey(key: string) {
  // The project's id-then-natural-key convention, with a third arm: the WMS
  // knows a trailer by its own identifier, not ours. `trailerId` is @unique and
  // already seeded (TRL-101), so this needs no schema change.
  const byId = await prisma.truck.findUnique({ where: { id: key }, select: wmsTruckSelect });
  if (byId) return byId;

  const byReference = await prisma.truck.findUnique({
    where: { reference: key },
    select: wmsTruckSelect,
  });
  if (byReference) return byReference;

  return prisma.truck.findUnique({ where: { trailerId: key }, select: wmsTruckSelect });
}

async function resolveTrailer(trailerId: string): Promise<WmsTruck> {
  const truck = await findTruckByAnyKey(trailerId);
  if (!truck) throw HttpError.notFound(`Trailer ${trailerId} was not found`);
  return truck;
}

/** The narrow view the hand-built payload builders take. */
function snapshotOf(truck: WmsTruck): WmsTruckSnapshot {
  return {
    id: truck.id,
    reference: truck.reference,
    status: truck.status,
    activeDelay: truck.activeDelay,
    currentLatitude: truck.currentLatitude,
    currentLongitude: truck.currentLongitude,
    progress: truck.progress,
    speedKmph: truck.speedKmph,
    eta: truck.eta,
    shipmentId: truck.shipment?.id ?? null,
  };
}

/**
 * Writes an alert and emits it. Copied from `dock-failure-service.ts` for the
 * same reason it exists there: `createAlert` never emits (§14), and losing the
 * audit row must never fail a command whose real effect has already landed.
 */
async function raise(input: CreateAlertInput, context: string): Promise<AlertCreatedPayload | null> {
  try {
    const payload = alertCreatedPayload(await createAlert(input));
    wmsSink().emit({ type: 'ALERT_CREATED', data: payload });
    return payload;
  } catch (error) {
    logger.error(`Failed to raise WMS alert for ${context}`, error);
    return null;
  }
}

/** Truck statuses that mirror 1:1 onto the shipment. */
const SHIPMENT_STATUS_FOR: Partial<Record<TruckStatus, ShipmentStatus>> = {
  IN_TRANSIT: 'IN_TRANSIT',
  ARRIVING: 'ARRIVING',
  ARRIVED: 'ARRIVED',
  DOCKED: 'DOCKED',
  COMPLETED: 'DELIVERED',
};

/** Statuses meaning "the trailer is already in the yard". */
const ARRIVED_OR_LATER: TruckStatus[] = ['ARRIVED', 'DOCKED', 'COMPLETED'];

/** The snapshot reason a status transition deserves, or null for no row. */
const SNAPSHOT_REASON_FOR: Partial<Record<TruckStatus, LocationSnapshotReason>> = {
  ARRIVING: 'ARRIVING',
  ARRIVED: 'ARRIVED',
  DOCKED: 'DOCKED',
  COMPLETED: 'COMPLETED',
};

/** Keeps the shipment in step with its truck. Idempotent. */
async function mirrorShipment(
  truck: WmsTruck,
  shipmentStatus: ShipmentStatus | undefined,
): Promise<void> {
  if (!truck.shipment || !shipmentStatus || truck.shipment.status === shipmentStatus) return;
  await prisma.shipment.update({
    where: { id: truck.shipment.id },
    data: { status: shipmentStatus },
  });
}

/**
 * Apply a fact to one truck, whichever side of the simulation it lives on.
 *
 * The engine is asked first: if it is tracking this truck, it owns the live
 * state, the sequence numbers and the emission. If it is not — a stopped loop,
 * or a truck parked in the yard, which the engine never loads — we write the
 * row ourselves and build the payloads by hand.
 */
async function applyTruckFact(
  truck: WmsTruck,
  update: ExternalTruckUpdate,
  reason: LocationSnapshotReason | null,
  now: Date,
): Promise<{ emitted: RealtimeEventType[] }> {
  const nextStatus = update.status ?? truck.status;
  const shipmentStatus = SHIPMENT_STATUS_FOR[nextStatus];

  const live = await simulationManager.applyExternalUpdate(truck.id, update, reason);

  if (live) {
    // The shipment is mirrored here rather than left to the engine's `persist`,
    // which maps only the reasons *it* writes (ARRIVING/ARRIVED). Without this
    // the same event would move the shipment or not depending on whether the
    // loop happened to be running — two answers to one question.
    await mirrorShipment(truck, shipmentStatus);
    // `emitted` comes from the engine: only it knows what its comparison
    // against live state actually raised.
    return { emitted: live.emitted };
  }

  const written = await prisma.$transaction(async (tx) => {
    const row = await tx.truck.update({
      where: { id: truck.id },
      data: {
        ...(update.latitude === undefined ? {} : { currentLatitude: update.latitude }),
        ...(update.longitude === undefined ? {} : { currentLongitude: update.longitude }),
        ...(update.progress === undefined ? {} : { progress: update.progress }),
        ...(update.speedKmph === undefined ? {} : { speedKmph: update.speedKmph }),
        ...(update.status === undefined ? {} : { status: update.status }),
        ...(update.activeDelay === undefined ? {} : { activeDelay: update.activeDelay }),
        ...(update.eta === undefined ? {} : { eta: update.eta }),
        ...(update.arrivedAt === undefined ? {} : { arrivedAt: update.arrivedAt }),
        lastUpdatedAt: now,
      },
      select: wmsTruckSelect,
    });

    if (reason !== null) {
      await tx.locationHistory.create({
        data: {
          truckId: row.id,
          latitude: row.currentLatitude,
          longitude: row.currentLongitude,
          progress: row.progress,
          speedKmph: row.speedKmph,
          status: row.status,
          eta: row.eta,
          reason,
          recordedAt: now,
        },
      });
    }

    if (truck.shipment && shipmentStatus && truck.shipment.status !== shipmentStatus) {
      await tx.shipment.update({
        where: { id: truck.shipment.id },
        data: { status: shipmentStatus },
      });
    }

    return row;
  });

  const emitted: RealtimeEventType[] = [];
  const snapshot = snapshotOf(written);

  const moved =
    update.latitude !== undefined ||
    update.longitude !== undefined ||
    update.progress !== undefined;

  if (moved) {
    wmsSink().emit({
      type: 'TRUCK_POSITION_UPDATED',
      data: truckPositionPayloadFor(snapshot, simulationManager.nextSequence(truck.id), now, {
        latitude: truck.currentLatitude,
        longitude: truck.currentLongitude,
      }),
    });
    emitted.push('TRUCK_POSITION_UPDATED');
  }

  if (written.status !== truck.status) {
    wmsSink().emit({
      type: 'TRUCK_STATUS_CHANGED',
      data: truckStatusPayloadFor(
        snapshot,
        truck.status,
        simulationManager.nextSequence(truck.id),
        now,
      ),
    });
    emitted.push('TRUCK_STATUS_CHANGED');
  }

  return { emitted };
}

// --- Per-event handlers ----------------------------------------------------

async function onTrailerLocationUpdated(
  event: Extract<WmsEvent, { eventType: 'TRAILER_LOCATION_UPDATED' }>,
  now: Date,
): Promise<WmsEventResult> {
  const truck = await resolveTrailer(event.trailerId);

  // No LocationHistory row: a position is not a business event (§5, §24). The
  // engine, if it is tracking this truck, resumes from the reported point —
  // `advanceTruck` is progress- and elapsed-time-based, so this is a resync
  // rather than a fight between two sources of truth.
  const { emitted } = await applyTruckFact(
    truck,
    {
      latitude: event.yardLocation.lat,
      longitude: event.yardLocation.lng,
      ...(event.progress === undefined ? {} : { progress: event.progress }),
      ...(event.speedKmph === undefined ? {} : { speedKmph: event.speedKmph }),
    },
    null,
    now,
  );

  return {
    eventType: event.eventType,
    applied: true,
    truckId: truck.id,
    dockDoorId: null,
    effects: [
      `${truck.reference} repositioned to ${event.yardLocation.lat}, ${event.yardLocation.lng}`,
    ],
    emitted,
    alert: null,
  };
}

async function onTrailerStatusUpdated(
  event: Extract<WmsEvent, { eventType: 'TRAILER_STATUS_UPDATED' }>,
  now: Date,
): Promise<WmsEventResult> {
  const truck = await resolveTrailer(event.trailerId);

  // A delay only means anything while the truck is still driving. Sending it
  // back onto the road without going through `clear-delay` would leave
  // `activeDelay: RAIN` and the reduced speed standing next to an IN_TRANSIT
  // status — the mirror image of the state this event's schema refuses.
  // Arriving is different: the journey is over, so the scenario ends with it,
  // which the ARRIVED/COMPLETED branch below does explicitly.
  if (truck.activeDelay !== 'NORMAL' && !ARRIVED_OR_LATER.includes(event.status)) {
    throw HttpError.conflict(
      `${truck.reference} has an active ${truck.activeDelay} delay — clear it with ` +
        `POST /api/v1/simulation/trucks/${truck.reference}/clear-delay before reporting ${event.status}`,
    );
  }

  // `yardLocation` counts: a feed re-stating a status while reporting a new
  // position is telling us something, and discarding it would drop the move.
  const unchanged =
    truck.status === event.status && event.eta === undefined && event.yardLocation === undefined;
  if (unchanged) {
    return {
      eventType: event.eventType,
      applied: false,
      truckId: truck.id,
      dockDoorId: null,
      effects: [`${truck.reference} is already ${event.status}`],
      emitted: [],
      alert: null,
    };
  }

  const previousStatus = truck.status;
  const reason = SNAPSHOT_REASON_FOR[event.status] ?? null;

  const { emitted } = await applyTruckFact(
    truck,
    {
      status: event.status,
      // The journey is over, so any scenario riding on it ends too, and a
      // future ETA left standing would have the truck arriving after it got here.
      ...(ARRIVED_OR_LATER.includes(event.status)
        ? { activeDelay: 'NORMAL' as const, speedKmph: 0, eta: null }
        : {}),
      // `null` clears the estimate; absent recomputes from position.
      ...(event.eta === undefined ? {} : { eta: event.eta === null ? null : new Date(event.eta) }),
      ...(event.yardLocation === undefined
        ? {}
        : { latitude: event.yardLocation.lat, longitude: event.yardLocation.lng }),
    },
    // Only write a snapshot for a status that actually moved.
    event.status === previousStatus ? null : reason,
    now,
  );

  // Reuses the existing TRUCK_ARRIVING type — the WMS adds no alert types.
  const alert =
    event.status === 'ARRIVING' && previousStatus !== 'ARRIVING'
      ? await raise(
          {
            type: 'TRUCK_ARRIVING',
            severity: 'INFO',
            title: `${truck.reference} is arriving`,
            message: `WMS reports ${truck.trailerId} approaching the yard.`,
            truckId: truck.id,
            shipmentId: truck.shipment?.id ?? null,
            metadata: { source: 'WMS', previousStatus },
          },
          truck.reference,
        )
      : null;

  return {
    eventType: event.eventType,
    applied: true,
    truckId: truck.id,
    dockDoorId: null,
    effects: [`${truck.reference} ${previousStatus} -> ${event.status}`],
    emitted: alert ? [...emitted, 'ALERT_CREATED'] : emitted,
    alert,
  };
}

async function onTrailerArrived(
  event: Extract<WmsEvent, { eventType: 'TRAILER_ARRIVED' }>,
  now: Date,
): Promise<WmsEventResult> {
  const truck = await resolveTrailer(event.trailerId);

  // Anything at or past ARRIVED means the trailer is already here. A late or
  // retried arrival must not drag a DOCKED truck back to the gate — it would
  // restamp `arrivedAt`, pull the shipment back from DOCKED, write a bogus
  // ARRIVED snapshot and emit a reversing status change, all while the door it
  // is standing at stays OCCUPIED.
  if (ARRIVED_OR_LATER.includes(truck.status)) {
    return {
      eventType: event.eventType,
      applied: false,
      truckId: truck.id,
      dockDoorId: null,
      effects: [`${truck.reference} is already ${truck.status}`],
      emitted: [],
      alert: null,
    };
  }

  const { emitted } = await applyTruckFact(
    truck,
    {
      status: 'ARRIVED',
      // The journey is over, so any delay scenario riding on it ends with it.
      activeDelay: 'NORMAL',
      progress: 100,
      speedKmph: 0,
      // Standing at the gate: the route's destination unless the WMS says
      // otherwise. Not a guess — every seeded route ends at the warehouse.
      latitude: event.yardLocation?.lat ?? truck.route.destinationLatitude,
      longitude: event.yardLocation?.lng ?? truck.route.destinationLongitude,
      eta: null,
      arrivedAt: now,
    },
    'ARRIVED',
    now,
  );

  return {
    eventType: event.eventType,
    applied: true,
    truckId: truck.id,
    dockDoorId: null,
    effects: [`${truck.reference} ${truck.status} -> ARRIVED`],
    emitted,
    alert: null,
  };
}

async function onTrailerDocked(
  event: Extract<WmsEvent, { eventType: 'TRAILER_DOCKED' }>,
  now: Date,
): Promise<WmsEventResult> {
  const truck = await resolveTrailer(event.trailerId);
  const dock = await getDockById(event.dockCode);

  const assignment = await prisma.dockAssignment.findFirst({
    where: { truckId: truck.id, dockDoorId: dock.id, status: 'ASSIGNED' },
    select: { id: true },
  });

  // The WMS reports physical reality; it does not create bookings the scoring
  // engine never ranked. Refusing here keeps `DOCK_ASSIGNED` the only way a
  // truck acquires a door, so the timeline stays explainable (§9).
  if (!assignment) {
    const held = await prisma.dockAssignment.findFirst({
      where: { truckId: truck.id, status: 'ASSIGNED' },
      select: { dockDoor: { select: { code: true } } },
    });
    throw HttpError.conflict(
      `${truck.reference} is not assigned to ${dock.code}` +
        (held ? ` — it holds ${held.dockDoor.code}` : ' — it holds no dock assignment'),
    );
  }

  // Same rule the DOCK_STATUS_UPDATED path enforces: believing the feed about a
  // door that is out of service would clear a fault nobody fixed.
  if (dock.status === 'UNAVAILABLE') {
    throw HttpError.conflict(
      `${dock.code} is out of service (${dock.unavailableReason ?? 'no reason given'}) ` +
        `and cannot take ${truck.reference}`,
    );
  }

  if (truck.status === 'DOCKED' && dock.status === 'OCCUPIED') {
    return {
      eventType: event.eventType,
      applied: false,
      truckId: truck.id,
      dockDoorId: dock.id,
      effects: [`${truck.reference} is already docked at ${dock.code}`],
      emitted: [],
      alert: null,
    };
  }

  const previousDockStatus = dock.status;
  const previousTruckStatus = truck.status;

  // One transaction: a truck recorded as DOCKED against a door still showing
  // RESERVED is exactly the kind of half-state the board cannot explain.
  await prisma.$transaction(async (tx) => {
    await tx.dockDoor.update({
      where: { id: dock.id },
      // `availableFrom` is cleared: the door is busy now, and "free from" is a
      // promise about a booking, not about a trailer physically in the bay.
      data: { status: 'OCCUPIED', availableFrom: null },
    });

    const row = await tx.truck.update({
      where: { id: truck.id },
      data: { status: 'DOCKED', speedKmph: 0, progress: 100, eta: null, lastUpdatedAt: now },
      select: wmsTruckSelect,
    });

    await tx.locationHistory.create({
      data: {
        truckId: row.id,
        latitude: row.currentLatitude,
        longitude: row.currentLongitude,
        progress: row.progress,
        speedKmph: row.speedKmph,
        status: row.status,
        eta: row.eta,
        reason: 'DOCKED',
        recordedAt: now,
      },
    });

    if (truck.shipment && truck.shipment.status !== 'DOCKED') {
      await tx.shipment.update({ where: { id: truck.shipment.id }, data: { status: 'DOCKED' } });
    }
  });

  // The engine drops a docked truck on its next reload; until then its live
  // entry must not keep advancing a trailer that is standing in a bay.
  const live = await simulationManager.applyExternalUpdate(
    truck.id,
    { status: 'DOCKED', activeDelay: 'NORMAL', speedKmph: 0, progress: 100, eta: null },
    null,
  );

  const updated = await prisma.dockDoor.findUniqueOrThrow({
    where: { id: dock.id },
    select: { id: true, code: true, status: true, unavailableReason: true },
  });

  wmsSink().emit(dockStatusChangedEvent(updated, previousDockStatus, now));

  // The engine announces the transition itself for any truck it is tracking, so
  // emitting again here would send subscribers the same status change twice
  // under two different sequence numbers. Only the parked case needs us.
  let truckEvents: RealtimeEventType[] = live?.emitted ?? [];

  if (!live) {
    wmsSink().emit({
      type: 'TRUCK_STATUS_CHANGED',
      data: truckStatusPayloadFor(
        { ...snapshotOf(truck), status: 'DOCKED', speedKmph: 0, progress: 100, eta: null },
        previousTruckStatus,
        simulationManager.nextSequence(truck.id),
        now,
      ),
    });
    truckEvents = ['TRUCK_STATUS_CHANGED'];
  }

  return {
    eventType: event.eventType,
    applied: true,
    truckId: truck.id,
    dockDoorId: dock.id,
    effects: [
      `${dock.code} ${previousDockStatus} -> OCCUPIED`,
      `${truck.reference} ${previousTruckStatus} -> DOCKED`,
    ],
    emitted: ['DOCK_STATUS_CHANGED', ...truckEvents],
    alert: null,
  };
}

async function onDockStatusUpdated(
  event: Extract<WmsEvent, { eventType: 'DOCK_STATUS_UPDATED' }>,
  now: Date,
): Promise<WmsEventResult> {
  const current = await getDockById(event.dockCode);

  // Freeing a door the feed itself occupied. `setDockStatus` cannot do this:
  // "make available" is the operator's put-it-back-in-service button, and it
  // treats a door that is not UNAVAILABLE as a no-op — so without this branch
  // the WMS could occupy a bay and never release it. `releaseDock` is the right
  // reuse: a trailer leaving the bay also completes whatever assignment was
  // holding it, which is precisely what departure means.
  if (event.status === 'AVAILABLE' && current.status === 'OCCUPIED') {
    const released = await releaseDock(current.id, now);

    return {
      eventType: event.eventType,
      applied: true,
      truckId: null,
      dockDoorId: released.dockDoorId,
      effects: [
        `${released.dockCode} OCCUPIED -> ${released.status}`,
        ...released.releasedAssignmentIds.map((id) => `assignment ${id} COMPLETED`),
      ],
      emitted: released.status === current.status ? [] : ['DOCK_STATUS_CHANGED'],
      alert: null,
    };
  }

  // AVAILABLE / UNAVAILABLE are otherwise exactly the operator command, so they
  // go through the same service and inherit the whole Phase 8 cascade —
  // affected trucks, reassignments and alerts included. Reimplementing any of
  // that here would give the yard two different answers to the same question.
  if (event.status !== 'OCCUPIED') {
    const result = await setDockStatus(event.dockCode, event.status, event.reason, now);

    const effects = result.changed
      ? [`${result.dock.code} -> ${result.dock.status}`]
      : [`${result.dock.code} is already ${result.dock.status}`];

    for (const move of result.reassignments) {
      effects.push(
        move.outcome === 'REASSIGNED'
          ? `${move.truckReference} ${move.previousDockCode} -> ${move.newDockCode}`
          : `${move.truckReference}: ${move.outcome}`,
      );
    }

    const emitted: RealtimeEventType[] = result.changed ? ['DOCK_STATUS_CHANGED'] : [];
    if (result.alert) emitted.push('ALERT_CREATED');
    if (result.reassignments.some((move) => move.outcome === 'REASSIGNED')) {
      emitted.push('DOCK_REASSIGNED');
    }

    return {
      eventType: event.eventType,
      applied: result.changed,
      truckId: null,
      dockDoorId: result.dock.id,
      effects,
      emitted,
      alert: result.alert,
    };
  }

  // OCCUPIED is the one status only this feed may write: a trailer has
  // physically backed in. The assignment engine owns RESERVED (refused by the
  // schema) and the operator owns the other two.
  const dock = current;

  if (dock.status === 'OCCUPIED') {
    return {
      eventType: event.eventType,
      applied: false,
      truckId: null,
      dockDoorId: dock.id,
      effects: [`${dock.code} is already OCCUPIED`],
      emitted: [],
      alert: null,
    };
  }

  // A door that is out of service is not available to be occupied — believing
  // the feed here would clear a fault nobody fixed.
  if (dock.status === 'UNAVAILABLE') {
    throw HttpError.conflict(
      `${dock.code} is out of service (${dock.unavailableReason ?? 'no reason given'}) ` +
        'and cannot be reported as occupied',
    );
  }

  const updated = await prisma.dockDoor.update({
    where: { id: dock.id },
    data: { status: 'OCCUPIED', availableFrom: null },
    select: { id: true, code: true, status: true, unavailableReason: true },
  });

  wmsSink().emit(dockStatusChangedEvent(updated, dock.status, now));

  return {
    eventType: event.eventType,
    applied: true,
    truckId: null,
    dockDoorId: dock.id,
    effects: [`${dock.code} ${dock.status} -> OCCUPIED`],
    emitted: ['DOCK_STATUS_CHANGED'],
    alert: null,
  };
}

async function onAppointmentUpdated(
  event: Extract<WmsEvent, { eventType: 'APPOINTMENT_UPDATED' }>,
): Promise<WmsEventResult> {
  const key = event.appointmentReference;
  const appointment =
    (await prisma.appointment.findUnique({
      where: { reference: key },
      select: { id: true, reference: true, windowStart: true, windowEnd: true, shipmentId: true },
    })) ??
    (await prisma.appointment.findUnique({
      where: { id: key },
      select: { id: true, reference: true, windowStart: true, windowEnd: true, shipmentId: true },
    }));

  if (!appointment) throw HttpError.notFound(`Appointment ${key} was not found`);

  const windowStart =
    event.windowStart === undefined ? appointment.windowStart : new Date(event.windowStart);
  const windowEnd =
    event.windowEnd === undefined ? appointment.windowEnd : new Date(event.windowEnd);

  // Checked here rather than in the schema: either bound may be omitted, so
  // only the merged row is comparable.
  if (windowEnd <= windowStart) {
    throw HttpError.badRequest(
      `Appointment ${appointment.reference} would end at or before it starts`,
    );
  }

  await prisma.appointment.update({
    where: { id: appointment.id },
    data: {
      windowStart,
      windowEnd,
      ...(event.expectedDurationMinutes === undefined
        ? {}
        : { expectedDurationMinutes: event.expectedDurationMinutes }),
      ...(event.notes === undefined ? {} : { notes: event.notes }),
    },
  });

  // Deliberately emits nothing. §13 fixes the realtime contract at seven
  // events, all of which have writers; an eighth would mean a new member, a new
  // room rule, a doc row and a frontend change for a fact the frontend can
  // re-read. The real effect is on the scoring engine — a moved window re-ranks
  // GET /trucks/:truckId/dock-recommendations through `appointmentFit`.
  return {
    eventType: event.eventType,
    applied: true,
    truckId: null,
    dockDoorId: null,
    effects: [
      `${appointment.reference} window -> ${windowStart.toISOString()} .. ${windowEnd.toISOString()}`,
    ],
    emitted: [],
    alert: null,
  };
}

/**
 * The one entry point. Validation has already happened in the controller, so
 * everything reaching here is a well-formed event of a known type.
 */
export async function handleWmsEvent(event: WmsEvent, now = new Date()): Promise<WmsEventResult> {
  switch (event.eventType) {
    case 'TRAILER_LOCATION_UPDATED':
      return onTrailerLocationUpdated(event, now);
    case 'TRAILER_STATUS_UPDATED':
      return onTrailerStatusUpdated(event, now);
    case 'TRAILER_ARRIVED':
      return onTrailerArrived(event, now);
    case 'TRAILER_DOCKED':
      return onTrailerDocked(event, now);
    case 'DOCK_STATUS_UPDATED':
      return onDockStatusUpdated(event, now);
    case 'APPOINTMENT_UPDATED':
      return onAppointmentUpdated(event);
  }
}
