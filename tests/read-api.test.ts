import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { disconnectPrisma } from '../src/lib/prisma.js';

/**
 * Integration tests for the Phase 3 read APIs. They run against the seeded
 * development database and are strictly read-only, so they cannot corrupt it.
 * Run `pnpm db:seed` first if these fail on missing fixtures.
 */
let app: Express;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe('GET /api/v1/tracking/:trackingNumber', () => {
  it('returns the customer-facing payload for a seeded shipment', async () => {
    const res = await request(app).get('/api/v1/tracking/E2-TRACK-101').expect(200);
    const data = res.body.data;

    expect(data.reference).toBe('SHP-1001');
    expect(data.trackingNumber).toBe('E2-TRACK-101');
    expect(data.trailerId).toBe('TRL-101');
    expect(data.origin).toMatchObject({ name: expect.any(String) });
    expect(data.destination.name).toContain('Kolkata');
    expect(data.currentPosition.latitude).toBeTypeOf('number');
    expect(data.progress).toBeTypeOf('number');
    expect(data.priority).toBe('HIGH');
    expect(data.loadType).toBe('REFRIGERATED');
    expect(data.appointmentWindow).not.toBeNull();
    // Seeded Scenario D: TRK-101 is assigned to D2.
    expect(data.assignedDock.id).toBe('D2');
  });

  it('does not report a merely RECOMMENDED dock as the assigned one', async () => {
    // SHP-1004 has a RECOMMENDED assignment to D5 and nothing ASSIGNED. A
    // recommendation is a proposal, so the customer must not be sent to D5.
    const res = await request(app).get('/api/v1/tracking/E2-TRACK-104').expect(200);
    expect(res.body.data.assignedDock).toBeNull();
  });

  it('404s on an unknown tracking number with the standard error shape', async () => {
    const res = await request(app).get('/api/v1/tracking/NOPE').expect(404);
    expect(res.body.error).toMatchObject({ status: 404, message: expect.any(String) });
    expect(res.body.data).toBeUndefined();
  });
});

describe('GET /api/v1/trucks', () => {
  it('lists every seeded truck with pagination meta', async () => {
    const res = await request(app).get('/api/v1/trucks').expect(200);
    expect(res.body.meta).toEqual({ total: 12, limit: 50, offset: 0 });
    expect(res.body.data).toHaveLength(12);
  });

  it('filters by status', async () => {
    const res = await request(app).get('/api/v1/trucks?status=DELAYED').expect(200);
    const references = res.body.data.map((truck: { reference: string }) => truck.reference);
    expect(references).toEqual(['TRK-103', 'TRK-106']);
  });

  it('honours limit and offset', async () => {
    const res = await request(app).get('/api/v1/trucks?limit=3&offset=2').expect(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta).toEqual({ total: 12, limit: 3, offset: 2 });
    expect(res.body.data[0].reference).toBe('TRK-103');
  });

  it('rejects a non-numeric limit with 400 and Zod issues', async () => {
    const res = await request(app).get('/api/v1/trucks?limit=abc').expect(400);
    expect(res.body.error.status).toBe(400);
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('never returns route geometry', async () => {
    const res = await request(app).get('/api/v1/trucks').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('geometry');
  });
});

describe('GET /api/v1/trucks/:id', () => {
  it('resolves a seeded truck by its human id', async () => {
    const res = await request(app).get('/api/v1/trucks/TRK-101').expect(200);
    expect(res.body.data.reference).toBe('TRK-101');
    expect(res.body.data.route.code).toBeTypeOf('string');
    expect(Array.isArray(res.body.data.locationHistory)).toBe(true);
  });

  it('404s on an unknown truck', async () => {
    await request(app).get('/api/v1/trucks/TRK-999').expect(404);
  });
});

describe('GET /api/v1/routes/:id', () => {
  it('is the one endpoint that returns geometry', async () => {
    const res = await request(app).get('/api/v1/routes/RTE-DEL-KOL-01').expect(200);
    expect(Array.isArray(res.body.data.geometry)).toBe(true);
    expect(res.body.data.geometry.length).toBeGreaterThan(1);
  });
});

describe('GET /api/v1/shipments', () => {
  it('lists shipments and filters by priority', async () => {
    const all = await request(app).get('/api/v1/shipments').expect(200);
    expect(all.body.meta.total).toBe(12);

    const critical = await request(app).get('/api/v1/shipments?priority=CRITICAL').expect(200);
    expect(critical.body.meta.total).toBeGreaterThan(0);
    for (const shipment of critical.body.data) {
      expect(shipment.priority).toBe('CRITICAL');
    }
  });

  it('resolves by id and by reference', async () => {
    const byId = await request(app).get('/api/v1/shipments/SHP-1001').expect(200);
    const byReference = await request(app)
      .get('/api/v1/shipments/reference/SHP-1001')
      .expect(200);
    expect(byId.body.data.trackingNumber).toBe(byReference.body.data.trackingNumber);
  });

  it('404s on an unknown reference', async () => {
    await request(app).get('/api/v1/shipments/reference/SHP-9999').expect(404);
  });
});

describe('GET /api/v1/docks', () => {
  it('returns all eight docks', async () => {
    const res = await request(app).get('/api/v1/docks').expect(200);
    expect(res.body.meta.total).toBe(8);
  });

  it('filters by supported load type', async () => {
    const res = await request(app).get('/api/v1/docks?loadType=OVERSIZED').expect(200);
    const codes = res.body.data.map((dock: { code: string }) => dock.code);
    expect(codes).toEqual(['D6']);
  });

  it('filters by status', async () => {
    const res = await request(app).get('/api/v1/docks?status=UNAVAILABLE').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].code).toBe('D7');
    expect(res.body.data[0].unavailableReason).toBeTruthy();
  });

  it('returns a single dock with its assignments', async () => {
    const res = await request(app).get('/api/v1/docks/D2').expect(200);
    expect(res.body.data.code).toBe('D2');
    expect(Array.isArray(res.body.data.assignments)).toBe(true);
  });
});

describe('GET /api/v1/dock-assignments', () => {
  it('lists assignments and filters by truck', async () => {
    const all = await request(app).get('/api/v1/dock-assignments').expect(200);
    expect(all.body.meta.total).toBe(6);

    const forTruck = await request(app)
      .get('/api/v1/dock-assignments?truckId=TRK-107')
      .expect(200);
    // TRK-107 has the seeded reassignment chain: D7 REASSIGNED -> D8 ASSIGNED.
    expect(forTruck.body.meta.total).toBe(2);
  });
});

describe('GET /api/v1/alerts', () => {
  it('excludes acknowledged alerts when asked', async () => {
    const res = await request(app).get('/api/v1/alerts?acknowledged=false').expect(200);
    const ids = res.body.data.map((alert: { id: string }) => alert.id);
    expect(ids).not.toContain('AL-4003');
    expect(ids).not.toContain('AL-4007');
    expect(res.body.meta.total).toBe(5);
  });

  it('filters by severity', async () => {
    const res = await request(app).get('/api/v1/alerts?severity=CRITICAL').expect(200);
    for (const alert of res.body.data) {
      expect(alert.severity).toBe('CRITICAL');
    }
  });

  it('rejects an unknown severity', async () => {
    await request(app).get('/api/v1/alerts?severity=BANANA').expect(400);
  });
});

describe('GET /api/v1/yard/overview', () => {
  it('returns the full operations snapshot', async () => {
    const res = await request(app).get('/api/v1/yard/overview').expect(200);
    const data = res.body.data;

    expect(Object.keys(data).sort()).toEqual([
      'activeAssignments',
      'activeTrucks',
      'alerts',
      'docks',
      'generatedAt',
      'summary',
      'upcomingArrivals',
    ]);

    // TRK-111 is COMPLETED and must not appear as active.
    const references = data.activeTrucks.map((truck: { reference: string }) => truck.reference);
    expect(references).not.toContain('TRK-111');
    expect(data.summary.activeTrucks).toBe(references.length);
    expect(data.summary.delayedTrucks).toBe(2);
    expect(data.docks).toHaveLength(8);
    expect(data.summary.unresolvedAlerts).toBe(5);

    // Scenario D wiring is visible to the dashboard.
    const trk101 = data.activeTrucks.find(
      (truck: { reference: string }) => truck.reference === 'TRK-101',
    );
    expect(trk101.assignedDockId).toBe('D2');
  });

  it('sorts upcoming arrivals by ETA, with unknown ETAs last', async () => {
    const res = await request(app).get('/api/v1/yard/overview').expect(200);
    const etas = res.body.data.upcomingArrivals.map(
      (truck: { eta: string | null }) => truck.eta,
    );
    const withEta = etas.filter((eta: string | null) => eta !== null);
    // Every non-null ETA comes first, and they are ascending.
    expect(etas.slice(0, withEta.length)).toEqual(withEta);
    expect(withEta).toEqual([...withEta].sort());
  });

  it('leaves a dock with only a RECOMMENDED assignment free', async () => {
    const res = await request(app).get('/api/v1/yard/overview').expect(200);
    const d5 = res.body.data.docks.find((dock: { code: string }) => dock.code === 'D5');
    expect(d5.status).toBe('AVAILABLE');
    // An AVAILABLE door must never carry a current assignment.
    expect(d5.currentAssignment).toBeNull();

    const trk104 = res.body.data.activeTrucks.find(
      (truck: { reference: string }) => truck.reference === 'TRK-104',
    );
    expect(trk104.assignedDockId).toBeNull();
  });
});

describe('request body validation', () => {
  it('rejects a malformed JSON body as a 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/v1/shipments')
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);
    expect(res.body.error).toMatchObject({ status: 400, message: expect.any(String) });
  });
});

describe('unknown routes', () => {
  it('404s with the standard error shape', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body.error.status).toBe(404);
  });
});
