import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDockingSink, setDockingSink } from '../src/docking/docking-events.js';
import { disconnectPrisma, prisma } from '../src/lib/prisma.js';
import type { YardSnapshot } from './docking-fixtures.js';
import { RecordingSink, restoreYard, snapshotYard } from './docking-fixtures.js';

/**
 * The docking write endpoints, driven through `createApp()` with supertest.
 *
 * This suite **writes to the seeded development database**, which
 * `read-api.test.ts` asserts exact values against — so every test restores what
 * it touched through `restoreYard()`. Re-run `pnpm db:seed` if a run is
 * interrupted.
 *
 * The dock-failure cascade has a suite of its own: `dock-failure.test.ts`.
 *
 * There is no Socket.IO server here, so emissions are captured through a
 * recording `DockingEventSink` rather than a real socket.
 */

let app: Express;
let sink: RecordingSink;
let yard: YardSnapshot;

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

  it('takes the top recommendation when the request carries no body at all', async () => {
    // Express 5 leaves `req.body` undefined for a bodyless POST, which used to
    // 400 instead of running the one-click flow.
    const res = await request(app).post('/api/v1/trucks/TRK-112/dock-assignment').expect(201);

    expect(res.body.data.created).toBe(true);
    expect(res.body.data.assignment.dockDoor.code).toBe('D5');
  });

  it('reports the dock the truck now holds, not the one it left', async () => {
    const res = await request(app)
      .post('/api/v1/trucks/TRK-101/dock-assignment')
      .send({ dockId: 'D4' })
      .expect(201);

    expect(res.body.data.currentAssignment).toMatchObject({ dockCode: 'D4', status: 'ASSIGNED' });
    expect(res.body.data.currentAssignment.id).toBe(res.body.data.assignment.id);
    expect(res.body.data.previousAssignment).toMatchObject({ dockCode: 'D2' });
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

  it('raises a DOCK_UNAVAILABLE alert naming what was stranded', async () => {
    const res = await request(app)
      .patch('/api/v1/docks/D2/status')
      .send({ status: 'UNAVAILABLE' })
      .expect(200);

    expect(res.body.data.affectedAssignments).toHaveLength(1);
    expect(res.body.data.affectedAssignments[0]).toMatchObject({ id: 'DA-3002' });
    expect(res.body.data.alert).toMatchObject({ type: 'DOCK_UNAVAILABLE', severity: 'WARNING', dockDoorId: 'D2' });

    // The alert is the first line of the timeline, not the whole story — where
    // TRK-101 actually went is `dock-failure.test.ts`'s subject.
    expect(res.body.data.reassignments).toHaveLength(1);
  });

  it('comes back AVAILABLE once its booking has moved on', async () => {
    // The Phase 8 cascade takes DA-3002 with it, so by the time D2 is repaired
    // it genuinely holds nothing.
    await request(app).patch('/api/v1/docks/D2/status').send({ status: 'UNAVAILABLE' }).expect(200);
    const res = await request(app).patch('/api/v1/docks/D2/status').send({ status: 'AVAILABLE' }).expect(200);

    expect(res.body.data.dock.status).toBe('AVAILABLE');
    expect(res.body.data.dock.unavailableReason).toBeNull();
  });

  it('restores a door that still holds a booking to RESERVED, not AVAILABLE', async () => {
    // No API path produces this any more — the cascade always moves or cancels
    // the booking — but the WMS feed can, so build the state directly.
    const scheduledEnd = new Date(Date.now() + 60 * 60_000);
    await prisma.dockDoor.update({
      where: { id: 'D3' },
      data: { status: 'UNAVAILABLE', unavailableReason: 'Fire damage' },
    });
    await prisma.dockAssignment.create({
      data: {
        id: 'DA-TEST-SURVIVOR',
        truckId: 'TRK-102',
        dockDoorId: 'D3',
        status: 'ASSIGNED',
        scheduledStart: new Date(),
        scheduledEnd,
        assignedAt: new Date(),
      },
    });

    const res = await request(app).patch('/api/v1/docks/D3/status').send({ status: 'AVAILABLE' }).expect(200);

    expect(res.body.data.dock.status).toBe('RESERVED');
    expect(res.body.data.dock.unavailableReason).toBeNull();
    expect(new Date(res.body.data.dock.availableFrom).getTime()).toBe(scheduledEnd.getTime());
  });

  it('updates the reason when an already-down door is re-marked', async () => {
    await request(app)
      .patch('/api/v1/docks/D3/status')
      .send({ status: 'UNAVAILABLE', reason: 'Hydraulic leveler fault' })
      .expect(200);

    const res = await request(app)
      .patch('/api/v1/docks/D3/status')
      .send({ status: 'UNAVAILABLE', reason: 'Fire damage' })
      .expect(200);

    expect(res.body.data.changed).toBe(true);
    expect(res.body.data.dock.unavailableReason).toBe('Fire damage');

    // Restating the *same* reason really is a no-op.
    const again = await request(app)
      .patch('/api/v1/docks/D3/status')
      .send({ status: 'UNAVAILABLE', reason: 'Fire damage' })
      .expect(200);

    expect(again.body.data.changed).toBe(false);
  });

  it('rejects a status the operator does not own', async () => {
    const res = await request(app).patch('/api/v1/docks/D3/status').send({ status: 'OCCUPIED' }).expect(400);
    expect(res.body.error.details).toBeDefined();
  });

  it('404s on an unknown dock', async () => {
    await request(app).patch('/api/v1/docks/D99/status').send({ status: 'UNAVAILABLE' }).expect(404);
  });
});
