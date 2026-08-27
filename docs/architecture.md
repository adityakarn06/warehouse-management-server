# E2 Backend — Architecture

> **E2: Where's My Truck?** — a real-time warehouse execution and control-tower
> backend. This document explains the shape of the system and the handful of
> decisions that a frontend developer, or a judge, actually needs to understand.
> For the endpoint-by-endpoint contract see [`api.md`](./api.md) and
> [`realtime.md`](./realtime.md).

---

## The layers

```text
                          Frontend
                   (map, dashboard, tracking)
                              |
              +---------------+---------------+
              |                               |
            REST                          Socket.IO
      (commands + reads)              (authoritative feed)
              |                               |
              +---------------+---------------+
                              |
                              v
                  +-----------------------+
                  |   Node.js process     |
                  |  Express + Socket.IO  |
                  +-----------------------+
                              |
        +----------+----------+----------+-----------+
        |          |          |          |           |
        v          v          v          v           v
   Simulation     ETA       Dock      Alert         WMS
     Engine      Engine   Assignment  Engine    Event Handler
        |          |          |          |           |
        +----------+----------+----------+-----------+
                              |
                              v
                        Realtime Service
                     (domain event -> rooms)
                              |
                              v
                          Prisma ORM
                              |
                              v
                         PostgreSQL
```

Everything above runs in **one Node.js process** (§3). Express, Socket.IO and
the simulation loop share it deliberately: the loop mutates in-memory state that
the HTTP handlers read, and splitting them would mean inventing a synchronisation
protocol for a demo that does not need one. There is no Redis, no Kafka, no
message broker and no second service.

### Where the code lives

| Layer | Directory | Responsibility |
| --- | --- | --- |
| HTTP wiring | `src/routes/` | path → handler, nothing else |
| Request handling | `src/controllers/` | parse, delegate, respond |
| Cross-cutting | `src/middleware/` | request log, 404, central error handler |
| Reads | `src/services/` | list/detail queries behind the `GET` endpoints |
| Movement | `src/simulation/` | the loop, live state, the per-truck tick |
| Arrival times | `src/eta/` | `calculateEta` — pure |
| The yard, write side | `src/docking/` | scoring, assignment, the failure cascade |
| External facts | `src/wms/` | the simulated WMS feed |
| Realtime | `src/websocket/` | rooms, the subscribe protocol, the only Socket.IO caller |

Note there are two files named `dock-assignment-service.ts` on purpose:
`src/services/` only *lists* assignment rows for `GET /api/v1/dock-assignments`,
while `src/docking/` owns every consequence of a recommendation being taken.
`src/services/docking-queue-service.ts` (§8) stays on the reads side for the
same reason: it calls the write side's `recommendDocks` but never writes.

---

## Decision 1 — the backend broadcasts authoritative positions every 2 seconds, and the frontend interpolates

**This is the most important thing to understand about the system.**

The backend advances every moving truck once every `SIMULATION_TICK_MS`
(2000 by default), recomputes its position, progress and ETA, and broadcasts the
result. It does **not** send 30 or 60 updates a second, and the frontend does
**not** compute where a truck "should" be.

```text
Backend (authoritative, every 2s)      Frontend (visual, every frame)

  t=0s  ─── position A ──────────────►  A ────────────────► B
  t=2s  ─── position B ──────────────►  B ────────────────► C
  t=4s  ─── position C ──────────────►  C ────────────────► D
  t=6s  ─── position D ──────────────►     smooth animation
```

To make that animation possible without the frontend guessing, every
`TRUCK_POSITION_UPDATED` carries three pairs of coordinates:

| Field | Meaning |
| --- | --- |
| `previousLatitude` / `previousLongitude` | where the truck was at the last tick |
| `latitude` / `longitude` | where it is **now** — the authoritative position |
| `targetLatitude` / `targetLongitude` | where it is projected to be at the **next** tick |

So the frontend animates from `latitude`/`longitude` toward
`targetLatitude`/`targetLongitude` over the tick interval, and uses `previous*`
to smooth a late or dropped update. The target is computed by the backend from
the truck's real effective speed along its real route geometry — it is a
projection, not a guess, and it is corrected by the next authoritative tick.

**Why it is built this way.** Interpolation is a rendering concern; movement is
a business fact. Putting the movement in the frontend would mean two clients
disagreeing about where a truck is, a refresh losing the position, and a delay
scenario having to be re-implemented in the browser to stay consistent. Putting
the rendering in the backend would mean 30 messages a second per truck for a
smoothness the browser can produce for free. Splitting them at 2 seconds gives
one authoritative answer and smooth motion at the same time.

**What follows from it.** The backend never sends route geometry on a tick, and
never sends whole database rows (§24). A position payload is a dozen small
fields. `Route.geometry` is returned by exactly one endpoint,
`GET /api/v1/routes/:id`, and the frontend fetches it once.

---

## Decision 2 — the backend owns every operational decision

The frontend requests actions; it does not make them (§2).

```text
Frontend:  "Make D2 unavailable"

Backend:   D2 -> UNAVAILABLE
             -> raise DOCK_UNAVAILABLE alert
             -> find the trucks assigned to D2
             -> re-score every remaining door for each of them
             -> D4 wins for TRK-101 -> reassign
             -> raise DOCK_REASSIGNMENT alert
             -> emit DOCK_STATUS_CHANGED, DOCK_REASSIGNED, ALERT_CREATED
             -> answer the request with everything it decided
```

The frontend must never independently decide that D4 is the replacement. It
sends one `PATCH`, and the response body already contains the outcome for every
affected truck — the same facts that went out over Socket.IO.

The same rule governs delays: the frontend sends `{ "type": "RAIN" }` and
nothing else. Effective speed, the recalculated ETA, the `DELAYED` status, the
persisted alert and three realtime events are all consequences the backend owns.

---

## Decision 3 — live state is in memory; PostgreSQL is not a tick log

`LiveTruckState` in `src/simulation/live-state.ts` is the source of truth between
writes. A truck row reaches the database only when something *happened*:

- a status transition (`IN_TRANSIT → ARRIVING → ARRIVED`),
- every `SIMULATION_CHECKPOINT_PROGRESS_STEP` percent of progress (5% by default),
- a delay activated or cleared,
- a dock assignment, reassignment or release,
- an arrival, docking or completion reported by the WMS,
- and a final flush on `stop()`.

Nine trucks moving for an hour therefore write a few dozen rows, not sixteen
thousand. `sequenceNumber`, `previous*` and `lastPersistedProgress` never reach
the database at all — they are wire and bookkeeping concerns.

The engine is built so this is testable: `advanceTruck` is pure and
elapsed-time-based (it takes `elapsedMs` and returns a fresh state, never
mutating its input or reading a clock), and route geometry is parsed and
measured once per route into a memoised `RouteProfile`.

---

## Decision 4 — domain code never touches Socket.IO

```text
SimulationEngine ──► SimulationEventSink ──► RealtimeService ──► Socket.IO
DockAssignment   ──► DockingEventSink    ──►      ▲
WmsEventHandler  ──► WmsRealtimeSink     ──►──────┘
```

`RealtimeService` is the only module in the codebase that may call Socket.IO.
Domain services emit a typed `RealtimeEvent` into a sink and let `roomsFor()`
decide who sees it. Two things follow:

- **The engines are testable without a server.** `tests/simulation.test.ts` and
  `tests/docking.test.ts` run the real logic against in-memory fakes — no
  sockets, no database, no timers.
- **A torn-down server cannot strand the engine.** The sinks resolve the *current*
  service per event rather than capturing one, so a close/re-init is safe and
  events are silently dropped when there is no server rather than throwing on a
  background loop.

Adding a realtime event means a member in `src/websocket/events.ts`, a case in
`roomsFor()`, and a row in `realtime.md`. Nothing else.

### Rooms

| Room | Who joins | Receives |
| --- | --- | --- |
| `operations` | the warehouse dashboard | everything operational |
| `truck:{truckId}` | anyone following one truck | that truck's position, ETA, status, dock events, alerts |
| `shipment:{shipmentId}` | the customer tracking page | the same, scoped to that shipment |

Nothing is broadcast to a socket that did not subscribe, and a subscriber gets
its opening snapshot in the **ack** of the subscribe call — so there is no gap
between "what state was I in" and "what changed since".

A dock going out of service reaches `operations` only. The customer learns about
it through the `DOCK_REASSIGNED` and `ALERT_CREATED` that follow, which is the
honest framing: a customer cares that their truck moved, not that a door broke.

---

## Decision 5 — dock assignment is deterministic and explainable

No ML (§9). `scoreDocks` in `src/docking/dock-scoring.ts` is pure, env-free and
deterministic: the same inputs always produce the same ranking.

It runs four **hard filters** — out of service, incompatible load type, booked
across the requested slot, frees up only after the slot ends — recording a
human sentence for each door it excludes. Then it scores the survivors on five
weighted components summing to 100:

| Component | Weight | Question |
| --- | --- | --- |
| `loadTypeFit` | 25 | Does the door handle this cargo? |
| `availabilityFit` | 30 | Is it free before the truck arrives? |
| `appointmentFit` | 25 | Does it cover the booked window? |
| `priorityFit` | 15 | Does it suit a shipment of this priority? |
| `statusBonus` | 5 | Is it free right now, or merely free by then? |

Every component contributes a sentence to `reasons`, so a recommendation reads
as an argument rather than a number:

```json
{
  "dockId": "D4",
  "score": 96,
  "reasons": [
    "Compatible with refrigerated load",
    "Available before ETA",
    "Covers 50 of the 60 minutes booked",
    "Suitable for high-priority shipment",
    "Door is free right now"
  ]
}
```

Reasons deliberately avoid absolute clock times ("frees up 30 min after the
truck is due", never "free at 18:40"): the backend does not know what timezone
the operator reads.

When nothing fits, the backend does **not** invent a dock. It cancels the
stranded assignment, raises a `CRITICAL` `NO_DOCK_AVAILABLE` alert carrying the
scorer's own exclusion sentences, and leaves the truck genuinely unassigned.

---

## Decision 6 — consistency

**Transactions.** Every multi-row yard change is one transaction (§18):
superseding the old assignment, freeing its door, creating the replacement and
reserving its door are never observable half-done. The failure cascade uses one
transaction **per truck**, not one per outage — a door can hold several bookings,
and one truck's move failing must not roll back another's.

**Two-phase checking.** Scoring reads the yard *before* the write, so
`dockStillTakes` re-asks inside the transaction against live rows: is the door
still in service, and is the slot still free? `assignDock` turns a refusal into
a `409`; `reassignDock` walks to its next recommendation instead.

**The yard lock.** Postgres runs READ COMMITTED, so two concurrent assignments
for the same door would each pass that recheck before either committed.
`src/docking/dock-lock.ts` serialises the three write paths (`assignDock`,
`reassignDock`, `releaseDock`) so the second caller's recheck runs after the
first has committed, sees the clash, and is refused.

**Status ownership.** Each dock status has exactly one writer, which is what
keeps the board from lying:

| Status | Written by |
| --- | --- |
| `AVAILABLE` / `UNAVAILABLE` | the operator, via `PATCH /docks/:id/status` |
| `RESERVED` | the assignment engine, on commit |
| `OCCUPIED` | the WMS feed only — a trailer that has physically backed in |

`PATCH /docks/:id/status` therefore accepts only `AVAILABLE` and `UNAVAILABLE`.
The same rule governs truck status: if a status has a co-ordinated write
elsewhere (`DELAYED` sets `activeDelay` too; `DOCKED` checks the assignment and
flips the door in the same transaction), the feed does not get to set it
directly.

**Assignment history.** `REASSIGNED` + `previousAssignmentId` is the *failure*
path's chain — "the yard forced this truck to move". A manual re-pick is
`CANCELLED`. Keeping them distinct is what makes the timeline readable.

---

## Decision 7 — the WMS is a source, not a contract

There is no real WMS. `POST /api/v1/wms/events` accepts six event types
(`TRAILER_LOCATION_UPDATED`, `TRAILER_STATUS_UPDATED`, `TRAILER_ARRIVED`,
`TRAILER_DOCKED`, `DOCK_STATUS_UPDATED`, `APPOINTMENT_UPDATED`) and
`POST /api/v1/wms/simulate` replays deterministic scripts through the *same*
handler — there is no second code path, so whatever the demo proves, the
endpoint does too.

Ingestion added **no** realtime events, **no** alert types and **no** migration.
It reuses the seven events already in the contract, so a frontend written before
the WMS existed sees WMS-driven updates with no change at all.

Two rules make a feed safe to retry: **re-sending a fact that is already true is
a success** (`applied: false`, no second alert), and **status ladders only run
forwards** — a late or duplicated `TRAILER_ARRIVED` never pulls a shipment back
from `DOCKED` or restamps `arrivedAt`.

---

## Decision 8 — the reporting surface reads, never decides

An audit against `docs/problemStatement.md` after Phase 10 found four things
the brief asks for that had no endpoint: resolving a trailer id (only a
tracking number or shipment reference worked), a view of which trailers need a
door for each arrival window, a forward-looking per-dock schedule, a
trailer-to-door allocation summary, and an `ARRIVING` alert for a truck the
simulation itself drives there rather than one reported by the WMS. All four
were closed as pure reads layered on the existing write paths — no migration,
no new realtime event, no change to an existing response shape.

```text
GET /api/v1/tracking/:id  ──► findShipmentByIdentifier ──► trackingNumber, then
                               (src/services/               reference, id, trailerId
                                tracking-service.ts)         — first match wins

GET /api/v1/yard/docking-queue ──► bucket by appointment window ──► recommendDocks
     (src/services/                (no committed door yet)         (read-only,
      docking-queue-service.ts)                                     per truck)

GET /api/v1/docks/schedule        ──► forward timeline per door, scheduledStart asc
     (src/services/dock-service.ts)

GET /api/v1/yard/allocation-summary ──► committed assignments + unallocated trucks
     (src/services/yard-service.ts)     + chainedFrom (reassignment provenance)
```

The docking queue is deliberately **not** an auto-assign path: it calls
`recommendDocks`, the same side-effect-free function `GET
/trucks/:id/dock-recommendations` uses, and writes nothing. A truck reaching
`ARRIVED` gets surfaced in the queue with its top recommendation attached; the
operator still presses `POST /trucks/:id/dock-assignment` to commit it (§2 —
the backend decides the ranking, a human decides to act on it). Recommendations
across a window's entries are fetched concurrently, and one truck the scorer
can no longer resolve does not fail the whole request — it just gets no
recommendation, logged rather than thrown.

`TRUCK_ARRIVING` now has two independent writers reaching the same alert type:
`SimulationManager.raiseArrivingAlert`, on the tick a truck's status flips to
`ARRIVING`, and the WMS handler's existing `TRAILER_STATUS_UPDATED` path. This
mirrors the project's `TRUCK_STATUS_CHANGED` pattern of one type, several
writers, rather than adding a scenario-specific alert.

**Null scheduled windows are bookings, not gaps.** `getDockSchedule`'s
`from`/`to` range is an overlap filter, but `scheduledStart`/`scheduledEnd` are
nullable and a Postgres range comparison never matches `NULL`. An assignment
with no window is still occupying the door — `dockStillTakes` in the
assignment engine already treats it that way when checking for a clash — so the
schedule includes it unconditionally rather than letting a taken door read as
free.

---

## Lifecycle

The simulation manager supports `start()`, `stop()`, `reset()`,
`getTruckState()` and `getAllTruckStates()`, and there is exactly **one**
interval for the whole process. `start()` is idempotent — a second call logs and
returns rather than installing a second loop. All three lifecycle operations run
through a serialising queue, so a `stop` cannot flush stale state over a world a
concurrent `start` has just rebuilt.

Shutdown is ordered so that nothing writes into a closing connection:

```text
SIGTERM / SIGINT
      |
      v
refuse commands  (every non-GET answers 503 from here on)
      |
      v
stop accepting new HTTP connections
      |
      v
stop the simulation, flush dirty state
      |
      v
close Socket.IO (disconnect clients)
      |
      v
await the HTTP server close
      |
      v
disconnect Prisma
      |
      v
exit
```

Two things are worth reading carefully here.

**The command gate comes first.** `httpServer.close()` refuses new *connections*,
and `closeIdleConnections()` kills only those idle at that instant — neither
stops a client already holding a keep-alive from sending one more request. If
that request were `POST /api/v1/simulation/start`, it would install a fresh
interval after the loop had stopped and flushed, ticking into a Prisma client
about to disconnect. So the socket-level close is the coarse gate, and a
middleware guarding on `isShuttingDown()` is the precise one. Reads stay open —
answering a `GET` on the way down is harmless.

**The listener is closed early but awaited late.** Awaiting it where it is closed
would deadlock: Socket.IO's connections are live upgrades, so the HTTP server
does not finish closing until `closeWebsocket()` has disconnected them.

A `SHUTDOWN_TIMEOUT_MS` force-exit timer backstops the whole sequence, and
`uncaughtException` exits non-zero — a crash that reported success would never be
restarted by its supervisor.

---

## Known limitations

Stated plainly, because a hackathon backend that pretends otherwise is worse
than one that says where the edges are.

- **The yard lock is process-local.** It is complete for the locked
  single-process architecture (§3). A second Node process against the same
  database would need a Postgres exclusion constraint on
  `(dockDoorId, tstzrange(scheduledStart, scheduledEnd)) WHERE status = 'ASSIGNED'`
  instead. That is more migration than this demo needs.
- **The WMS is simulated.** There is no external integration, by design (§15).
- **Delays are deterministic multipliers**, not weather or traffic APIs (§7).
  Every multiplier must be greater than zero — base speed is recovered by
  dividing a stored speed by its multiplier — which is why `ROAD_CLOSURE` is
  0.10 rather than 0. Changing a multiplier constant reinterprets rows already
  in the database.
- **The integration suite writes to the seeded development database** and
  restores it afterwards. There is no separate test database. If a run is
  interrupted, `pnpm db:seed` is the reset.
- **No authentication.** Not requested, and deliberately not added (§27).
- **The docking queue scores every queued truck against every door on each
  request** (§8) — `recommendDocks` reloads the yard per truck, run
  concurrently but still O(trucks × docks) queries. Fine at the seeded scale
  (12 trucks, 8 doors); a larger yard would want to hoist the dock load out of
  the per-truck call.
- **`typescript-eslint` does not support TypeScript 7** (upstream issue #10940),
  and this project is on `typescript@7.0.2`, so there is no linter configured.
  The strict compiler settings — `noUnusedLocals`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` — plus three separate typecheck configs are the
  quality gate instead.
