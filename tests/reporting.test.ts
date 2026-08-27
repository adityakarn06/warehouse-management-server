import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { disconnectPrisma } from '../src/lib/prisma.js';

/**
 * Read-only integration tests for the new reporting surface added to close the
 * gaps against `docs/problemStatement.md`: the unified identifier lookup, the
 * dock-door assignment schedule, the trailer-to-door allocation summary, and
 * the arrival-window docking queue. Runs against the seeded development
 * database, same convention as `read-api.test.ts` — nothing here writes.
 */
let app: Express;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe('GET /api/v1/tracking/:trackingNumber — unified identifier lookup', () => {
  it('resolves by tracking number', async () => {
    const res = await request(app).get('/api/v1/tracking/E2-TRACK-101').expect(200);
    expect(res.body.data.reference).toBe('SHP-1001');
    expect(res.body.data.resolvedBy).toBe('TRACKING_NUMBER');
  });

  it('resolves by shipment reference', async () => {
    const res = await request(app).get('/api/v1/tracking/SHP-1001').expect(200);
    expect(res.body.data.trackingNumber).toBe('E2-TRACK-101');
    expect(res.body.data.resolvedBy).toBe('SHIPMENT_REFERENCE');
  });

  it('resolves by trailer id', async () => {
    const res = await request(app).get('/api/v1/tracking/TRL-101').expect(200);
    expect(res.body.data.reference).toBe('SHP-1001');
    expect(res.body.data.resolvedBy).toBe('TRAILER_ID');
  });

  it('404s on an identifier that matches nothing', async () => {
    const res = await request(app).get('/api/v1/tracking/NOPE-999').expect(404);
    expect(res.body.error).toMatchObject({ status: 404, message: expect.any(String) });
  });
});

describe('GET /api/v1/trucks/:id — trailer id arm', () => {
  it('resolves a truck by trailer id', async () => {
    const res = await request(app).get('/api/v1/trucks/TRL-101').expect(200);
    expect(res.body.data.reference).toBe('TRK-101');
  });
});

describe('GET /api/v1/docks/schedule', () => {
  it('is ordered by scheduledStart and excludes RECOMMENDED rows by default', async () => {
    const res = await request(app).get('/api/v1/docks/schedule').expect(200);
    const { docks } = res.body.data;
    expect(Array.isArray(docks)).toBe(true);

    for (const dock of docks) {
      const starts = dock.assignments.map((a: { scheduledStart: string }) => a.scheduledStart);
      const sorted = [...starts].sort();
      expect(starts).toEqual(sorted);
      for (const assignment of dock.assignments) {
        expect(assignment.status).not.toBe('RECOMMENDED');
      }
    }
  });

  it('includes RECOMMENDED rows when asked', async () => {
    const res = await request(app)
      .get('/api/v1/docks/schedule?includeRecommended=true&from=2026-08-27T00:00:00.000Z&to=2026-08-28T00:00:00.000Z')
      .expect(200);
    const statuses = res.body.data.docks.flatMap((dock: { assignments: { status: string }[] }) =>
      dock.assignments.map((a) => a.status),
    );
    expect(statuses).toContain('RECOMMENDED');
  });

  it('registers before /:id — "schedule" is not treated as a dock id', async () => {
    const res = await request(app).get('/api/v1/docks/schedule').expect(200);
    expect(res.body.data.docks).toBeDefined();
  });
});

describe('GET /api/v1/yard/allocation-summary', () => {
  it('totals match the arrays returned', async () => {
    const res = await request(app).get('/api/v1/yard/allocation-summary').expect(200);
    const { totals, allocations, unallocated } = res.body.data;

    expect(allocations).toHaveLength(totals.allocatedTrailers);
    expect(unallocated).toHaveLength(totals.unallocatedTrailers);
  });

  it('shows the seeded reassignment chain for TRK-107', async () => {
    // Seeded Scenario D outcome: DA-3005 -> DA-3006, TRK-107 now on D8.
    const res = await request(app).get('/api/v1/yard/allocation-summary').expect(200);
    const entry = res.body.data.allocations.find(
      (row: { truckReference: string }) => row.truckReference === 'TRK-107',
    );
    expect(entry).toBeDefined();
    expect(entry.chainedFrom).toBe('DA-3005');
  });
});

describe('GET /api/v1/yard/docking-queue', () => {
  it('buckets trucks by appointment window and attaches a top recommendation', async () => {
    const res = await request(app).get('/api/v1/yard/docking-queue').expect(200);
    const { windows } = res.body.data;
    expect(Array.isArray(windows)).toBe(true);

    for (const window of windows) {
      for (const entry of window.entries) {
        expect(entry.truckId).toBeTypeOf('string');
        if (entry.topRecommendation !== null) {
          expect(entry.topRecommendation.reasons.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never includes a truck that already holds a committed assignment', async () => {
    const res = await request(app).get('/api/v1/yard/docking-queue').expect(200);
    const references = res.body.data.windows.flatMap(
      (window: { entries: { truckReference: string }[] }) =>
        window.entries.map((entry) => entry.truckReference),
    );
    // TRK-101 and TRK-107 are seeded with committed (ASSIGNED) doors.
    expect(references).not.toContain('TRK-101');
    expect(references).not.toContain('TRK-107');
  });

  it('never includes a COMPLETED truck', async () => {
    const res = await request(app).get('/api/v1/yard/docking-queue').expect(200);
    const references = res.body.data.windows.flatMap(
      (window: { entries: { truckReference: string }[] }) =>
        window.entries.map((entry) => entry.truckReference),
    );
    expect(references).not.toContain('TRK-111');
  });
});
