import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { DockingEvent, DockingEventSink } from '../src/docking/docking-events.js';
import { resetDockingSink, setDockingSink } from '../src/docking/docking-events.js';
import { disconnectPrisma, prisma } from '../src/lib/prisma.js';

/**
 * The docking write endpoints, driven through `createApp()` with supertest.
 *
 * This suite **writes to the seeded development database**, which
 * `read-api.test.ts` asserts exact values against — so every test restores what
 * it touched: dock doors go back to their opening snapshot, and any
 * assignment/alert row the suite created is deleted. Re-run `pnpm db:seed` if a
 * run is interrupted.
 *
 * There is no Socket.IO server here, so emissions are captured through a
 * recording `DockingEventSink` rather than a real socket.
 */

class RecordingSink implements DockingEventSink {
  readonly events: DockingEvent[] = [];

  emit(event: DockingEvent): void {
    this.events.push(event);
  }

  ofType<T extends DockingEvent['type']>(type: T): Extract<DockingEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<DockingEvent, { type: T }> => event.type === type);
  }
}

let app: Express;
let sink: RecordingSink;

type DockSnapshot = {
  id: string;
  status: string;
  availableFrom: Date | null;
  unavailableReason: string | null;
};

let dockSnapshots: DockSnapshot[] = [];
let seededAssignmentIds: string[] = [];
let seededAlertIds: string[] = [];

beforeAll(async () => {
  app = createApp();

  dockSnapshots = await prisma.dockDoor.findMany({
    select: { id: true, status: true, availableFrom: true, unavailableReason: true },
  });
  seededAssignmentIds = (await prisma.dockAssignment.findMany({ select: { id: true } })).map((r) => r.id);
  seededAlertIds = (await prisma.alert.findMany({ select: { id: true } })).map((r) => r.id);
});

beforeEach(() => {
  sink = new RecordingSink();
  setDockingSink(sink);
});

afterEach(async () => {
  // Rows first: an assignment still pointing at a door would block the reset.
  await prisma.dockAssignment.deleteMany({ where: { id: { notIn: seededAssignmentIds } } });
  await prisma.alert.deleteMany({ where: { id: { notIn: seededAlertIds } } });

  for (const snapshot of dockSnapshots) {
    await prisma.dockDoor.update({
      where: { id: snapshot.id },
      data: {
        status: snapshot.status as DockSnapshot['status'] & 'AVAILABLE',
        availableFrom: snapshot.availableFrom,
        unavailableReason: snapshot.unavailableReason,
      },
    });
  }

  // The suite may have cancelled a seeded assignment on its way to a new one.
  await prisma.dockAssignment.updateMany({
    where: { id: { in: seededAssignmentIds }, status: 'CANCELLED' },
    data: { status: 'ASSIGNED', releasedAt: null },
  });
});

afterAll(async () => {
  resetDockingSink();
  await disconnectPrisma();
});

describe('GET /api/v1/trucks/:truckId/dock-recommendations', () => {
  it('ranks compatible docks and explains every one of them', async () => {
    const res = await request(app).get('/api/v1/trucks/TRK-101/dock-recommendations').expect(200);
    const { data } = res.body;

    expect(data.truck.reference).toBe('TRK-101');
    expect(data.shipment).toMatchObject({ reference: 'SHP-1001', loadType: 'REFRIGERATED', priority: 'HIGH' });
    expect(data.currentAssignment).toMatchObject({ dockCode: 'D2' });
    expect(data.recommendations.length).toBeGreaterThan(0);

    for (const row of data.recommendations) {
      expect(row.reasons.length).toBeGreaterThan(0);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }

    // Sorted, and never proposing a door that cannot take a reefer trailer.
    const scores = data.recommendations.map((row: { score: number }) => row.score);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
    expect(data.recommendations.map((r: { dockCode: string }) => r.dockCode)).not.toContain('D3');
  });

  it('excludes the out-of-service and incompatible doors with a reason each', async () => {
    const res = await request(app).get('/api/v1/trucks/TRK-101/dock-recommendations').expect(200);
    const excluded: { dockCode: string; reason: string }[] = res.body.data.excluded;

    expect(excluded.find((row) => row.dockCode === 'D7')?.reason).toContain('out of service');
    expect(excluded.find((row) => row.dockCode === 'D3')?.reason).toBe(
      'Does not support REFRIGERATED loads',
    );
  });

  it('writes nothing — a recommendation is only a proposal', async () => {
    const before = await prisma.dockAssignment.count();
    await request(app).get('/api/v1/trucks/TRK-101/dock-recommendations').expect(200);

    expect(await prisma.dockAssignment.count()).toBe(before);
    expect(sink.events).toHaveLength(0);
  });

  it('404s on an unknown truck', async () => {
    const res = await request(app).get('/api/v1/trucks/TRK-999/dock-recommendations').expect(404);
    expect(res.body.error).toMatchObject({ status: 404, message: expect.any(String) });
  });
});

describe('POST /api/v1/trucks/:truckId/dock-assignment', () => {
  it('assigns the named dock, reserves the door and emits DOCK_ASSIGNED', async () => {
    const res = await request(app)
      .post('/api/v1/trucks/TRK-112/dock-assignment')
      .send({ dockId: 'D5' })
      .expect(201);

    expect(res.body.data.created).toBe(true);
    expect(res.body.data.assignment).toMatchObject({ status: 'ASSIGNED', dockDoorId: 'D5' });
    expect(res.body.data.assignment.reasons.length).toBeGreaterThan(0);

    const dock = await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D5' } });
    expect(dock.status).toBe('RESERVED');
    expect(dock.availableFrom).not.toBeNull();

    const assigned = sink.ofType('DOCK_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.data).toMatchObject({ truckId: 'TRK-112', dockCode: 'D5', status: 'ASSIGNED' });
    expect(sink.ofType('DOCK_STATUS_CHANGED')[0]?.data).toMatchObject({
      code: 'D5',
      previousStatus: 'AVAILABLE',
      status: 'RESERVED',
    });
  });

  it('assigns the top recommendation when no dock is named', async () => {
    const recommended = await request(app)
      .get('/api/v1/trucks/TRK-112/dock-recommendations')
      .expect(200);
    const best = recommended.body.data.recommendations[0].dockCode;

    const res = await request(app).post('/api/v1/trucks/TRK-112/dock-assignment').send({}).expect(201);

    expect(res.body.data.assignment.dockDoor.code).toBe(best);
  });

  it('rejects a dock that cannot take the load with a 400 naming why', async () => {
    // TRK-112 carries a HAZARDOUS shipment; D3 is a general-freight door.
    const res = await request(app)
      .post('/api/v1/trucks/TRK-112/dock-assignment')
      .send({ dockId: 'D3' })
      .expect(400);

    expect(res.body.error.message).toContain('Does not support HAZARDOUS loads');
    expect(await prisma.dockAssignment.count({ where: { truckId: 'TRK-112' } })).toBe(0);
    expect(sink.events).toHaveLength(0);
  });

  it('rejects an out-of-service dock', async () => {
    const res = await request(app)
      .post('/api/v1/trucks/TRK-102/dock-assignment')
      .send({ dockId: 'D7' })
      .expect(400);

    expect(res.body.error.message).toContain('out of service');
  });

  it('404s on an unknown dock', async () => {
    await request(app).post('/api/v1/trucks/TRK-102/dock-assignment').send({ dockId: 'D99' }).expect(404);
  });

  it('400s on a malformed body', async () => {
    const res = await request(app)
      .post('/api/v1/trucks/TRK-102/dock-assignment')
      .send({ dockId: 42 })
      .expect(400);

    expect(res.body.error.details).toBeDefined();
  });

  it('re-picking the same dock is a no-op success', async () => {
    await request(app).post('/api/v1/trucks/TRK-112/dock-assignment').send({ dockId: 'D5' }).expect(201);

    const again = await request(app)
      .post('/api/v1/trucks/TRK-112/dock-assignment')
      .send({ dockId: 'D5' })
      .expect(200);

    expect(again.body.data.created).toBe(false);
    expect(await prisma.dockAssignment.count({ where: { truckId: 'TRK-112', status: 'ASSIGNED' } })).toBe(1);
  });

  it('moving a truck cancels the old row and frees the old door', async () => {
    // TRK-101 holds D2 (RESERVED); D4 is its compatible reefer twin — Scenario D,
    // driven by hand here rather than by the Phase 8 failure path.
    const res = await request(app)
      .post('/api/v1/trucks/TRK-101/dock-assignment')
      .send({ dockId: 'D4' })
      .expect(201);

    expect(res.body.data.previousAssignment).toMatchObject({ dockCode: 'D2' });

    const previous = await prisma.dockAssignment.findUniqueOrThrow({ where: { id: 'DA-3002' } });
    expect(previous.status).toBe('CANCELLED');
    expect(previous.releasedAt).not.toBeNull();

    expect((await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D2' } })).status).toBe('AVAILABLE');
    expect((await prisma.dockDoor.findUniqueOrThrow({ where: { id: 'D4' } })).status).toBe('RESERVED');

    const statusEvents = sink.ofType('DOCK_STATUS_CHANGED').map((event) => event.data.code);
    expect(statusEvents).toEqual(['D2', 'D4']);
  });
});

describe('PATCH /api/v1/docks/:dockId/status', () => {
  it('takes a free door out of service and puts it back', async () => {
    const down = await request(app)
      .patch('/api/v1/docks/D3/status')
      .send({ status: 'UNAVAILABLE', reason: 'Hydraulic leveler fault' })
      .expect(200);

    expect(down.body.data.changed).toBe(true);
    expect(down.body.data.dock).toMatchObject({
      status: 'UNAVAILABLE',
      unavailableReason: 'Hydraulic leveler fault',
    });
    expect(down.body.data.alert).toBeNull();
    expect(sink.ofType('DOCK_STATUS_CHANGED')[0]?.data).toMatchObject({
      code: 'D3',
      previousStatus: 'AVAILABLE',
      status: 'UNAVAILABLE',
      unavailableReason: 'Hydraulic leveler fault',
    });

    const up = await request(app).patch('/api/v1/docks/D3/status').send({ status: 'AVAILABLE' }).expect(200);

    expect(up.body.data.dock).toMatchObject({ status: 'AVAILABLE', unavailableReason: null });
  });

  it('is a no-op success when the door is already in that state', async () => {
    const res = await request(app).patch('/api/v1/docks/D3/status').send({ status: 'AVAILABLE' }).expect(200);

    expect(res.body.data.changed).toBe(false);
    expect(sink.events).toHaveLength(0);
  });

  it('raises a DOCK_UNAVAILABLE alert naming what is stranded, and reassigns nothing', async () => {
    const res = await request(app)
      .patch('/api/v1/docks/D2/status')
      .send({ status: 'UNAVAILABLE' })
      .expect(200);

    expect(res.body.data.affectedAssignments).toHaveLength(1);
    expect(res.body.data.affectedAssignments[0]).toMatchObject({ id: 'DA-3002' });
    expect(res.body.data.alert).toMatchObject({ type: 'DOCK_UNAVAILABLE', severity: 'WARNING', dockDoorId: 'D2' });

    expect(sink.ofType('ALERT_CREATED')).toHaveLength(1);

    // Phase 7 stops here: the assignment is untouched and no replacement exists.
    const stranded = await prisma.dockAssignment.findUniqueOrThrow({ where: { id: 'DA-3002' } });
    expect(stranded.status).toBe('ASSIGNED');
    expect(stranded.dockDoorId).toBe('D2');
    expect(await prisma.dockAssignment.count({ where: { truckId: 'TRK-101' } })).toBe(1);
  });

  it('restores a door that still holds a booking to RESERVED, not AVAILABLE', async () => {
    await request(app).patch('/api/v1/docks/D2/status').send({ status: 'UNAVAILABLE' }).expect(200);
    const res = await request(app).patch('/api/v1/docks/D2/status').send({ status: 'AVAILABLE' }).expect(200);

    expect(res.body.data.dock.status).toBe('RESERVED');
    expect(res.body.data.dock.unavailableReason).toBeNull();
  });

  it('rejects a status the operator does not own', async () => {
    const res = await request(app).patch('/api/v1/docks/D3/status').send({ status: 'OCCUPIED' }).expect(400);
    expect(res.body.error.details).toBeDefined();
  });

  it('404s on an unknown dock', async () => {
    await request(app).patch('/api/v1/docks/D99/status').send({ status: 'UNAVAILABLE' }).expect(404);
  });
});
