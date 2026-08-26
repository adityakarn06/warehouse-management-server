# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 0. Working In This Repo

## Commands

```bash
pnpm install                 # pnpm is the package manager (see packageManager field)
pnpm dev                     # tsx watch src/server.ts — HTTP + Socket.IO on :4000
pnpm build                   # prisma generate && tsc
pnpm start                   # node dist/server.js
pnpm typecheck               # tsc --noEmit — run this after every change
pnpm typecheck:seed          # tsc -p tsconfig.seed.json — covers prisma/seed.ts
pnpm typecheck:test          # tsc -p tsconfig.test.json — covers tests/
pnpm test                    # vitest run — integration tests against the seeded db
pnpm test:watch              # vitest
pnpm vitest run -t "yard"    # single test / suite by name
pnpm realtime:demo           # two Socket.IO clients against a running server
pnpm prisma:migrate          # prisma migrate dev
pnpm prisma:generate         # regenerates the client into src/generated/prisma

pnpm db:up                   # docker compose up -d  (postgres:17 as e2-postgres)
pnpm db:down                 # docker compose down
pnpm db:seed                 # runs prisma/seed.ts via tsx (idempotent — wipes, then reseeds)
pnpm db:reset                # DROPS the db, remigrates, reseeds (Prisma 7's `migrate reset`
                             # no longer runs the seed itself, so the script chains `db seed`)
pnpm db:studio               # prisma studio
```

`pnpm typecheck` covers `src/` only — the root tsconfig excludes `prisma/seed.ts`
because its `rootDir` is `./src`. Run `pnpm typecheck:seed` after touching the
seed.

Tests are Vitest in `tests/`, split by what they touch:

- `read-api.test.ts` — supertest against `createApp()` in-process (no port bound),
  running **against the seeded development database**, strictly read-only. It
  asserts exact seeded values, so `pnpm db:seed` must have run first.
- `simulation.test.ts` — pure engine tests. No database, no real timers: the
  `SimulationManager` takes its store, event sink and clock by injection, so the
  tests drive `manager.tick()` by hand against in-memory fakes.
- `docking.test.ts` — the dock scoring engine. Pure: no database, no clock, no
  Socket.IO — hand-built docks straight into `scoreDocks`.
- `docking-api.test.ts` — the Phase 7 write endpoints via supertest. This one
  **writes to the seeded database** and restores what it touched in `afterEach`
  through `restoreYard()`. Emissions are captured with a recording
  `DockingEventSink`.
- `dock-failure.test.ts` — the Phase 8 cascade, also through supertest against the
  seeded database: Scenario D (D2 → D4), Scenario E (no reefer door left),
  double-booking refusal, and recovery/release. Shares the snapshot/restore
  helpers in `tests/docking-fixtures.ts` (not a `.test.ts` file, so Vitest does
  not collect it).
- `wms.test.ts` — the Phase 9 ingestion API via supertest. **Writes to the seeded
  database** and restores it: it snapshots the yard *and* the fleet (trucks,
  shipments, appointments, location history) and puts both back in `afterEach`.
  It swaps **both** realtime seams onto one recorder, because the services it
  delegates to emit through the docking sink, not the WMS one.
- `realtime.test.ts` — the Socket.IO layer, also database-free: room routing
  against a recording `RealtimeEmitter`, the simulation→sink seam driving the real
  engine with a fake store, and an end-to-end test with two real `socket.io-client`
  connections against a server on an ephemeral port.
- `integration.test.ts` — the Phase 10 end-to-end suite, and the only one that
  cuts **no** seam: the seeded database, a real `createApp()`, a real Socket.IO
  server on an ephemeral port and real `socket.io-client` connections, all at
  once. It sets up by hand the two things `server.ts` normally does
  (`initWebsocket` and `simulationManager.setSink(realtimeSimulationSink())`),
  leaves the docking and WMS sinks at their realtime defaults on purpose, drives
  `manager.tick()` rather than waiting on timers, and restores **both** the yard
  and the fleet — plus `simulationManager.reset()`, because the live store is the
  other half of the world and survives a `stop()`.

**Re-seed before `pnpm test` if `pnpm dev` has been running.** Autostart moves the
same rows `read-api.test.ts` asserts on, so a long dev session will eventually
break its `activeTrucks` / `delayedTrucks` counts. `NODE_ENV=test` force-disables
autostart, so the suite itself never starts a loop.

`tests/` sits outside the root `rootDir`, hence the separate `tsconfig.test.json`.

Environment: copy `.env.example` to `.env`. `DATABASE_URL` is the only
required variable; everything else has a default (`ARRIVAL_HORIZON_MINUTES`,
default 120, controls the yard overview's upcoming-arrivals window). `src/config/env.ts` parses
`process.env` through Zod once and `process.exit(1)`s on invalid config — read
config via `import { env } from './config/index.js'`, never `process.env`
(the one exception is `prisma/seed.ts`, which runs outside the app).

## Current state

**Phases 1–10 are done. The backend is feature-complete.**

Phase 1 (foundation): config, logger, Prisma client, error handling,
`/health` + `/api/v1/health` + `/api/v1/health/db`, bare Socket.IO server.

Phase 2 (persistence): `prisma/schema.prisma` defines all eight domain models
(Route, Truck, Shipment, Appointment, DockDoor, DockAssignment, Alert,
LocationHistory) plus the enums in §17, migrated as
`prisma/migrations/*_init_domain_model`. `prisma/seed.ts` writes a deterministic
demo warehouse: 3 routes, 8 dock doors, 12 trucks, 12 shipments,
12 appointments, 6 dock assignments, 7 alerts, 11 location snapshots.

Seeded rows use their human reference as the primary key — `Truck.id` is
`"TRK-101"`, `DockDoor.id` is `"D3"`, `Shipment.id` is `"SHP-1001"`,
`Route.id` is `"RTE-DEL-KOL-01"` — so `/api/v1/trucks/TRK-101` works by id.
Rows created at runtime still get a `cuid()`. The `reference` / `code` /
`trackingNumber` unique columns remain for lookup-by-reference routes.

All seed timestamps are fixed offsets from one `BASE` = the top of the current
hour, so the demo is byte-identical in shape on every run but always sits around
"now". The seed deliberately sets up the §25 demo scenarios: TRK-101 → D2 with
D4 as the compatible replacement (Scenario D), and SHP-1009 oversized with the
only oversized door D6 occupied (Scenario E).

Phase 3 (read APIs): every `GET` in §16 except the simulation/WMS ones, wired
onto `apiV1Router`:

```text
/api/v1/shipments              ?status &priority &loadType &limit &offset
/api/v1/shipments/:id
/api/v1/shipments/reference/:reference
/api/v1/tracking/:trackingNumber
/api/v1/trucks                 ?status &routeId &activeDelay &limit &offset
/api/v1/trucks/:id
/api/v1/routes/:id
/api/v1/docks                  ?status &zone &loadType &limit &offset
/api/v1/docks/:id
/api/v1/dock-assignments       ?status &truckId &dockDoorId &shipmentId &limit &offset
/api/v1/alerts                 ?type &severity &acknowledged &truckId &shipmentId &dockDoorId
/api/v1/yard/overview
```

Phase 7 adds the docking write surface listed further down.

Phase 4 (simulation engine): the backend now owns truck movement.
`src/simulation/simulation-manager.ts` runs **one** interval every
`SIMULATION_TICK_MS` (2000), advancing every truck whose status is
`IN_TRANSIT`/`DELAYED`/`ARRIVING` (9 of the 12 seeded trucks) along its fixed
route, and driving `IN_TRANSIT → ARRIVING → ARRIVED`. Supporting files:

```text
src/simulation/route-engine.ts       geometry math, memoised RouteProfile per route
src/simulation/live-state.ts         LiveTruckState + the in-memory LiveStateStore
src/simulation/truck-simulator.ts    advanceTruck() — the pure per-truck tick
src/simulation/simulation-store.ts   the Prisma seam (loadTrucks / persist)
src/simulation/simulation-events.ts  SimulationEventSink + payload types
src/simulation/simulation-manager.ts the loop, persistence policy, event emission
src/eta/eta-engine.ts                calculateEta / distanceTravelledKm (pure)
```

Control endpoints: `POST /api/v1/simulation/start|stop|reset`,
`GET /api/v1/simulation/state`, `GET /api/v1/simulation/trucks/:truckId`.
The loop starts in `server.ts` (never `createApp()`) when `env.simulationAutostart`
is set. New env vars: `SIMULATION_TICK_MS`, `SIMULATION_AUTOSTART`,
`SIMULATION_SPEED_MULTIPLIER`, `SIMULATION_ARRIVING_PROGRESS`,
`SIMULATION_CHECKPOINT_PROGRESS_STEP`.

Phase 5 (Socket.IO realtime): the engine's events now reach the browser.

```text
src/websocket/events.ts           the typed contract — all 7 events + payloads
src/websocket/rooms.ts            operations / truck:{id} / shipment:{id}, and roomsFor()
src/websocket/realtime-service.ts RealtimeService — the only Socket.IO caller
src/websocket/socket-server.ts    connection logging + the subscribe protocol
src/websocket/snapshots.ts        SnapshotProvider — the state a subscriber joins with
src/websocket/index.ts            barrel: initWebsocket / getIO / getRealtimeService / closeWebsocket
src/schemas/realtime.ts           Zod for the subscribe payloads
scripts/realtime-client.ts        `pnpm realtime:demo` — two-client verification script
```

Clients subscribe explicitly (`subscribe:operations`, `subscribe:truck`,
`subscribe:shipment`) and get their opening state in the Socket.IO **ack**;
nothing is broadcast to a socket that did not ask. Events go out **by name**
(`socket.on('TRUCK_POSITION_UPDATED', ...)`), not in a `{ type, data }` envelope.
`DOCK_STATUS_CHANGED` and `DOCK_ASSIGNED` went live in Phase 7, `DOCK_REASSIGNED`
in Phase 8, and `ALERT_CREATED` in Phase 6 — every event in the contract now has
a writer.

Full reference with example payloads: `docs/api.md`, and
`docs/realtime.md` for the Socket.IO contract.

Phase 6 (ETA + delay scenarios): the operator can now slow a truck down.

```text
src/simulation/delay-scenarios.ts  the multiplier table, severities and labels
```

`POST /api/v1/simulation/trucks/:truckId/delay` (body `{ "type": "RAIN" }`) and
`POST .../clear-delay`. The frontend sends a scenario name and nothing else;
`SimulationManager.applyDelay` / `clearDelay` own every consequence — effective
speed, recalculated ETA, `DELAYED` status, one persisted `TRUCK_DELAYED` alert,
and `TRUCK_ETA_UPDATED` + `TRUCK_STATUS_CHANGED` + `ALERT_CREATED`. Both return
the authoritative resulting state. New env vars: `DELAY_MULTIPLIER_RAIN` (0.65),
`DELAY_MULTIPLIER_TRAFFIC` (0.45), `DELAY_MULTIPLIER_ROAD_CLOSURE` (0.10).
`createAlert` in `src/services/alert-service.ts` is the project's first alert
writer, and Phase 8's dock alerts reuse it unchanged.

Phase 7 (dock availability + assignment engine): the warehouse side is now
interactive.

```text
src/docking/dock-scoring.ts            the pure, deterministic scoring algorithm
src/docking/dock-assignment-service.ts recommendDocks / assignDock / releaseDock
src/docking/docking-events.ts          the DockingEventSink seam + payload builders
src/schemas/docking.ts                 Zod for the two command bodies
```

```text
PATCH /api/v1/docks/:dockId/status               { "status": "AVAILABLE" | "UNAVAILABLE", "reason"? }
POST  /api/v1/docks/:dockId/release              (Phase 8)
GET   /api/v1/trucks/:truckId/dock-recommendations
POST  /api/v1/trucks/:truckId/dock-assignment    { "dockId"? }
```

`scoreDocks` runs four hard filters (out of service, incompatible load type,
booked across the slot, frees up only after the slot ends) and then five weighted
components summing to 100 — `loadTypeFit` 25, `availabilityFit` 30,
`appointmentFit` 25, `priorityFit` 15, `statusBonus` 5 — each contributing a
human sentence to `reasons`. `DOCK_ASSIGNED` and `DOCK_STATUS_CHANGED` went live. New env var:
`DOCK_DEFAULT_DURATION_MINUTES` (45). Tests: `tests/docking.test.ts` (pure) and
`tests/docking-api.test.ts` (supertest, self-restoring).

Phase 8 (dock failure + automatic reassignment): taking a door down now moves the
trucks standing on it.

```text
src/docking/dock-failure-service.ts  handleDockFailure — the cascade + its alerts
tests/docking-fixtures.ts            shared RecordingSink + yard snapshot/restore
```

`PATCH /docks/:dockId/status` with `UNAVAILABLE` still emits `DOCK_STATUS_CHANGED`
and one `DOCK_UNAVAILABLE` alert, and then runs the cascade: each affected truck
is re-scored against every remaining door by `reassignDock()` in
`src/docking/dock-assignment-service.ts` and either moved (`REASSIGNED` old row →
new `ASSIGNED` row chained by `previousAssignmentId`, one `DOCK_REASSIGNMENT`
alert, `DOCK_REASSIGNED`) or reported as `NO_DOCK_AVAILABLE`. `POST
/api/v1/docks/:dockId/release` finally routes the `releaseDock()` that Phase 7
left unexposed. New response field: `reassignments` on the PATCH body. No new env
vars.

Phase 9 (simulated WMS integration): the backend now takes facts from outside.

```text
src/schemas/wms.ts             the six inbound events, as a discriminated union
src/wms/wms-event-handler.ts   handleWmsEvent — mapping, writes, alerts, emission
src/wms/wms-realtime.ts        the WmsRealtimeSink seam + parked-truck payload builders
src/wms/wms-scenarios.ts       runWmsScenario — the deterministic demo scripts
```

```text
POST /api/v1/wms/events        one typed event, discriminated on `eventType`
POST /api/v1/wms/simulate      { "scenario"? } — replays a fixed sequence
```

Six event types: `TRAILER_LOCATION_UPDATED`, `TRAILER_STATUS_UPDATED`,
`TRAILER_ARRIVED`, `TRAILER_DOCKED`, `DOCK_STATUS_UPDATED`,
`APPOINTMENT_UPDATED`. No migration and **no new realtime events** — ingestion
reuses the seven in §13 and the enum members Phases 1-8 left unowned
(`TruckStatus.DOCKED`, `ShipmentStatus.DOCKED`, `DockStatus.OCCUPIED`,
`LocationSnapshotReason.DOCKED`/`COMPLETED`). `SimulationManager` gained
`applyExternalUpdate()` and `nextSequence()`. New tests: `tests/wms.test.ts`
(supertest, self-restoring) and an `external updates` suite in
`tests/simulation.test.ts`. No new env vars.

Phase 10 (integration hardening, tests, docs): no new features — the phase was
about making the system stable and consumable by a frontend.

```text
src/docking/dock-lock.ts     the yard-wide async mutex
src/lib/shutdown-state.ts    beginShutdown()/isShuttingDown() — the command gate
tests/integration.test.ts    the end-to-end suite (real DB + HTTP + Socket.IO)
docs/architecture.md         the layer diagram and the decisions behind it
```

Six audit fixes, all narrow:

1. `uncaughtException` exited **0**, telling a supervisor a crash was a clean
   exit. `shutdown()` now takes an exit code.
2. Shutdown stopped the simulation *before* closing the HTTP listener, so a
   `POST /simulation/start` arriving in that window installed a fresh interval
   that then ticked into a disconnecting Prisma client. The listener now closes
   first — but is **awaited last**, because Socket.IO's live upgrades keep
   `close()` from resolving until `closeWebsocket()` has disconnected them.
3. `applyExternalUpdate` could claim the `inFlight` barrier the instant
   `runStop` released it, persisting after the flush. `runStop` now **holds the
   barrier across its own flush** rather than releasing it first, and flushes
   unconditionally, so a stopped-but-dirty world is still written.
4. `runTick` wrapped the whole fleet loop in one try/catch, so one bad truck
   silenced the rest for that tick. The catch is per truck now, and
   `lastTickAt` is stamped before anything can throw.
5. Two concurrent `assignDock` calls for the same door both passed
   `dockStillTakes` under READ COMMITTED and both committed — see the yard lock
   below. `releaseDock` also judged `UNAVAILABLE` off a read taken *outside* its
   transaction; it re-reads the door inside now.
6. `patchDockStatus` / `postDockRelease` let each service call `new Date()`
   separately, stamping one operator action milliseconds apart.

`GET /api/v1/simulation/state` and the three lifecycle endpoints now also carry
`lastTickAt` and `lastTickError`. Docs moved from `api-docs/` to `docs/`.

**No linter is configured.** `typescript-eslint` hard-refuses TypeScript 7
(upstream issue #10940) and this project is on `typescript@7.0.2`; pinning TS 6
for ESLint alone does not work, because the peer resolves to the root's TS 7.
The strict tsconfig plus the three typecheck configs are the gate instead. The
one pass that did run under a temporary TS 6 found two real issues, both fixed:
a floating promise in `closeWebsocket` (`server.close()` returns a promise *and*
takes a callback — it is awaited directly now, which surfaces a close error the
callback form dropped) and the `console.error` in `env.ts`, which turned out to
be necessary since `logger` reads its level from that very module.

Still empty placeholder directory: `src/alerts` (alert logic lives in
`src/services/alert-service.ts`).
Sections 15, 24 and 27–31 below describe the target system, not the code on disk.

## Conventions that are easy to get wrong

- **ESM with `verbatimModuleSyntax`.** `"type": "module"` + `module: nodenext`,
  so every relative import needs an explicit `.js` extension (`./app.js`, even
  from `app.ts`), and type-only imports must use `import type`.
- **Prisma 7 with a driver adapter.** The datasource URL lives in
  `prisma.config.ts` (for the CLI), and the runtime client connects through
  `PrismaPg` in `src/lib/prisma.ts`. The generated client is emitted to
  `src/generated/prisma` (gitignored) and imported from there — not from
  `@prisma/client`. Run `pnpm prisma:generate` after any schema change.
- **Strict tsconfig.** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`/`Parameters` are all on. Notably, an optional property must be
  omitted rather than set to `undefined` (see the `details` handling in
  `src/lib/http-error.ts`).
- **Success envelope.** Every 2xx body is `{ data }`, and list endpoints add
  `{ meta: { total, limit, offset } }`. Build it through `sendData` / `sendList`
  in `src/lib/api-response.ts` rather than calling `res.json` directly. The
  health endpoints predate this and stay unenveloped on purpose.
- **Validation.** Query and route params go through Zod schemas in
  `src/schemas/`, applied with `parseQuery` / `parseParams` from
  `src/lib/validate.ts`, which turns a `ZodError` into a 400 carrying
  `error.details`. Note `z.coerce.boolean()` is a trap (any non-empty string is
  `true`) — use the `booleanQuery` schema in `src/schemas/common.ts`.
- **Prisma selects.** Shared `select` fragments live in `src/services/selects.ts`
  as `as const` objects. Filter arrays (`{ in: [...] }`) must **not** be inside
  an `as const` literal — Prisma rejects `readonly` arrays, which is why
  `activeAssignmentWhere` is declared separately.
- **`Route.geometry` is returned by `GET /api/v1/routes/:id` only.** No other
  endpoint may select it (§24).
- **Detail lookups accept id or natural key.** Seeded rows use their human
  reference as the primary key but runtime rows get a `cuid()`, so
  `getTruckById` and friends try `id`, then `reference`/`code`, then 404.
- **Optional filters + `exactOptionalPropertyTypes`.** Zod `.optional()` yields
  `T | undefined`, so filter interfaces must declare `status?: T | undefined`,
  and `where` objects are built through `compact()` in `src/lib/object.ts`,
  which strips undefined keys.
- **Errors.** Throw `HttpError.badRequest/notFound/internal` from
  `src/lib/http-error.ts`; the central `errorHandler` renders
  `{ error: { message, status, details? } }` and hides messages in production.
  Note this differs from the `{ error: { code, message } }` shape sketched in
  §21 — keep the implemented shape unless deliberately changing it.
- **HTTP layering.** There is no `src/api/` directory — it is split three ways:
  `src/routes/` (path → handler wiring only), `src/controllers/` (request
  handlers), `src/middleware/` (cross-cutting). A route file should contain
  `router.get(path, controllerFn)` lines and nothing else; put the logic in a
  controller, and anything non-trivial in a service under `src/services/`.
- **Wiring.** `createApp()` in `src/app.ts` builds the Express app (with
  `requestLogger` from `src/middleware/request-logger.ts` in front of the
  routers); `src/server.ts`
  owns the HTTP server, Socket.IO init, and graceful shutdown. New domain routers
  mount on `apiV1Router` in `src/routes/index.ts`. Note `/health` is registered
  twice on purpose — top-level in `app.ts` and under `/api/v1` via the router —
  both delegating to the same `getHealth` controller. `io.close()` also closes the
  shared HTTP server, which is why `shutdown()` tolerates `ERR_SERVER_NOT_RUNNING`.
- **Logging** goes through `src/lib/logger.ts` (level-filtered console wrapper),
  not bare `console.*`. Per-tick simulation chatter is `debug`, never `info`.
- **Simulation state is in memory; Postgres is not a tick log.** `LiveTruckState`
  is the source of truth between writes. A row is written only on a status
  transition, once every `SIMULATION_CHECKPOINT_PROGRESS_STEP` percent of
  progress, and on `stop()` (which flushes). `sequenceNumber`, `previous*` and
  `lastPersistedProgress` never reach the database at all.
- **`advanceTruck` is pure and elapsed-time based.** It takes `elapsedMs` and
  returns a fresh state — it never mutates its input, reads a clock, or steps a
  coordinate index. Route geometry is read-only and its `RouteProfile` is
  memoised per route, so it is parsed and measured once, not per tick.
- **The engine never imports Socket.IO.** It emits domain events into a
  `SimulationEventSink` (§14); `server.ts` attaches the Socket.IO-backed sink with
  `simulationManager.setSink(realtimeSimulationSink())` after `initWebsocket()` —
  a sink that resolves the current service per event, so a close/re-init cannot
  leave the engine emitting into a torn-down server. `RealtimeService` is the
  **only** module that may call Socket.IO — domain code emits a `RealtimeEvent`
  and lets it choose the rooms.
- **Realtime events are emitted by name**, one Socket.IO event per type, with the
  payload as the single argument. The `{ type, data }` form exists only inside the
  process as `RealtimeEvent`, the tagged union `RealtimeService.emit()` routes on.
  Adding an event means a member in `src/websocket/events.ts`, a case in
  `roomsFor()`, and a row in `docs/realtime.md` — nothing else.
- **Nothing crosses the wire as a `Date`.** Socket.IO JSON-serialises acks, so
  snapshots are wire-shaped: `LiveTruckWireView` = `Wire<LiveTruckView>` and
  `snapshots.ts` stringifies the timestamps itself rather than letting the
  serialiser do it behind a type that still says `Date`.
- **`sequenceNumber` survives a reset.** Clients drop updates below their
  high-water mark, so `SimulationManager` keeps a per-truck counter across
  `live.clear()` and hands it back to `toLiveState` on reload.
- **Socket handlers answer through the ack, never by throwing.** An exception in a
  socket handler takes the connection (or the process) down instead of returning a
  400, so `subscribe:*` validates with `safeParse` and replies
  `{ ok: false, error }`. The ack is also optional on the wire — check it is a
  function before calling it.
- **Effective speed is base speed x the delay multiplier, and there is no base
  speed column.** `LiveTruckState.speedKmph` is the *effective* speed everywhere —
  in `advanceTruck`, in `persist`, in every payload. `baseSpeedKmph` is derived
  once at load time by dividing the persisted speed by the multiplier for the
  persisted `activeDelay`, which is exactly how the seed is built (the RAIN truck
  is 39 = 60 x 0.65, the TRAFFIC truck 27 = 60 x 0.45). Two consequences: every
  multiplier must be **greater than zero** (hence ROAD_CLOSURE is 0.10, not 0 —
  and a zero-speed truck would also stop emitting, since `advanceTruck` treats
  "covered no ground" as nothing to report), and changing a multiplier constant
  reinterprets already-persisted rows.
- **A delayed truck is never promoted to `ARRIVING`.** The status ladder in
  `advanceTruck` skips the promotion while `activeDelay !== 'NORMAL'`, so the
  operator's scenario is not silently overwritten at 95%. `clearDelay` recomputes
  the status from progress instead. `ARRIVED` still wins at 100%.
- **Delay commands await the in-flight tick, then mutate synchronously.** A tick
  reads a truck, awaits its write, then writes the result back into the live map,
  so mutating underneath one would be undone. `changeDelay` awaits `inFlight`
  first and does everything up to `live.set()` without an `await`, which closes
  the window without a second lock. It also bumps `sequenceNumber` past the
  high-water mark so clients do not drop the update.
- **A delay is a business event; a position is not.** One button press writes one
  `Truck` update, one `LocationHistory` row (`DELAY_ACTIVATED`/`DELAY_CLEARED`)
  and one `Alert`. Pressing the same button twice is a no-op success, and a failed
  alert write is logged but never fails the command — the truck is authoritatively
  delayed either way.
- **The engine still never emits Socket.IO itself.** `createAlert` in
  `alert-service.ts` only writes; the manager emits `ALERT_CREATED` through its
  `SimulationEventSink` like every other event (§14).
- **Express 5 leaves `req.body` undefined when a request carries no body.** Not
  `{}` — undefined, which makes `z.object({...}).parse()` throw a 400. A command
  body whose fields are all optional must therefore end in `.default({})`, as
  `assignDockCommandSchema` does, or `curl -X POST <url>` fails instead of taking
  the default path.
- **`src/docking` is the write side; `src/services` is the read side.** There are
  two files called `dock-assignment-service.ts` on purpose:
  `src/services/dock-assignment-service.ts` only lists rows for
  `GET /api/v1/dock-assignments`, while `src/docking/dock-assignment-service.ts`
  owns every consequence of a recommendation being taken — including
  `reassignDock()`. The orchestration above it (`dock-failure-service.ts`) owns
  the alerts and the per-truck loop and never writes an assignment row itself:
  `DockFailureService → DockAssignmentService → AlertService → RealtimeService`.
- **`dock-scoring.ts` is pure and env-free.** No Prisma, no clock, no
  `process.env`: it takes plain data and returns a ranking, which is what lets
  `tests/docking.test.ts` run without a database. The weights are algorithm
  constants exported from the module, not env vars — unlike the delay
  multipliers, they are not demo knobs. Reasons deliberately avoid absolute clock
  times ("frees up 30 min after the truck is due", never "free at 18:40"): the
  backend has no idea what timezone the operator reads, and relative phrasing
  keeps the assertions honest.
- **A door the truck already holds is not blocked for that truck.** Its own
  reservation sets `DockDoor.availableFrom`, which would otherwise exclude the
  dock from its own truck's recommendations, so `toScoringDock` nulls
  `availableFrom` and drops the booked window when the holder is this truck.
- **`RESERVED` is the assignment engine's; `OCCUPIED` is the WMS's.** Committing
  a dock flips `AVAILABLE → RESERVED` with `availableFrom = scheduledEnd`. Only
  Phase 9's WMS feed may say a truck has physically backed in. `PATCH
  /docks/:id/status` therefore accepts only `AVAILABLE` and `UNAVAILABLE` —
  letting an operator hand-set the other two would let the board lie.
- **Manual re-pick is `CANCELLED`; `REASSIGNED` belongs to Phase 8.** Moving a
  truck by hand cancels the old row and frees its door. The
  `REASSIGNED` + `previousAssignmentId` chain (seeded as DA-3005 → DA-3006) is
  reserved for the dock-failure path, so the timeline stays readable.
- **Putting a door back in service can yield `RESERVED`, not `AVAILABLE`.** If a
  booking survived the outage, that is the honest state — the response and the
  `DOCK_STATUS_CHANGED` payload both carry the *resulting* status, not the
  requested one.
- **The docking sink defaults to the realtime one, so `server.ts` is untouched.**
  `realtimeDockingSink` resolves through `tryGetRealtimeService()`, which returns
  `null` instead of throwing — which is exactly why the docking endpoints work
  under the supertest suites, where `createApp()` runs with no websocket. Tests
  swap it with `setDockingSink()` and restore with `resetDockingSink()`.
- **`tests/docking-api.test.ts` writes to the seeded database and restores it.**
  `read-api.test.ts` asserts exact seeded values, so the docking suite snapshots
  every dock door in `beforeAll` and, in `afterEach`, deletes any non-seeded
  assignment/alert row and puts the doors back. `pnpm db:seed` is still the reset
  of last resort if a run is interrupted.
- **The failed door is excluded by the ordinary hard filter, not a special case.**
  `handleDockFailure` runs *after* `setDockStatus` has already written
  `UNAVAILABLE`, so `scoreDocks` drops the dock a truck is fleeing without
  `reassignDock` knowing anything about it. Order matters: run the cascade before
  the status write and the engine would cheerfully recommend the broken door back.
- **`REASSIGNED` is the failure path's; `CANCELLED` is everyone else's.**
  `reassignDock()` is the only writer of the `REASSIGNED` + `previousAssignmentId`
  chain (seeded as DA-3005 → DA-3006), so the timeline distinguishes "operations
  moved this truck" from "the yard forced it to move". `REASSIGNED` keeps
  `releasedAt` null and stamps `reassignedAt` — it is a supersession, not a
  release. `previousAssignmentId` is `@unique`, so a second failure chains
  forward from the newest row rather than re-pointing the old one.
- **No dock available means the truck is left unassigned, not parked on a corpse.**
  The stranded row is `CANCELLED` and a `CRITICAL` `NO_DOCK_AVAILABLE` alert
  carries the scorer's own exclusion sentences in `metadata.excluded`. One
  consequence: no door ever carries a booking through an outage via the API any
  more, so `setDockStatus`'s "came back `RESERVED`" branch is now only reachable
  from state the WMS feed writes — it stays because it is still honest.
- **One transaction per truck, not one per outage.** A door can hold several
  bookings; they are resolved earliest-slot-first so the demo is deterministic,
  and one truck's move failing must not roll back another's. The per-truck
  transaction still covers superseding, creating and reserving together (§18).
- **Scoring excludes a clashing door; `dockStillTakes` re-asks inside the
  transaction.** Scoring reads before the write, so two simultaneous commits
  would both see a free door, and a door can go out of service in between. The
  recheck re-reads the door's *live* row and both write paths reserve against
  the status it returns — flipping a since-broken door to `RESERVED` would clear
  the fault from the board while leaving `unavailableReason` behind. It also
  counts a committed booking with **no** scheduled window as a clash, because
  Prisma comparisons never match NULL and the naive overlap test would wave one
  through. `assignDock` turns a refusal into a 409; `reassignDock` walks to the
  next recommendation. Postgres runs READ COMMITTED, so this narrows the race
  rather than closing it — the complete fix is an exclusion constraint, which is
  more migration than this demo needs.
- **A truck the cascade could not move is reported, never dropped.** If
  `reassignDock` throws, the truck is still `ASSIGNED` to a dead door, so
  `handleDockFailure` raises a `CRITICAL` alert and pushes a
  `REASSIGNMENT_FAILED` outcome rather than logging and moving on. An absent
  entry in `reassignments` would be indistinguishable from a truck that was
  never affected — which is the exact silent stranding the cascade exists to
  prevent.
- **The `DOCK_UNAVAILABLE` alert promises nothing about what happens next.** It
  is written before the cascade runs, so wording it as "is being reassigned"
  would be a lie on the no-dock path. It names what *was* assigned; the alert
  that follows says where each truck ended up. Its trucks are ordered
  earliest-slot-first, matching the order the cascade resolves them in.
- **The docking suites snapshot whole rows now, not just ids.** Phase 8 rewrites
  seeded assignments to `REASSIGNED`/`CANCELLED` and `DA-3005` is *seeded* as
  `REASSIGNED`, so the old "reset everything to `ASSIGNED`" cleanup would corrupt
  the very row the demo reads. `tests/docking-fixtures.ts` snapshots and restores
  each row field by field, and both DB-writing suites share it.
- **ETA holds steady under constant speed — that is correct.** `calculateEta`
  returns an absolute wall-clock instant, so what counts down is the time
  remaining, not the timestamp. An arrival time that drifts while the truck keeps
  to its speed would mean the engine was guessing.

- **The WMS is a source, not a contract.** Phase 9 added no realtime events, no
  alert types and no migration. Ingestion reuses the seven events in §13 and the
  enum members earlier phases left unowned, so a frontend written against Phase 8
  sees WMS-driven updates with no change. Adding an eighth event to broadcast an
  appointment change would have cost a member, a room rule, a doc row and a
  frontend release for a fact the frontend can re-read — its real effect is that
  a moved window re-ranks dock recommendations through `appointmentFit`.
- **`trailerId` is the third lookup arm.** `Truck.trailerId` (`TRL-101`) was
  already `@unique` and seeded, so the WMS correlation key needed no schema
  change. `findTruckByAnyKey` tries `id`, then `reference`, then `trailerId` —
  the project's id-then-natural-key convention with one more fallback.
- **`applyExternalUpdate` takes the `inFlight` barrier, and returns `null`
  instead of throwing.** It copies `changeDelay`'s barrier for the same reason:
  a tick firing mid-command advances the truck and then persists the
  pre-command snapshot back over it, regressing `sequenceNumber` below the mark
  clients drop updates against. It differs in one way that matters — a truck the
  engine is not simulating (a stopped loop, or one parked in the yard, which
  `load()` never selects) is not an error, because a WMS fact is true either
  way. The handler writes Prisma directly on that branch and builds its own
  payloads; a parked truck's interpolation target is its own position, which is
  the honest answer rather than a degraded one.
- **The WMS layer never emits truck events for a simulated truck.** The manager
  does, through its own sink, so the single event path stays single (§14).
- **`DELAYED`, `DOCKED` and `RESERVED` are refused at the schema.** Each belongs
  to an endpoint that sets more than the one field: `DELAYED` to the delay
  scenarios (which also set `activeDelay`), `DOCKED` to `TRAILER_DOCKED` (which
  checks the assignment and flips the door in the same transaction), `RESERVED`
  to the assignment engine. `OCCUPIED` is the one status only the feed may
  write. The rule generalises: if a status has a co-ordinated write somewhere
  else, the feed does not get to set it directly.
- **The feed cannot put a delayed truck back on the road, but it can land one.**
  Reporting `IN_TRANSIT`/`ARRIVING` for a truck whose `activeDelay` is not
  `NORMAL` is a 409 pointing at `clear-delay` — otherwise the scenario and its
  reduced speed would stand next to a normal-looking status, the mirror image of
  the state the schema refuses. Arriving is exempt and clears the scenario
  itself: the journey is over, so the delay is too.
- **Status ladders only run forwards here.** `TRAILER_ARRIVED` for a trailer
  already `ARRIVED`/`DOCKED`/`COMPLETED` is a no-op. A feed that retries or
  delivers late must not restamp `arrivedAt`, pull a shipment back from
  `DOCKED`, or reverse a truck standing at an `OCCUPIED` door.
- **The handler mirrors the shipment on both branches.** The engine's `persist`
  maps only the reasons *it* writes (`ARRIVING`/`ARRIVED`), so leaving the
  mirror to it would move a shipment or not depending on whether the loop
  happened to be running — one event, two answers.
- **`applyExternalUpdate` reports what it emitted; callers never re-derive it.**
  Only the engine knows what its comparison against *live* state raised, and a
  caller reconstructing that from a database row would be wrong in both
  directions (the row lags between checkpoints) and would miss
  `TRUCK_ETA_UPDATED` entirely. `onTrailerDocked` uses the returned list to
  decide whether it still needs to emit — emitting anyway would send
  subscribers the same status change twice under two sequence numbers.
- **A positional resync needs `progress`.** The engine recomputes a moving
  truck's position from `progress` each tick, so a `TRAILER_LOCATION_UPDATED`
  carrying only lat/lng is corrected away on the next one. That is honest
  behaviour, not a bug — but the docs say to send `progress` too, and
  `applyExternalUpdate` resets `lastTickAt` so the gap since the last tick is
  not billed against the corrected position.
- **"Make available" does not free an occupied door — `releaseDock` does.**
  `setDockStatus`'s `AVAILABLE` branch is the operator's put-back-in-service
  button and no-ops on any door that is not `UNAVAILABLE`, so routing the WMS
  through it would have let the feed occupy a bay and never release it. A
  trailer leaving is a departure, which is exactly `releaseDock`: it completes
  whatever assignment was holding the door. Everything else still delegates to
  `setDockStatus` and inherits the whole Phase 8 cascade.
- **`TRAILER_DOCKED` needs a committed assignment and 409s without one.** The
  WMS reports physical reality; it does not create bookings the scoring engine
  never ranked, which keeps `DOCK_ASSIGNED` the only way a truck acquires a door.
  Occupying a door that is out of service is refused for the mirror reason —
  believing the feed there would clear a fault nobody fixed.
- **Re-sending a fact that is already true is a success.** Every handler
  short-circuits to `applied: false` with no second alert. A feed that retries
  must not accumulate errors, and `/wms/simulate` is idempotent because of it.
- **A position is still not a business event.** `TRAILER_LOCATION_UPDATED`
  writes no `LocationHistory` row (§5, §24). It resyncs a live truck rather than
  fighting it: `advanceTruck` is progress- and elapsed-time-based, so the engine
  simply resumes from the reported point — which is why `applyExternalUpdate`
  also resets that truck's `lastTickAt`, or the next tick would bill the whole
  gap against the position the feed just corrected.
- **`/wms/simulate` runs real events through the real handler.** There is no
  second code path, so whatever the demo proves the endpoint does too. It is
  deterministic by name (§25) and captures a failing step instead of aborting —
  a half-finished demo that says which half failed beats one that stops
  silently. `TRAILER_ARRIVAL` moves seeded demo rows, so `pnpm db:seed` resets it.
- **The WMS suite restores trucks as well as the yard.** `restoreYard` only ever
  covered doors, assignments and alerts; the feed also moves trucks, shipments,
  appointments and location history, and `read-api.test.ts` asserts exact seeded
  values. `snapshotFleet`/`restoreFleet` in `tests/docking-fixtures.ts` close
  that gap.

- **One yard lock, not one per door.** `withYardLock` in
  `src/docking/dock-lock.ts` serialises `assignDock`, `reassignDock` and
  `releaseDock` against each other. Per-door keys would be marginally more
  parallel, but `reassignDock` does not know which door it will land on until it
  has walked the ranking *inside* its transaction, so it has no key to take — and
  a mix of yard-wide and per-door keys would not exclude each other. It is **not
  re-entrant**: `handleDockFailure` deliberately stays outside it, because it
  loops over trucks calling `reassignDock` and would deadlock on the first one.
  The guarantee is process-local, which is complete for §3; `docs/architecture.md`
  names the exclusion constraint a second process would need.
- **`runStop` holds the barrier across its own flush.** Draining `inFlight` and
  *then* flushing leaves a gap: a command parked in `applyExternalUpdate`'s own
  `while (this.inFlight !== null)` loop claims the slot the instant the drain
  resolves and persists behind the flush. Assigning the flush promise to
  `inFlight` with nothing awaited in between closes it — the same claim-without-
  awaiting pattern `changeDelay` relies on. It also flushes when the loop was
  never running: a stopped engine can still hold dirty state, and at shutdown
  there is no later checkpoint to retry it.
- **`applyExternalUpdate` is deliberately *not* gated on the loop running.** A
  first pass at the barrier problem refused external updates whenever the engine
  was stopped, which was worse than the bug: `stop()` does not clear `live` and
  `start()` only reloads when the map is empty, so the WMS handler fell through
  to its direct-Prisma branch and left memory saying `IN_TRANSIT` over a row
  saying `ARRIVED` — and the next start resumed from the stale snapshot and
  persisted it back over the arrival. A WMS fact is absorbed whether or not the
  engine is ticking. `tests/integration.test.ts` pins this.
- **The HTTP listener closes first but is awaited last — and that is the coarse
  gate, not the guarantee.** Awaiting it early would deadlock, because
  Socket.IO's connections are live upgrades that `closeIdleConnections()` does
  not touch and `close()` waits on until `closeWebsocket()` disconnects them.
  But `close()` only refuses *new connections*: a client already holding a
  keep-alive can still land a `POST /simulation/start` after the loop has
  stopped and flushed. `beginShutdown()` in `src/lib/shutdown-state.ts` is what
  actually closes that — a middleware in `app.ts` 503s every non-GET once
  shutdown begins. Reads stay open; they cannot restart anything.
- **`httpClosed` is owned from the moment it is created.** It is declared
  outside the `try` and given a `.catch()` immediately, because a throw from
  `stop()` or `closeWebsocket()` jumps to the catch and never awaits it — and a
  rejection from `close()` would then surface as an unowned `unhandledRejection`
  after the process had already logged a different shutdown error.
- **`releaseDock` compares against the status it read *inside* the
  transaction.** Emitting off `findDock`'s earlier snapshot would announce an
  `AVAILABLE -> UNAVAILABLE` transition the release never made, and that
  `setDockStatus` had already broadcast, whenever the door went down in between.
- **`server.close()` in socket.io never rejects.** It hands any error to the
  callback and then resolves unconditionally, so awaiting the promise does not
  observe a close failure. Acceptable on the shutdown path, where
  `httpServer.close()` reports the same failure a moment later — but do not read
  the `await` as error handling.
- **A tick failure is per truck, and visible.** The catch moved inside the fleet
  loop so one unusable truck cannot silence the others, and `lastTickAt` is
  stamped before `advanceTruck` runs so a failure costs events, never distance.
  Because the failure is swallowed, `health()` surfaces `lastTickError` —
  otherwise a wedged engine looks identical to a healthy one from outside. It is
  cleared by the first clean tick: the field means "is it broken now".
- **`tests/integration.test.ts` resets the simulation manager, not just the
  database.** `LiveStateStore` is the source of truth between writes and survives
  a `stop()`, so a truck one test delayed is still `DELAYED` in memory for the
  next one — and `start()` only reloads when the map is empty. `reset()` on a
  stopped engine reloads from the rows `restoreFleet` just put back.
- **The integration suite deliberately leaves the docking and WMS sinks at their
  realtime defaults.** Every other DB suite swaps in a `RecordingSink`; this one
  exists to prove the wiring those swaps replace, so it asserts on what a real
  `socket.io-client` receives instead.

---

# E2 Backend — Project Spec

## Project

We are building **E2: Where's My Truck?**, a real-time warehouse execution and control-tower system for a hackathon.

The system combines:

- Customer-facing shipment/truck tracking
- Warehouse operations dashboard
- Simulated WMS feed
- Real-time truck movement
- ETA calculation
- Dock-door recommendation and assignment
- Delay simulation
- Dock failure and automatic reassignment
- Real-time operational alerts

The backend must feel like a small but believable warehouse execution system, not just a map animation.

---

# 1. Locked Architecture

Use this architecture unless there is a concrete technical reason it cannot work:

```text
Frontend
   |
   +-- REST ----------------------+
   |                              |
   +-- Socket.IO -----------------+
                                  |
                                  v
                         Node.js Backend
                         TypeScript
                         Express
                         Socket.IO
                                  |
              +-------------------+-------------------+
              |                   |                   |
              v                   v                   v
       Simulation Engine      ETA Engine       Dock Assignment
              |                   |                   |
              +-------------------+-------------------+
                                  |
                             Alert Engine
                                  |
                                  v
                            Prisma ORM
                                  |
                                  v
                             PostgreSQL
```

### Required stack

- Node.js
- TypeScript
- Express
- Socket.IO
- Prisma
- PostgreSQL
- Zod or equivalent validation
- Mapbox is a frontend concern

### Explicitly do NOT add

- Redis
- Kafka
- RabbitMQ
- Microservices
- Kubernetes
- Event sourcing
- ML models
- External weather/traffic APIs
- Complex distributed infrastructure

This is a hackathon project. Prefer simple, reliable architecture.

---

# 2. Backend Is the Source of Truth

This is the most important rule.

The backend owns:

- Truck position
- Truck progress
- Truck speed
- Truck ETA
- Truck status
- Active delay scenario
- Dock availability
- Dock assignments
- Dock recommendations
- Reassignments
- Alerts
- WMS state changes

The frontend only:

- Requests actions
- Subscribes to realtime events
- Displays backend state
- Interpolates truck movement visually

Never put operational decision-making logic in the frontend.

For example:

```text
Frontend:
"Make D2 unavailable"

Backend:
D2 -> unavailable
      -> find affected assignments
      -> find replacement dock
      -> reassign if possible
      -> create alert
      -> emit Socket.IO events
```

The frontend must never independently decide that D4 is the replacement.

---

# 3. Single Node.js Process

Express and Socket.IO must run in the same Node.js process.

The simulation engine also runs in the same process.

Conceptually:

```text
Node.js process
|
+-- Express
|
+-- Socket.IO
|
+-- Simulation Manager
|
+-- ETA Engine
|
+-- Dock Assignment Engine
|
+-- Alert Engine
|
+-- WMS Event Handler
|
+-- Prisma
```

Do not split these into services.

---

# 4. Simulation Architecture

## Backend tick frequency

The backend advances truck simulation every **2 seconds**.

Do not move trucks every frame.

Do not make the backend send 30/60 FPS updates.

The backend sends authoritative positions approximately every 2 seconds.

The frontend will interpolate between those positions to make movement visually smooth.

Example:

```text
Backend:

t=0s   -> position A
t=2s   -> position B
t=4s   -> position C
t=6s   -> position D

Frontend:

A --------> B
B --------> C
C --------> D

smooth interpolation
```

## Fixed route, moving truck

The route geometry is fixed.

The truck moves along the route.

Do NOT mutate the route every tick.

The conceptual model is:

```text
Fixed route
    |
    v
Truck progress changes
    |
    v
Current lat/lng changes
    |
    v
ETA recalculated
    |
    v
Socket.IO update
```

---

# 5. Live Simulation State

Active simulation state should primarily live in memory.

Use something conceptually similar to:

```typescript
Map<string, LiveTruckState>
```

A live state can contain:

```typescript
interface LiveTruckState {
  truckId: string;
  routeId: string;

  latitude: number;
  longitude: number;

  previousLatitude?: number;
  previousLongitude?: number;

  progress: number;

  speedKmph: number;

  eta: Date;

  status: TruckStatus;

  activeDelay?: DelayScenario;

  lastUpdatedAt: Date;

  sequenceNumber: number;
}
```

Do not persist every 2-second position update to PostgreSQL.

PostgreSQL is for persistent business state.

Persist meaningful events/state transitions such as:

- delay activation
- delay cleared
- arrival
- docking
- completion
- dock assignment
- dock reassignment
- alerts
- meaningful location history snapshots

---

# 6. ETA Engine

ETA must be calculated by the backend.

Do not hardcode a countdown.

ETA should be based on:

```text
remaining route distance/progress
+
effective speed
+
active delay scenario
```

Normal example:

```text
remainingDistance = 120km
speed = 60km/h

ETA ~= 2 hours
```

A delay changes effective speed and therefore ETA.

Every simulation tick should keep ETA authoritative.

---

# 7. Delay Simulation

The frontend will eventually provide buttons such as:

- Rain Delay
- Traffic Delay
- Road Closure
- Clear Delay

The frontend sends a REST command.

Example:

```http
POST /api/v1/simulation/trucks/:truckId/delay
```

```json
{
  "type": "RAIN"
}
```

The backend then:

1. Validates the command.
2. Changes the truck's simulation scenario.
3. Changes effective speed.
4. Recalculates ETA.
5. Changes status to DELAYED when appropriate.
6. Creates an alert.
7. Emits Socket.IO events.
8. Continues simulation using the new speed.

Suggested deterministic scenario multipliers:

```text
NORMAL         1.00
RAIN           0.65
TRAFFIC        0.45
ROAD_CLOSURE   0.10 or another strong slowdown
```

Keep these values configurable.

Do not use external traffic/weather APIs.

This is a deterministic simulation.

Only one primary delay scenario needs to be active per truck for the hackathon.

---

# 8. Dock Availability

Operations users will have buttons on each dock door:

```text
Make unavailable
Make available
```

The frontend sends:

```http
PATCH /api/v1/docks/:dockId/status
```

Example:

```json
{
  "status": "UNAVAILABLE"
}
```

The backend owns all consequences.

If the dock has no active/upcoming assignment:

```text
D2 -> unavailable
```

If the dock has an affected truck:

```text
D2 unavailable
      |
      v
Find affected truck
      |
      v
Find compatible available docks
      |
      v
Rank alternatives
      |
      v
Reassign if possible
      |
      v
Create alert
      |
      v
Emit Socket.IO events
```

---

# 9. Dock Assignment Engine

Do NOT use ML.

Use a deterministic scoring algorithm.

Inputs:

- Truck ETA
- Appointment window
- Load type
- Priority
- Dock availability
- Supported load types
- Existing assignments
- Scheduled dock availability

Recommended flow:

```text
1. Filter unavailable docks
2. Filter incompatible docks
3. Evaluate arrival-time fit
4. Evaluate appointment-window fit
5. Evaluate priority
6. Calculate score
7. Rank docks
8. Return recommendations
```

The recommendation should be explainable.

Example:

```json
{
  "dockId": "D4",
  "score": 91,
  "reasons": [
    "Compatible with refrigerated load",
    "Available before ETA",
    "Fits appointment window",
    "Suitable for high-priority shipment"
  ]
}
```

Judges should be able to understand why a dock was selected.

---

# 10. Automatic Reassignment

If an assigned dock becomes unavailable:

### If a replacement exists

```text
D2 unavailable
    |
    v
TRK-101 affected
    |
    v
D4 selected
    |
    v
old assignment -> REASSIGNED
new assignment -> ASSIGNED
    |
    +--> DOCK_STATUS_CHANGED
    +--> DOCK_REASSIGNED
    +--> ALERT_CREATED
```

### If no replacement exists

Do not invent a dock.

Instead:

```text
NO_DOCK_AVAILABLE
```

Create an alert and leave the truck without a replacement assignment.

---

# 11. Alerts

Alerts are generated by backend domain logic.

Important alert types:

```text
TRUCK_DELAYED
DOCK_UNAVAILABLE
DOCK_REASSIGNMENT
NO_DOCK_AVAILABLE
TRUCK_ARRIVING
```

Alert severities:

```text
INFO
WARNING
CRITICAL
```

Alerts should be persisted when they represent meaningful operational events.

Every relevant new alert should also be emitted through Socket.IO:

```text
ALERT_CREATED
```

The frontend should not poll for alerts.

---

# 12. Socket.IO

Use Socket.IO, not raw WebSocket.

Use rooms.

Recommended rooms:

```text
operations
truck:{truckId}
shipment:{shipmentId}
```

## Operations room

Receives operational realtime events for all active trucks and relevant warehouse events.

## Truck room

Receives updates for one specific truck.

## Shipment room

Receives updates relevant to a shipment/customer tracking experience.

---

# 13. Socket.IO Events

At minimum support:

```text
TRUCK_POSITION_UPDATED
TRUCK_ETA_UPDATED
TRUCK_STATUS_CHANGED
ALERT_CREATED
DOCK_STATUS_CHANGED
DOCK_ASSIGNED
DOCK_REASSIGNED
```

Position update payload should stay small.

Example:

```json
{
  "type": "TRUCK_POSITION_UPDATED",
  "data": {
    "truckId": "TRK-101",
    "latitude": 28.421,
    "longitude": 77.312,
    "previousLatitude": 28.410,
    "previousLongitude": 77.300,
    "eta": "2026-08-26T18:40:00Z",
    "progress": 72.4,
    "status": "IN_TRANSIT",
    "serverTimestamp": "2026-08-26T18:16:00Z",
    "sequenceNumber": 42
  }
}
```

Do NOT send full route geometry every tick.

Do NOT send complete database objects every tick.

---

# 14. Socket.IO Separation

Do not tightly couple domain services to Socket.IO.

Prefer:

```text
Domain Event
    |
    v
Realtime Service
    |
    v
Socket.IO
```

For example:

```text
SimulationEngine
    |
    v
TRUCK_POSITION_UPDATED
    |
    v
RealtimeService
    |
    v
operations + truck:{id}
```

This keeps domain logic testable.

---

# 15. WMS Simulation

There is no real WMS integration.

We simulate one.

Expose:

```http
POST /api/v1/wms/events
```

Supported event types can include:

```text
TRAILER_LOCATION_UPDATED
TRAILER_STATUS_UPDATED
APPOINTMENT_UPDATED
DOCK_STATUS_UPDATED
TRAILER_ARRIVED
TRAILER_DOCKED
```

Architecture:

```text
WMS HTTP request
    |
    v
WMS Controller
    |
    v
WMS Event Handler
    |
    v
Domain Services
    |
    +--> Prisma
    +--> Simulation
    +--> Alerts
    +--> Socket.IO
```

Do not put WMS business logic directly in the controller.

---

# 16. REST API Conventions

Use:

```text
/api/v1
```

Recommended endpoints:

### Health

```text
GET /health
GET /api/v1/health
```

### Shipments

```text
GET /api/v1/shipments
GET /api/v1/shipments/:id
GET /api/v1/shipments/reference/:reference
GET /api/v1/tracking/:trackingNumber
```

### Trucks

```text
GET /api/v1/trucks
GET /api/v1/trucks/:id
```

### Docks

```text
GET /api/v1/docks
GET /api/v1/docks/:id
PATCH /api/v1/docks/:id/status
```

### Yard

```text
GET /api/v1/yard/overview
```

### Dock assignments

```text
GET /api/v1/dock-assignments
GET /api/v1/trucks/:truckId/dock-recommendations
POST /api/v1/trucks/:truckId/dock-assignment
```

### Simulation

```text
POST /api/v1/simulation/start
POST /api/v1/simulation/stop
POST /api/v1/simulation/reset

POST /api/v1/simulation/trucks/:truckId/delay
POST /api/v1/simulation/trucks/:truckId/clear-delay
```

### WMS

```text
POST /api/v1/wms/events
POST /api/v1/wms/simulate
```

---

# 17. Database Model

Core entities:

```text
Shipment
Truck
Route
Appointment
DockDoor
DockAssignment
Alert
LocationHistory
```

Core relationships:

```text
Shipment
   |
   v
Truck
   |
   +--> Route
   +--> DockAssignment
   +--> Alert
   +--> LocationHistory

Appointment
   |
   v
Shipment

DockDoor
   |
   v
DockAssignment
```

Keep the schema simple.

Do not create unnecessary enterprise entities.

---

# 18. Prisma Rules

Use Prisma for persistent database access.

Use service classes for business operations.

Prefer:

```text
Controller
   |
   v
Service
   |
   v
Prisma
```

Avoid putting complex Prisma logic directly in Express route handlers.

Use transactions when multiple related database changes must remain consistent.

Especially for:

- dock reassignment
- assignment changes
- dock availability changes affecting assignments

---

# 19. Code Structure

Prefer a structure similar to:

```text
src/
  server.ts
  app.ts

  config/
    env.ts

  routes/
    index.ts
    health.routes.ts
    shipments.routes.ts
    trucks.routes.ts
    docks.routes.ts
    yard.routes.ts
    simulation.routes.ts
    wms.routes.ts

  controllers/
    health.controller.ts
    shipment.controller.ts
    truck.controller.ts
    dock.controller.ts

  middleware/
    error-handler.ts
    not-found.ts

  services/
    shipment-service.ts
    truck-service.ts
    dock-service.ts
    alert-service.ts

  simulation/
    simulation-manager.ts
    truck-simulator.ts
    route-engine.ts
    live-state.ts

  eta/
    eta-engine.ts

  docking/
    dock-assignment-service.ts
    dock-failure-service.ts
    dock-scoring.ts

  alerts/
    alert-engine.ts

  wms/
    wms-event-handler.ts

  websocket/
    socket-server.ts
    realtime-service.ts
    events.ts
    rooms.ts

  types/

  lib/
    prisma.ts
    logger.ts

prisma/
  schema.prisma
  seed.ts

docs/
  architecture.md
  api.md
  realtime.md
```

The exact folder structure can evolve if there is a good reason, but keep responsibilities separated.

---

# 20. Validation

Validate external input.

Use Zod or an equivalent lightweight schema validation library.

Validate:

- REST request bodies
- query parameters where needed
- route parameters where appropriate
- WMS event payloads
- simulation commands

Never trust frontend input.

---

# 21. Error Handling

Use centralized Express error handling.

Return consistent errors.

Example:

```json
{
  "error": {
    "code": "TRUCK_NOT_FOUND",
    "message": "Truck TRK-101 was not found"
  }
}
```

Use appropriate HTTP status codes.

Do not leak internal stack traces in production responses.

---

# 22. Simulation Lifecycle

The simulation manager must support:

```text
start()
stop()
reset()
getTruckState()
getAllTruckStates()
```

Prevent duplicate intervals.

Bad:

```text
start()
start()
start()
```

causing three simulation loops.

There must be one authoritative simulation loop.

On server shutdown:

```text
SIGTERM / SIGINT
    |
    v
stop simulation
    |
    v
close Socket.IO
    |
    v
disconnect Prisma
    |
    v
exit
```

---

# 23. Testing

Runner: **Vitest + supertest** (`pnpm test`), suites in `tests/`. Phase 3 landed
`tests/read-api.test.ts` covering the read APIs against the seeded database.

Prioritize tests around business logic rather than testing every trivial getter.

Important tests:

### Simulation

- truck moves
- progress increases
- ETA changes
- truck eventually reaches destination
- start is idempotent
- stop works
- duplicate loops are prevented

### ETA

- normal ETA calculation
- rain increases ETA
- traffic increases ETA
- clearing delay restores normal behavior

### Dock assignment

- unavailable docks excluded
- incompatible docks excluded
- appointment fit affects score
- priority affects score
- deterministic recommendation

### Reassignment

- assigned dock becomes unavailable
- affected truck is detected
- compatible alternative found
- assignment changes
- reassignment alert generated
- no-dock case generates correct alert

### WMS

- valid events accepted
- invalid events rejected
- domain state changes correctly

---

# 24. Performance Rules

This is a hackathon, but don't create obviously bad architecture.

Do:

- Keep simulation state in memory.
- Broadcast only small realtime payloads.
- Send backend truck updates every 2 seconds.
- Let frontend interpolate.
- Avoid database writes every tick.
- Avoid loading full route geometry for every API request if unnecessary.
- Use Prisma transactions for multi-record state changes.
- Keep Socket.IO rooms targeted.

Do not:

- Write truck coordinates to PostgreSQL every 2 seconds.
- Broadcast entire database records every 2 seconds.
- Recalculate unrelated trucks when one truck changes.
- Recreate the Socket.IO server during simulation.
- Recreate the simulation interval per truck.

---

# 25. Demo Scenarios

The backend must support these deterministic demo flows.

## Scenario A: Normal movement

```text
Truck starts
    |
    v
Moves every 2 seconds
    |
    v
ETA decreases
    |
    v
Socket.IO updates
```

## Scenario B: Rain delay

```text
TRK-101 moving
    |
    v
POST delay RAIN
    |
    v
Speed decreases
    |
    v
ETA increases
    |
    v
ALERT_CREATED
    |
    v
TRUCK_STATUS_CHANGED
```

## Scenario C: Traffic delay

Same as rain but with a stronger slowdown.

## Scenario D: Dock failure

```text
TRK-101 -> D2
    |
    v
D2 -> UNAVAILABLE
    |
    v
Backend detects affected truck
    |
    v
Find replacement
    |
    v
TRK-101 -> D4
    |
    v
DOCK_REASSIGNED
    |
    v
ALERT_CREATED
```

## Scenario E: No replacement

```text
D2 unavailable
    |
    v
No compatible docks
    |
    v
NO_DOCK_AVAILABLE
    |
    v
ALERT_CREATED
```

---

# 26. Development Philosophy

This is a hackathon.

Prefer:

```text
Simple + deterministic + demonstrable
```

over:

```text
Complex + theoretically scalable + unfinished
```

Do not introduce abstractions unless they solve a real problem.

Do not create interfaces and factories just for the sake of "clean architecture".

Use good separation of responsibilities, but keep the code understandable.

If there are two reasonable solutions, choose the simpler one unless it compromises correctness.

---

# 27. What Claude Code Must NOT Do

Do not:

- Change the architecture without explaining why.
- Add Redis.
- Add Kafka.
- Add microservices.
- Add ML.
- Add external traffic APIs.
- Add external weather APIs.
- Move simulation responsibility to frontend.
- Calculate authoritative ETA in frontend.
- Automatically choose docks in frontend.
- Write every simulation tick to PostgreSQL.
- Create multiple simulation loops.
- Add authentication unless explicitly requested.
- Build frontend code while working on backend phases unless explicitly requested.
- Start the next phase automatically.

When implementing a phase, stay within that phase.

---

# 28. Phase Discipline

The backend will be built incrementally.

Expected order:

```text
Phase 0
Manual environment setup

Phase 1
Backend foundation

Phase 2
Prisma schema + seed

Phase 3
Read APIs

Phase 4
Simulation engine

Phase 5
Socket.IO realtime

Phase 6
ETA + delay scenarios

Phase 7
Dock assignment

Phase 8
Dock failure + reassignment + alerts

Phase 9
WMS integration

Phase 10
Integration testing + API documentation
```

When a prompt says "Do not proceed to the next phase", obey it.

Do not silently implement future-phase features.

---

# 29. Before Making Changes

Before implementing a phase:

1. Inspect the existing code.
2. Understand what previous phases already implemented.
3. Reuse existing utilities/services.
4. Avoid duplicating logic.
5. Preserve existing API contracts unless there is a concrete reason to change them.
6. Check the current Prisma schema before modifying it.
7. Run relevant tests before changing behavior when practical.

---

# 30. After Making Changes

Always:

1. Run TypeScript typecheck.
2. Run tests relevant to the changed code.
3. Run Prisma validation/generation if schema changed.
4. Run lint if configured.
5. Fix errors instead of hiding them.
6. Summarize changed files.
7. Explain any architectural decision that deviates from this document.

Never claim something works if you did not actually verify it.

---

# 31. Definition of Done

The backend is considered complete when:

```text
POSTGRES
  |
  +-- seeded trucks
  +-- shipments
  +-- routes
  +-- appointments
  +-- docks
  +-- assignments
  +-- alerts

NODE
  |
  +-- REST APIs
  +-- Socket.IO
  +-- Simulation Engine
  +-- ETA Engine
  +-- Dock Assignment Engine
  +-- Alert Engine
  +-- WMS Event Handler

REALTIME
  |
  +-- truck position every 2 seconds
  +-- ETA updates
  +-- status changes
  +-- alerts
  +-- dock changes
  +-- assignments
  +-- reassignments

SCENARIOS
  |
  +-- normal movement
  +-- rain delay
  +-- traffic delay
  +-- road closure
  +-- dock failure
  +-- automatic reassignment
  +-- no dock available
```

The backend should be ready for a frontend that simply consumes REST + Socket.IO and renders the state.
