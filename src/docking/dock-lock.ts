import { logger } from '../lib/logger.js';

/**
 * Serialises the yard's write operations against each other (CLAUDE.md §18).
 *
 * The problem it solves: `dockStillTakes` re-checks a door *inside* the
 * assignment transaction, but Postgres runs READ COMMITTED, so two concurrent
 * `assignDock` calls for the same door each run that check before either has
 * committed its INSERT. Both count zero clashes, both commit, and the door ends
 * up holding two live assignments — with no unique or exclusion constraint to
 * catch it.
 *
 * Running the write paths one at a time closes the window: the second caller's
 * `dockStillTakes` now runs after the first has committed, sees the clash, and
 * is refused (409) or walks to its next recommendation. Scoring itself stays
 * outside the lock — it is read-only and the recheck is what decides anyway.
 *
 * One lock for the whole yard rather than one per door. The keyed version would
 * be marginally more parallel, but `reassignDock` does not know which door it
 * will land on until it has walked the ranking *inside* its transaction, so it
 * has no key to take; a mix of yard-wide and per-door keys would not exclude
 * each other, and taking two keys invites deadlock. With eight doors and a
 * sub-millisecond transaction, the contention this gives up is not measurable —
 * and §26 says to take the simpler of two workable answers.
 *
 * This is a **process-local** guarantee. It is complete for the locked
 * single-process architecture (§3); a second Node process would need a Postgres
 * exclusion constraint instead. `docs/architecture.md` says so out loud.
 *
 * Not re-entrant: nothing holding the lock may call another `withYardLock`.
 * Today the three holders are `assignDock`, `reassignDock` and `releaseDock`,
 * and none of them calls the others. `handleDockFailure` deliberately stays
 * outside — it loops over trucks calling `reassignDock`, so holding the lock
 * across the whole cascade would deadlock on the first truck.
 */

/**
 * The tail of the queue. Chained off both outcomes, so one rejected operation
 * cannot wedge every later one, and the stored link is kept non-rejecting for
 * the same reason — exactly the pattern `SimulationManager.enqueue` uses for
 * its lifecycle queue.
 */
let tail: Promise<unknown> = Promise.resolve();

/** Runs `op` after every yard operation already queued, and returns its result. */
export async function withYardLock<T>(label: string, op: () => Promise<T>): Promise<T> {
  const run = tail.then(
    () => {
      logger.debug(`Yard lock acquired: ${label}`);
      return op();
    },
    () => {
      logger.debug(`Yard lock acquired: ${label}`);
      return op();
    },
  );

  tail = run.catch(() => undefined);
  return run;
}

/**
 * Drains the queue. Tests use it to be sure no operation is still in flight
 * before they snapshot or restore the yard.
 */
export async function yardLockIdle(): Promise<void> {
  await tail;
}
