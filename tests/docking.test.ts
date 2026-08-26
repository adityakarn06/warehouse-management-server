import { describe, expect, it } from 'vitest';
import type { ScoringContext, ScoringDock } from '../src/docking/dock-scoring.js';
import { scoreDocks } from '../src/docking/dock-scoring.js';

/**
 * The dock scoring engine is pure — no database, no clock, no Prisma — so these
 * tests drive it directly with hand-built docks and a fixed reference time.
 */

const NOW = new Date('2026-08-26T10:00:00.000Z');
const MIN = 60_000;

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MIN);
}

function dock(overrides: Partial<ScoringDock> = {}): ScoringDock {
  return {
    id: 'D3',
    code: 'D3',
    name: 'Dock Door 3',
    zone: 'NORTH',
    status: 'AVAILABLE',
    supportedLoadTypes: ['GENERAL'],
    availableFrom: null,
    unavailableReason: null,
    bookedWindows: [],
    ...overrides,
  };
}

function context(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    loadType: 'GENERAL',
    priority: 'MEDIUM',
    windowStart: at(0),
    windowEnd: at(60),
    appointment: { windowStart: at(0), windowEnd: at(60), expectedDurationMinutes: 60 },
    ...overrides,
  };
}

const codes = (rows: { dockCode: string }[]): string[] => rows.map((row) => row.dockCode);

describe('scoreDocks — hard filters', () => {
  it('excludes unavailable docks and says why', () => {
    const result = scoreDocks(
      [
        dock({ id: 'D7', code: 'D7', status: 'UNAVAILABLE', unavailableReason: 'Leveler fault' }),
        dock(),
      ],
      context(),
    );

    expect(codes(result.recommendations)).toEqual(['D3']);
    expect(result.excluded).toEqual([
      { dockId: 'D7', dockCode: 'D7', reason: 'Dock is out of service: Leveler fault' },
    ]);
  });

  it('excludes docks that cannot handle the load type', () => {
    const result = scoreDocks(
      [
        dock({ id: 'D3', code: 'D3', supportedLoadTypes: ['GENERAL'] }),
        dock({ id: 'D6', code: 'D6', supportedLoadTypes: ['OVERSIZED', 'GENERAL'] }),
      ],
      context({ loadType: 'OVERSIZED' }),
    );

    expect(codes(result.recommendations)).toEqual(['D6']);
    expect(result.excluded[0]).toMatchObject({
      dockCode: 'D3',
      reason: 'Does not support OVERSIZED loads',
    });
  });

  it('excludes a dock already booked across the requested slot', () => {
    const result = scoreDocks(
      [dock({ bookedWindows: [{ start: at(30), end: at(90) }] })],
      context(),
    );

    expect(result.recommendations).toHaveLength(0);
    expect(result.excluded[0]?.reason).toContain('Already booked');
  });

  it('ignores a booking that does not overlap the slot', () => {
    const result = scoreDocks(
      [dock({ bookedWindows: [{ start: at(120), end: at(180) }] })],
      context(),
    );

    expect(codes(result.recommendations)).toEqual(['D3']);
  });

  it('excludes a dock that only frees up after the slot has ended — Scenario E', () => {
    // D6 is the only OVERSIZED door and it is occupied for another 90 minutes,
    // which is exactly the seeded setup behind SHP-1009.
    const result = scoreDocks(
      [dock({ id: 'D6', code: 'D6', supportedLoadTypes: ['OVERSIZED', 'GENERAL'], status: 'OCCUPIED', availableFrom: at(90) })],
      context({ loadType: 'OVERSIZED' }),
    );

    expect(result.recommendations).toHaveLength(0);
    expect(result.excluded[0]?.reason).toContain('after this slot ends');
  });
});

describe('scoreDocks — scoring', () => {
  it('gives every recommendation at least one human-readable reason', () => {
    const result = scoreDocks([dock()], context());

    expect(result.recommendations[0]?.reasons.length).toBeGreaterThan(0);
    expect(result.recommendations[0]?.reasons[0]).toBe('General-purpose door, ideal for general freight');
  });

  it('prefers a plain door over a specialist one for general freight', () => {
    const result = scoreDocks(
      [
        dock({ id: 'D3', code: 'D3', supportedLoadTypes: ['GENERAL'] }),
        dock({ id: 'D4', code: 'D4', supportedLoadTypes: ['REFRIGERATED', 'GENERAL'] }),
      ],
      context(),
    );

    expect(codes(result.recommendations)).toEqual(['D3', 'D4']);
  });

  it('scores a specialist door full marks for the load it exists for', () => {
    const result = scoreDocks(
      [dock({ id: 'D4', code: 'D4', supportedLoadTypes: ['REFRIGERATED', 'GENERAL'] })],
      context({ loadType: 'REFRIGERATED' }),
    );

    expect(result.recommendations[0]?.breakdown.loadTypeFit).toBe(25);
    expect(result.recommendations[0]?.reasons).toContain('Compatible with refrigerated load');
  });

  it('scores a dock that is free now above one that frees up mid-slot', () => {
    const result = scoreDocks(
      [
        dock({ id: 'D3', code: 'D3' }),
        dock({ id: 'D4', code: 'D4', status: 'OCCUPIED', availableFrom: at(30) }),
      ],
      context(),
    );

    const [first, second] = result.recommendations;
    expect(first?.dockCode).toBe('D3');
    expect(first?.reasons).toContain('Available before ETA');
    expect(second?.reasons).toContain('Frees up 30 min after the truck is due');
    expect(first!.score).toBeGreaterThan(second!.score);
  });

  it('lets the appointment window change the score', () => {
    const roomy = scoreDocks([dock()], context()).recommendations[0]!;
    // The truck arrives 40 minutes into its own hour-long booking, so only 20
    // of the 60 minutes it needs are left inside the window.
    const tight = scoreDocks(
      [dock()],
      context({
        windowStart: at(40),
        windowEnd: at(100),
        appointment: { windowStart: at(0), windowEnd: at(60), expectedDurationMinutes: 60 },
      }),
    ).recommendations[0]!;

    expect(roomy.breakdown.appointmentFit).toBe(25);
    expect(tight.breakdown.appointmentFit).toBeLessThan(25);
    expect(tight.score).toBeLessThan(roomy.score);
    expect(tight.reasons).toContain('Covers 20 of the 60 minutes booked');
  });

  it('scores a truck with no appointment neutrally and says so', () => {
    const result = scoreDocks([dock()], context({ appointment: null }));

    expect(result.recommendations[0]?.breakdown.appointmentFit).toBe(15);
    expect(result.recommendations[0]?.reasons).toContain('No appointment booked — scored on ETA alone');
  });

  it('punishes waiting twice as hard for a high-priority shipment', () => {
    const late = dock({ id: 'D4', code: 'D4', status: 'OCCUPIED', availableFrom: at(30) });

    const low = scoreDocks([late], context({ priority: 'LOW' })).recommendations[0]!;
    const high = scoreDocks([late], context({ priority: 'HIGH' })).recommendations[0]!;

    expect(high.breakdown.priorityFit).toBeLessThan(low.breakdown.priorityFit);
    expect(high.score).toBeLessThan(low.score);
    expect(high.reasons).toContain('Would hold a high-priority shipment for 30 min');
  });

  it('names the priority when the door suits an urgent shipment', () => {
    const result = scoreDocks([dock()], context({ priority: 'CRITICAL' }));

    expect(result.recommendations[0]?.breakdown.priorityFit).toBe(15);
    expect(result.recommendations[0]?.reasons).toContain('Suitable for critical-priority shipment');
  });

  it('is deterministic: identical docks always rank by code', () => {
    const docks = [
      dock({ id: 'D5', code: 'D5' }),
      dock({ id: 'D1', code: 'D1' }),
      dock({ id: 'D3', code: 'D3' }),
    ];

    const first = scoreDocks(docks, context());
    const second = scoreDocks([...docks].reverse(), context());

    expect(codes(first.recommendations)).toEqual(['D1', 'D3', 'D5']);
    expect(codes(second.recommendations)).toEqual(codes(first.recommendations));
    expect(second.recommendations.map((r) => r.score)).toEqual(first.recommendations.map((r) => r.score));
  });

  it('keeps every score inside 0-100', () => {
    const result = scoreDocks(
      [
        dock({ id: 'D1', code: 'D1' }),
        dock({ id: 'D2', code: 'D2', status: 'RESERVED', availableFrom: at(59) }),
        dock({ id: 'D4', code: 'D4', supportedLoadTypes: ['REFRIGERATED', 'HAZARDOUS', 'GENERAL'] }),
      ],
      context(),
    );

    for (const row of result.recommendations) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(row.score)).toBe(true);
    }
  });
});
