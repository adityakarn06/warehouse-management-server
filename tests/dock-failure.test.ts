import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDockingSink, setDockingSink } from '../src/docking/docking-events.js';
import { disconnectPrisma, prisma } from '../src/lib/prisma.js';
import type { YardSnapshot } from './docking-fixtures.js';
import { RecordingSink, restoreYard, snapshotYard } from './docking-fixtures.js';

/**
 * Phase 8: dock failure -> automatic reassignment (CLAUDE.md §10, Scenarios D/E).
 *
 * Driven end-to-end through `PATCH /api/v1/docks/:dockId/status`, because that
 * is the only thing the frontend sends — every decision below is the backend's.
 *
 * The seed stages both paths: `DA-3002` books TRK-101 (SHP-1001, REFRIGERATED,
 * HIGH) onto D2, and D4 is the only other in-service reefer door — D7 is out of
 * service and D1/D3/D8 are general-freight only. Taking D4 down first therefore
 * turns Scenario D into Scenario E without touching the seed.
 *
 * Like `docking-api.test.ts` this suite **writes to the seeded database** and
 * restores it in `afterEach`; `pnpm db:seed` is the reset of last resort.
 */

let app: Express;
let sink: RecordingSink;
let yard: YardSnapshot;

const fail = (dock: string, reason?: string) =>
  request(app)
    .patch(`/api/v1/docks/${dock}/status`)
    .send(reason === undefined ? { status: 'UNAVAILABLE' } : { status: 'UNAVAILABLE', reason });

beforeAll(async () => {
  app = createApp();
  yard = await snapshotYard();
});

beforeEach(() => {
  sink = new RecordingSink();
  setDockingSink(sink);
});

afterEach(async () => {
  await restoreYard(yard);
});

afterAll(async () => {
  resetDockingSink();
  await disconnectPrisma();
});

describe('Scenario D — a compatible replacement exists', () => {
  it('takes the assigned door out of service and reports what it was holding', async () => {
    const res = await fail('D2', 'Hydraulic fault').expect(200);

    expect(res.body.data.changed).toBe(true);
    expect(res.body.data.dock).toMatchObject({
      status: 'UNAVAILABLE',
      unavailableReason: 'Hydraulic fault',
    });
    expect(res.body.data.affectedAssignments).toHaveLength(1);
    expect(res.body.data.affectedAssignments[0]).toMatchObject({ id: 'DA-3002' });
  });

  it('picks the replacement itself and explains the choice', async () => {
    const res = await fail('D2', 'Hydraulic fault').expect(200);

    expect(res.body.data.reassignments).toHaveLength(1);
    expect(res.body.data.reassignments[0]).toMatchObject({
      truckReference: 'TRK-101',
      outcome: 'REASSIGNED',
      previousDockCode: 'D2',
      newDockCode: 'D4',
    });
    // Explainable, not just decided (§9).
    expect(res.body.data.reassignments[0].reasons.length).toBeGreaterThan(0);
    expect(res.body.data.reassignments[0].score).toBeGreaterThan(0);
  });

  it('moves the assignment onto the replacement and chains the two rows', async () => {
    await fail('D2').expect(200);

    const previous = await prisma.dockAssignment.findUniqueOrThrow({ where: { id: 'DA-3002' } });
    expect(previous.status).toBe('REASSIGNED');
    expect(previous.reassignedAt).not.toBeNull();
    // REASSIGNED is not a release — the DA-3005 seed row documents the shape.
    expect(previous.releasedAt).toBeNull();
    expect(previous.dockDoorId).toBe('D2');

    const replacements = await prisma.dockAssignment.findMany({
      where: { truckId: 'TRK-101', status: 'ASSIGNED' },
    });
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({
      dockDoorId: 'D4',
      previousAssignmentId: 'DA-3002',
    });
    expect(replacements[0]?.assignedAt).not.toBeNull();

    // The replacement door is now reserved for the slot; the dead one stops
    // claiming a free-from time it can no longer honour.
    const d4 = await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D4' } });
    expect(d4.status).toBe('RESERVED');
    expect(d4.availableFrom?.getTime()).toBe(replacements[0]?.scheduledEnd?.getTime());

    const d2 = await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D2' } });
    expect(d2.status).toBe('UNAVAILABLE');
    expect(d2.availableFrom).toBeNull();

    const truck = await request(app).get('/api/v1/trucks/TRK-101').expect(200);
    expect(truck.body.data.dockAssignments[0]).toMatchObject({ status: 'ASSIGNED' });
  });

  it('creates a DOCK_REASSIGNMENT alert that names both doors', async () => {
    await fail('D2', 'Hydraulic fault').expect(200);

    const alerts = await prisma.alert.findMany({ where: { type: 'DOCK_REASSIGNMENT', truckId: 'TRK-101' } });
    expect(alerts).toHaveLength(1);

    const alert = alerts[0];
    expect(alert).toMatchObject({
      severity: 'INFO',
      truckId: 'TRK-101',
      shipmentId: 'SHP-1001',
      // Points at the *new* door — that is where the truck is going.
      dockDoorId: 'D4',
    });
    expect(alert?.title).toContain('D2 → D4');
    expect(alert?.message).toContain('Hydraulic fault');
    expect(alert?.metadata).toMatchObject({ previousDockDoorId: 'D2', newDockDoorId: 'D4' });
  });

  it('emits the full realtime timeline, in order', async () => {
    await fail('D2', 'Hydraulic fault').expect(200);

    // D2 goes down, then D4 is reserved for the truck that had to leave.
    expect(sink.ofType('DOCK_STATUS_CHANGED').map((event) => event.data.code)).toEqual(['D2', 'D4']);

    const reassigned = sink.ofType('DOCK_REASSIGNED');
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]?.data).toMatchObject({
      truckId: 'TRK-101',
      // Carried so the room can route to the customer's shipment feed too.
      shipmentId: 'SHP-1001',
      previousDockDoorId: 'D2',
      previousDockCode: 'D2',
      previousAssignmentId: 'DA-3002',
      dockCode: 'D4',
      status: 'ASSIGNED',
    });
    // Everything the board needs for "TRK-101  D2 -> D4  Reason: ..." in one event.
    expect(reassigned[0]?.data.reason).toContain('D2');
    expect(reassigned[0]?.data.reason).toContain('Hydraulic fault');

    const alerts = sink.ofType('ALERT_CREATED').map((event) => event.data.type);
    expect(alerts).toEqual(['DOCK_UNAVAILABLE', 'DOCK_REASSIGNMENT']);

    // Nothing was emitted for a truck that was not involved.
    const named = sink.events.flatMap((event) =>
      'truckId' in event.data && event.data.truckId ? [event.data.truckId] : [],
    );
    expect(new Set(named)).toEqual(new Set(['TRK-101']));
  });

  it('leaves every unaffected dock and truck exactly as it was', async () => {
    const before = await prisma.dockDoor.findMany({
      where: { id: { notIn: ['D2', 'D4'] } },
      orderBy: { code: 'asc' },
      select: { id: true, status: true, availableFrom: true },
    });
    const others = await prisma.dockAssignment.findMany({
      where: { id: { notIn: ['DA-3002'] } },
      orderBy: { id: 'asc' },
    });

    await fail('D2').expect(200);

    expect(
      await prisma.dockDoor.findMany({
        where: { id: { notIn: ['D2', 'D4'] } },
        orderBy: { code: 'asc' },
        select: { id: true, status: true, availableFrom: true },
      }),
    ).toEqual(before);

    expect(
      await prisma.dockAssignment.findMany({
        where: { id: { in: others.map((row) => row.id) } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(others);
  });

  it('does not fire at all when the door was holding nothing', async () => {
    const res = await fail('D3').expect(200);

    expect(res.body.data.affectedAssignments).toHaveLength(0);
    expect(res.body.data.reassignments).toEqual([]);
    expect(res.body.data.alert).toBeNull();
    expect(sink.ofType('ALERT_CREATED')).toHaveLength(0);
    expect(sink.ofType('DOCK_REASSIGNED')).toHaveLength(0);
  });
});

describe('Scenario E — no compatible replacement exists', () => {
  /** D7 is already out of service, so dropping D4 leaves no reefer door at all. */
  const stripReeferDoors = async () => {
    await request(app).patch('/api/v1/docks/D4/status').send({ status: 'UNAVAILABLE' }).expect(200);
  };

  it('does not invent a dock and leaves the truck unassigned', async () => {
    await stripReeferDoors();
    const res = await fail('D2', 'Hydraulic fault').expect(200);

    expect(res.body.data.reassignments).toHaveLength(1);
    expect(res.body.data.reassignments[0]).toMatchObject({
      truckReference: 'TRK-101',
      outcome: 'NO_DOCK_AVAILABLE',
      previousDockCode: 'D2',
      newDockDoorId: null,
      newDockCode: null,
    });

    expect(await prisma.dockAssignment.count({ where: { truckId: 'TRK-101', status: 'ASSIGNED' } })).toBe(0);
    expect(sink.ofType('DOCK_REASSIGNED')).toHaveLength(0);
  });

  it('cancels the stranded row rather than leaving a truck on a dead door', async () => {
    await stripReeferDoors();
    await fail('D2').expect(200);

    const stranded = await prisma.dockAssignment.findUniqueOrThrow({ where: { id: 'DA-3002' } });
    expect(stranded.status).toBe('CANCELLED');
    expect(stranded.releasedAt).not.toBeNull();
    // CANCELLED, not REASSIGNED: nothing superseded it.
    expect(stranded.reassignedAt).toBeNull();
  });

  it('creates a CRITICAL NO_DOCK_AVAILABLE alert saying why nothing fit', async () => {
    await stripReeferDoors();
    await fail('D2', 'Hydraulic fault').expect(200);

    const alerts = await prisma.alert.findMany({ where: { type: 'NO_DOCK_AVAILABLE' , truckId: 'TRK-101' } });
    expect(alerts).toHaveLength(1);

    const alert = alerts[0];
    expect(alert).toMatchObject({
      severity: 'CRITICAL',
      truckId: 'TRK-101',
      shipmentId: 'SHP-1001',
      // No door to point at — inventing one is exactly what §10 forbids.
      dockDoorId: null,
    });
    expect(alert?.metadata).toMatchObject({ loadType: 'REFRIGERATED', previousDockDoorId: 'D2' });

    const excluded = (alert?.metadata as { excluded: string[] }).excluded;
    expect(excluded.some((row) => row.startsWith('D3:') && row.includes('REFRIGERATED'))).toBe(true);
    expect(excluded.some((row) => row.startsWith('D7:') && row.includes('out of service'))).toBe(true);

    expect(sink.ofType('ALERT_CREATED').map((event) => event.data.type)).toEqual([
      'DOCK_UNAVAILABLE',
      'NO_DOCK_AVAILABLE',
    ]);
  });
});

describe('two trucks are never given the same dock at the same time', () => {
  /**
   * Books a competing truck onto `dockId` across TRK-101's own slot.
   *
   * The window comes from the engine's `requestedWindow`, not from the stored
   * `DA-3002` row: the slot is recomputed from the truck's *live* ETA every
   * time, so a simulation run that has moved TRK-101 on would leave a window
   * copied from the seed no longer overlapping — and the clash under test would
   * quietly stop being a clash.
   */
  const bookRival = async (dockId: string) => {
    const res = await request(app).get('/api/v1/trucks/TRK-101/dock-recommendations').expect(200);
    const slot: { start: string; end: string } = res.body.data.requestedWindow;

    await prisma.dockAssignment.create({
      data: {
        id: 'DA-TEST-RIVAL',
        truckId: 'TRK-102',
        dockDoorId: dockId,
        status: 'ASSIGNED',
        scheduledStart: new Date(slot.start),
        scheduledEnd: new Date(slot.end),
        assignedAt: new Date(),
      },
    });
  };

  it('refuses to assign a door already booked across the slot', async () => {
    await bookRival('D4');

    const res = await request(app)
      .post('/api/v1/trucks/TRK-101/dock-assignment')
      .send({ dockId: 'D4' })
      .expect(400);

    expect(res.body.error.message).toContain('Already booked');
    expect(
      await prisma.dockAssignment.count({ where: { dockDoorId: 'D4', status: 'ASSIGNED' } }),
    ).toBe(1);
  });

  it('counts a committed booking with no scheduled window as a clash', async () => {
    // Prisma comparisons never match NULL, so an overlap test alone waves a
    // windowless booking straight through. Scoring cannot see it either — it
    // filters those rows out of `bookedWindows` — so the transaction-time
    // recheck is the only thing standing between it and a double-booked door.
    await prisma.dockAssignment.create({
      data: {
        id: 'DA-TEST-NOWINDOW',
        truckId: 'TRK-102',
        dockDoorId: 'D4',
        status: 'ASSIGNED',
        assignedAt: new Date(),
      },
    });

    const res = await request(app)
      .post('/api/v1/trucks/TRK-101/dock-assignment')
      .send({ dockId: 'D4' })
      .expect(409);

    expect(res.body.error.message).toContain('another truck');
    expect(
      await prisma.dockAssignment.count({ where: { dockDoorId: 'D4', status: 'ASSIGNED' } }),
    ).toBe(1);
  });

  it('skips a booked door during a failure rather than double-booking it', async () => {
    await bookRival('D4');
    await fail('D2').expect(200);

    // D4 was the only alternative and it is taken, so the honest answer is none.
    const res = await prisma.dockAssignment.findMany({ where: { dockDoorId: 'D4', status: 'ASSIGNED' } });
    expect(res).toHaveLength(1);
    expect(res[0]?.truckId).toBe('TRK-102');

    const alerts = await prisma.alert.findMany({ where: { type: 'NO_DOCK_AVAILABLE', truckId: 'TRK-101' } });
    expect(alerts).toHaveLength(1);
  });
});

describe('recovery', () => {
  it('puts a repaired door back into rotation', async () => {
    await fail('D2').expect(200);

    const res = await request(app).patch('/api/v1/docks/D2/status').send({ status: 'AVAILABLE' }).expect(200);

    expect(res.body.data.dock).toMatchObject({ status: 'AVAILABLE', unavailableReason: null });
    expect(res.body.data.reassignments).toEqual([]);
  });

  it('releases the replacement door back to the yard', async () => {
    await fail('D2').expect(200);

    const replacement = await prisma.dockAssignment.findFirstOrThrow({
      where: { truckId: 'TRK-101', status: 'ASSIGNED' },
    });

    const res = await request(app).post('/api/v1/docks/D4/release').expect(200);

    expect(res.body.data).toMatchObject({ dockCode: 'D4', status: 'AVAILABLE' });
    expect(res.body.data.releasedAssignmentIds).toContain(replacement.id);

    const released = await prisma.dockAssignment.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(released.status).toBe('COMPLETED');
    expect(released.releasedAt).not.toBeNull();

    const d4 = await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D4' } });
    expect(d4.status).toBe('AVAILABLE');
    expect(d4.availableFrom).toBeNull();
  });

  it('a released door that is out of service stays out of service', async () => {
    await fail('D2').expect(200);
    await request(app).patch('/api/v1/docks/D4/status').send({ status: 'UNAVAILABLE' }).expect(200);

    const res = await request(app).post('/api/v1/docks/D4/release').expect(200);
    expect(res.body.data.status).toBe('UNAVAILABLE');
  });

  it('404s on an unknown dock', async () => {
    await request(app).post('/api/v1/docks/D99/release').expect(404);
  });
});
