import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDockingSink, setDockingSink } from '../src/docking/docking-events.js';
import { disconnectPrisma, prisma } from '../src/lib/prisma.js';
import type { RealtimeEvent, RealtimeEventType } from '../src/websocket/events.js';
import type { WmsRealtimeSink } from '../src/wms/wms-realtime.js';
import { resetWmsSink, setWmsSink } from '../src/wms/wms-realtime.js';
import type { FleetSnapshot, YardSnapshot } from './docking-fixtures.js';
import { restoreFleet, restoreYard, snapshotFleet, snapshotYard } from './docking-fixtures.js';

/**
 * Phase 9 — the simulated WMS feed, through supertest against the seeded
 * database.
 *
 * These tests write, so they snapshot both the yard (doors, assignments,
 * alerts) and the fleet (trucks, shipments, appointments, location history) and
 * put everything back in `afterEach`. `read-api.test.ts` asserts exact seeded
 * values and would be the first casualty otherwise.
 *
 * The simulation loop never runs here (`NODE_ENV=test` force-disables
 * autostart, and `createApp()` starts nothing), so every truck takes the
 * handler's not-simulated branch — the one that writes Prisma directly and
 * builds its own payloads.
 */

/**
 * Captures the whole realtime union, not just the docking subset — so the one
 * recorder can stand in for both seams (see `beforeEach`).
 */
class RecordingWmsSink implements WmsRealtimeSink {
  readonly events: RealtimeEvent[] = [];

  emit(event: RealtimeEvent): void {
    this.events.push(event);
  }

  ofType<T extends RealtimeEventType>(type: T): Extract<RealtimeEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<RealtimeEvent, { type: T }> => event.type === type,
    );
  }
}

const post = (app: Express, body: unknown) =>
  request(app).post('/api/v1/wms/events').send(body as object);

let app: Express;
let sink: RecordingWmsSink;
let yard: YardSnapshot;
let fleet: FleetSnapshot;

beforeAll(async () => {
  app = createApp();
  yard = await snapshotYard();
  fleet = await snapshotFleet();
});

beforeEach(() => {
  sink = new RecordingWmsSink();
  // Both seams, one recorder. The WMS layer has its own sink, but the services
  // it delegates to — `setDockStatus`, the Phase 8 cascade, `releaseDock` —
  // emit through the docking sink. In production both default to the realtime
  // one so the events land either way; a test that swapped only one would
  // silently miss half of them.
  setWmsSink(sink);
  setDockingSink(sink);
});

afterEach(async () => {
  await restoreYard(yard);
  await restoreFleet(fleet);
});

afterAll(async () => {
  resetWmsSink();
  resetDockingSink();
  await disconnectPrisma();
});

describe('wms trailer location updates', () => {
  it('moves the truck and emits a position update', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_LOCATION_UPDATED',
      trailerId: 'TRL-101',
      yardLocation: { lat: 22.5799, lng: 88.3985 },
      progress: 97,
      speedKmph: 24,
    }).expect(200);

    expect(res.body.data).toMatchObject({
      eventType: 'TRAILER_LOCATION_UPDATED',
      applied: true,
      truckId: 'TRK-101',
    });

    const truck = await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-101' } });
    expect(truck.currentLatitude).toBeCloseTo(22.5799, 4);
    expect(truck.currentLongitude).toBeCloseTo(88.3985, 4);
    expect(truck.progress).toBe(97);
    expect(truck.speedKmph).toBe(24);

    const emitted = sink.ofType('TRUCK_POSITION_UPDATED');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toMatchObject({ truckId: 'TRK-101', progress: 97 });
  });

  it('writes no location history — a position is not a business event', async () => {
    const before = await prisma.locationHistory.count({ where: { truckId: 'TRK-101' } });

    await post(app, {
      eventType: 'TRAILER_LOCATION_UPDATED',
      trailerId: 'TRL-101',
      yardLocation: { lat: 22.57, lng: 88.39 },
    }).expect(200);

    expect(await prisma.locationHistory.count({ where: { truckId: 'TRK-101' } })).toBe(before);
  });

  it('resolves a trailer by id, reference or trailer id', async () => {
    for (const key of ['TRK-102', 'TRL-102']) {
      const res = await post(app, {
        eventType: 'TRAILER_LOCATION_UPDATED',
        trailerId: key,
        yardLocation: { lat: 23.1, lng: 87.9 },
      }).expect(200);
      expect(res.body.data.truckId).toBe('TRK-102');
    }
  });

  it('404s on an unknown trailer', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_LOCATION_UPDATED',
      trailerId: 'TRL-999',
      yardLocation: { lat: 22.5, lng: 88.4 },
    }).expect(404);

    expect(res.body.error.message).toContain('TRL-999');
  });
});

describe('wms trailer status updates', () => {
  it('moves truck and shipment, and raises one arriving alert', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-102',
      status: 'ARRIVING',
      yardLocation: { lat: 22.6, lng: 88.4 },
    }).expect(200);

    expect(res.body.data.applied).toBe(true);
    expect(res.body.data.alert).toMatchObject({ type: 'TRUCK_ARRIVING', severity: 'INFO' });

    const truck = await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-102' } });
    expect(truck.status).toBe('ARRIVING');

    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: 'SHP-1002' } });
    expect(shipment.status).toBe('ARRIVING');

    // The transition deserves a snapshot row; the status enum has a reason for it.
    const history = await prisma.locationHistory.findFirst({
      where: { truckId: 'TRK-102', reason: 'ARRIVING' },
      orderBy: { recordedAt: 'desc' },
    });
    expect(history).not.toBeNull();

    expect(sink.ofType('TRUCK_STATUS_CHANGED')[0]?.data).toMatchObject({
      truckId: 'TRK-102',
      previousStatus: 'IN_TRANSIT',
      status: 'ARRIVING',
    });
    expect(sink.ofType('ALERT_CREATED')).toHaveLength(1);
  });

  it('re-sending the same status is a no-op success with no second alert', async () => {
    await post(app, {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-102',
      status: 'ARRIVING',
    }).expect(200);

    const again = await post(app, {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-102',
      status: 'ARRIVING',
    }).expect(200);

    expect(again.body.data.applied).toBe(false);
    expect(again.body.data.alert).toBeNull();
    expect(sink.ofType('ALERT_CREATED')).toHaveLength(1);
  });

  it('keeps a reported position even when the status is unchanged', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-102',
      status: 'IN_TRANSIT', // already IN_TRANSIT
      yardLocation: { lat: 23.4, lng: 87.5 },
    }).expect(200);

    expect(res.body.data.applied).toBe(true);
    const truck = await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-102' } });
    expect(truck.currentLatitude).toBeCloseTo(23.4, 4);
  });

  it('refuses to put a delayed truck back on the road without clearing the delay', async () => {
    // TRK-103 is seeded DELAYED/RAIN. Moving it to IN_TRANSIT here would leave
    // activeDelay RAIN standing next to a normal-looking status.
    const res = await post(app, {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-103',
      status: 'IN_TRANSIT',
    }).expect(409);

    expect(res.body.error.message).toContain('clear-delay');
    expect(await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-103' } })).toMatchObject({
      status: 'DELAYED',
      activeDelay: 'RAIN',
    });
  });

  it('refuses DOCKED — TRAILER_DOCKED owns it, with the door in the same transaction', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-102',
      status: 'DOCKED',
    }).expect(400);

    expect(res.body.error.details).toBeDefined();
    expect(await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-102' } })).toMatchObject({
      status: 'IN_TRANSIT',
    });
  });

  it('refuses DELAYED — the delay endpoints own it', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_STATUS_UPDATED',
      trailerId: 'TRL-102',
      status: 'DELAYED',
    }).expect(400);

    expect(res.body.error.details).toBeDefined();
  });
});

describe('wms trailer arrival', () => {
  it('parks the truck at the route destination', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_ARRIVED',
      trailerId: 'TRL-101',
    }).expect(200);

    expect(res.body.data.applied).toBe(true);

    const truck = await prisma.truck.findUniqueOrThrow({
      where: { id: 'TRK-101' },
      include: { route: true },
    });
    expect(truck.status).toBe('ARRIVED');
    expect(truck.progress).toBe(100);
    expect(truck.speedKmph).toBe(0);
    expect(truck.eta).toBeNull();
    expect(truck.arrivedAt).not.toBeNull();
    expect(truck.currentLatitude).toBeCloseTo(truck.route.destinationLatitude, 4);

    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: 'SHP-1001' } })).toMatchObject({
      status: 'ARRIVED',
    });
  });

  it('is idempotent', async () => {
    await post(app, { eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-101' }).expect(200);
    const again = await post(app, { eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-101' }).expect(200);
    expect(again.body.data.applied).toBe(false);
  });

  it('never drags a docked trailer back to the gate', async () => {
    await post(app, { eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-101' }).expect(200);
    await post(app, { eventType: 'TRAILER_DOCKED', trailerId: 'TRL-101', dockCode: 'D2' }).expect(200);

    const docked = await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-101' } });

    // A late or retried arrival for a trailer that is already in a bay.
    const late = await post(app, { eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-101' }).expect(200);
    expect(late.body.data.applied).toBe(false);

    expect(await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-101' } })).toMatchObject({
      status: 'DOCKED',
      arrivedAt: docked.arrivedAt,
    });
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: 'SHP-1001' } })).toMatchObject({
      status: 'DOCKED',
    });
    expect(await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D2' } })).toMatchObject({
      status: 'OCCUPIED',
    });
  });

  it('clears an active delay when the journey ends', async () => {
    // TRK-103 is seeded DELAYED with a RAIN scenario.
    await post(app, { eventType: 'TRAILER_ARRIVED', trailerId: 'TRL-103' }).expect(200);

    expect(await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-103' } })).toMatchObject({
      status: 'ARRIVED',
      activeDelay: 'NORMAL',
      speedKmph: 0,
    });
  });
});

describe('wms trailer docked', () => {
  it('occupies the assigned door and docks truck and shipment', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_DOCKED',
      trailerId: 'TRL-101',
      dockCode: 'D2',
    }).expect(200);

    expect(res.body.data).toMatchObject({ applied: true, truckId: 'TRK-101', dockDoorId: 'D2' });

    const dock = await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D2' } });
    expect(dock.status).toBe('OCCUPIED');
    expect(dock.availableFrom).toBeNull();

    expect(await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-101' } })).toMatchObject({
      status: 'DOCKED',
    });
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: 'SHP-1001' } })).toMatchObject({
      status: 'DOCKED',
    });

    const history = await prisma.locationHistory.findFirst({
      where: { truckId: 'TRK-101', reason: 'DOCKED' },
    });
    expect(history).not.toBeNull();

    expect(sink.ofType('DOCK_STATUS_CHANGED')[0]?.data).toMatchObject({
      dockDoorId: 'D2',
      previousStatus: 'RESERVED',
      status: 'OCCUPIED',
    });
    expect(sink.ofType('TRUCK_STATUS_CHANGED')[0]?.data).toMatchObject({ status: 'DOCKED' });
  });

  it('refuses a door that is out of service', async () => {
    // Give TRK-107 (assigned D8) a downed door to try to back into.
    await prisma.dockDoor.update({
      where: { id: 'D8' },
      data: { status: 'UNAVAILABLE', unavailableReason: 'test fault' },
    });

    const res = await post(app, {
      eventType: 'TRAILER_DOCKED',
      trailerId: 'TRL-107',
      dockCode: 'D8',
    }).expect(409);

    expect(res.body.error.message).toContain('out of service');
  });

  it('refuses a door the truck is not assigned to', async () => {
    const res = await post(app, {
      eventType: 'TRAILER_DOCKED',
      trailerId: 'TRL-101',
      dockCode: 'D3',
    }).expect(409);

    expect(res.body.error.message).toContain('D2');
    expect(await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D3' } })).toMatchObject({
      status: 'AVAILABLE',
    });
  });
});

describe('wms dock status updates', () => {
  it('occupies a free door — the transition only the WMS may make', async () => {
    const res = await post(app, {
      eventType: 'DOCK_STATUS_UPDATED',
      dockCode: 'D3',
      status: 'OCCUPIED',
    }).expect(200);

    expect(res.body.data.applied).toBe(true);
    expect(await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D3' } })).toMatchObject({
      status: 'OCCUPIED',
    });
    expect(sink.ofType('DOCK_STATUS_CHANGED')[0]?.data).toMatchObject({
      previousStatus: 'AVAILABLE',
      status: 'OCCUPIED',
    });
  });

  it('refuses to occupy a door that is out of service', async () => {
    // D7 is seeded UNAVAILABLE.
    const res = await post(app, {
      eventType: 'DOCK_STATUS_UPDATED',
      dockCode: 'D7',
      status: 'OCCUPIED',
    }).expect(409);

    expect(res.body.error.message).toContain('out of service');
  });

  it('delegates UNAVAILABLE to the Phase 8 cascade and reassigns the truck', async () => {
    const res = await post(app, {
      eventType: 'DOCK_STATUS_UPDATED',
      dockCode: 'D2',
      status: 'UNAVAILABLE',
      reason: 'WMS: leveler fault',
    }).expect(200);

    expect(res.body.data.applied).toBe(true);
    expect(res.body.data.emitted).toContain('DOCK_REASSIGNED');

    // Scenario D: TRK-101 moves off D2 onto the compatible reefer door D4.
    const moved = await prisma.dockAssignment.findFirst({
      where: { truckId: 'TRK-101', status: 'ASSIGNED' },
      select: { dockDoorId: true },
    });
    expect(moved?.dockDoorId).toBe('D4');

    const reassigned = sink.ofType('DOCK_REASSIGNED');
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]?.data).toMatchObject({
      truckId: 'TRK-101',
      previousDockCode: 'D2',
      dockCode: 'D4',
    });
  });

  it('refuses RESERVED — that is the assignment engine’s', async () => {
    const res = await post(app, {
      eventType: 'DOCK_STATUS_UPDATED',
      dockCode: 'D3',
      status: 'RESERVED',
    }).expect(400);

    expect(res.body.error.details).toBeDefined();
  });
});

describe('wms appointment updates', () => {
  it('moves the window and emits nothing', async () => {
    const start = new Date(Date.now() + 200 * 60_000);
    const end = new Date(Date.now() + 260 * 60_000);

    const res = await post(app, {
      eventType: 'APPOINTMENT_UPDATED',
      appointmentReference: 'APT-2001',
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
    }).expect(200);

    expect(res.body.data).toMatchObject({ applied: true, emitted: [] });

    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: 'APT-2001' } });
    expect(appointment.windowStart.toISOString()).toBe(start.toISOString());
    expect(sink.events).toHaveLength(0);
  });

  it('refuses a window that ends before it starts', async () => {
    const res = await post(app, {
      eventType: 'APPOINTMENT_UPDATED',
      appointmentReference: 'APT-2001',
      windowEnd: new Date(Date.now() - 600 * 60_000).toISOString(),
    }).expect(400);

    expect(res.body.error.message).toContain('APT-2001');
  });

  it('404s on an unknown appointment', async () => {
    await post(app, {
      eventType: 'APPOINTMENT_UPDATED',
      appointmentReference: 'APT-9999',
      notes: 'nope',
    }).expect(404);
  });
});

describe('invalid wms events', () => {
  it('rejects an unknown event type', async () => {
    const res = await post(app, { eventType: 'TRAILER_TELEPORTED', trailerId: 'TRL-101' }).expect(400);
    expect(res.body.error.details).toBeDefined();
  });

  it('rejects a missing trailer id', async () => {
    await post(app, {
      eventType: 'TRAILER_LOCATION_UPDATED',
      yardLocation: { lat: 22.5, lng: 88.4 },
    }).expect(400);
  });

  it('rejects an out-of-range coordinate', async () => {
    await post(app, {
      eventType: 'TRAILER_LOCATION_UPDATED',
      trailerId: 'TRL-101',
      yardLocation: { lat: 991, lng: 88.4 },
    }).expect(400);
  });

  it('rejects an appointment update that changes nothing', async () => {
    await post(app, {
      eventType: 'APPOINTMENT_UPDATED',
      appointmentReference: 'APT-2001',
    }).expect(400);
  });

  it('rejects an empty body', async () => {
    await request(app).post('/api/v1/wms/events').expect(400);
  });
});

describe('wms scenario replay', () => {
  it('runs TRAILER_ARRIVAL end to end and leaves TRK-101 docked at D2', async () => {
    const res = await request(app).post('/api/v1/wms/simulate').send({}).expect(200);

    expect(res.body.data.scenario).toBe('TRAILER_ARRIVAL');
    expect(res.body.data.steps.map((step: { eventType: string }) => step.eventType)).toEqual([
      'TRAILER_LOCATION_UPDATED',
      'TRAILER_STATUS_UPDATED',
      'TRAILER_ARRIVED',
      'TRAILER_DOCKED',
    ]);
    expect(res.body.data.steps.every((step: { ok: boolean }) => step.ok)).toBe(true);

    expect(await prisma.truck.findUniqueOrThrow({ where: { id: 'TRK-101' } })).toMatchObject({
      status: 'DOCKED',
    });
    expect(await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D2' } })).toMatchObject({
      status: 'OCCUPIED',
    });
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: 'SHP-1001' } })).toMatchObject({
      status: 'DOCKED',
    });
  });

  it('is idempotent — a second run changes nothing', async () => {
    await request(app).post('/api/v1/wms/simulate').send({}).expect(200);
    const again = await request(app).post('/api/v1/wms/simulate').send({}).expect(200);

    expect(again.body.data.steps.every((step: { ok: boolean }) => step.ok)).toBe(true);
    expect(await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D2' } })).toMatchObject({
      status: 'OCCUPIED',
    });
  });

  it('runs DOCK_OCCUPANCY and hands D3 back', async () => {
    const res = await request(app)
      .post('/api/v1/wms/simulate')
      .send({ scenario: 'DOCK_OCCUPANCY' })
      .expect(200);

    expect(res.body.data.steps).toHaveLength(2);
    expect(await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D3' } })).toMatchObject({
      status: 'AVAILABLE',
    });
  });

  it('rejects an unknown scenario', async () => {
    await request(app).post('/api/v1/wms/simulate').send({ scenario: 'NOPE' }).expect(400);
  });
});
