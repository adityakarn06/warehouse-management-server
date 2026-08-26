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

No test runner is configured yet. When the first tests land, wire one up
(and add `test` / single-test invocation here) rather than leaving §23 aspirational.

Environment: copy `.env.example` to `.env`. `DATABASE_URL` is the only
required variable; everything else has a default. `src/config/env.ts` parses
`process.env` through Zod once and `process.exit(1)`s on invalid config — read
config via `import { env } from './config/index.js'`, never `process.env`
(the one exception is `prisma/seed.ts`, which runs outside the app).

## Current state

**Phases 1–2 are done.**

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

Still empty placeholder directories: `src/services`, `src/simulation`,
`src/eta`, `src/docking`, `src/alerts`, `src/wms`. Sections 4–16 and 18–31 below
describe the target system, not the code on disk.

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
- **Wiring.** `createApp()` in `src/app.ts` builds the Express app; `src/server.ts`
  owns the HTTP server, Socket.IO init, and graceful shutdown. New domain routers
  mount on `apiV1Router` in `src/routes/index.ts`. Note `/health` is registered
  twice on purpose — top-level in `app.ts` and under `/api/v1` via the router —
  both delegating to the same `getHealth` controller. `io.close()` also closes the
  shared HTTP server, which is why `shutdown()` tolerates `ERR_SERVER_NOT_RUNNING`.
- **Logging** goes through `src/lib/logger.ts` (level-filtered console wrapper),
  not bare `console.*`.

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
