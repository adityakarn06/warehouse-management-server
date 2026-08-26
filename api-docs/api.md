# E2 Backend — REST API (Phases 3–7: read APIs, simulation control, docking)

Base URL: `http://localhost:4000`
All domain endpoints live under `/api/v1`.

## Conventions

Every successful response is wrapped in an envelope:

```jsonc
// single resource
{ "data": { ... } }

// collection
{ "data": [ ... ], "meta": { "total": 12, "limit": 50, "offset": 0 } }
```

Errors use the shape rendered by the central error handler:

```jsonc
{ "error": { "message": "Truck TRK-999 was not found", "status": 404, "details": [ ... ] } }
```

`details` is present only for validation failures, where it carries the raw Zod
issue list.

| Status | When |
| --- | --- |
| `200` | Success |
| `400` | Query/route parameter failed Zod validation |
| `404` | Unknown resource, or unknown route |
| `500` | Unhandled error (message hidden in production) |
| `503` | `/api/v1/health/db` only — database unreachable |

### Pagination

Every list endpoint accepts `limit` (1–200, default 50) and `offset`
(default 0), and echoes them back with the unpaginated `total` in `meta`.

### Lookup by id or human reference

The seed uses human references as primary keys (`Truck.id === "TRK-101"`), while
rows created at runtime get a `cuid()`. Detail endpoints therefore look up by
`id` first and fall back to the natural key — `reference` for trucks and
shipments, `code` for docks and routes — so both forms work.

### Route geometry

`Route.geometry` is large and static. It is returned **only** by
`GET /api/v1/routes/:id`; no other endpoint includes it.

---

## Endpoints

### Health

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness. Does not touch the database. |
| `GET` | `/api/v1/health` | Same handler as above. |
| `GET` | `/api/v1/health/db` | Readiness; `503` when Postgres is unreachable. |

Health responses are **not** enveloped (they predate Phase 3 and are consumed by
probes, not the frontend).

### Shipments

| Method | Path | Query params |
| --- | --- | --- |
| `GET` | `/api/v1/shipments` | `status`, `priority`, `loadType`, `limit`, `offset` |
| `GET` | `/api/v1/shipments/:id` | — |
| `GET` | `/api/v1/shipments/reference/:reference` | — |

- `status`: `CREATED` `IN_TRANSIT` `DELAYED` `ARRIVING` `ARRIVED` `DOCKED` `DELIVERED`
- `priority`: `LOW` `MEDIUM` `HIGH` `CRITICAL`
- `loadType`: `GENERAL` `REFRIGERATED` `HAZARDOUS` `OVERSIZED`

List rows carry a trimmed truck and the appointment window. Detail rows add the
full truck, its route (no geometry), the appointment, and any active dock
assignment.

### Tracking

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/tracking/:trackingNumber` |

The customer-facing endpoint. Hand-shaped and flat — no raw Prisma rows.
`appointmentWindow` and `assignedDock` are `null` when absent. `assignedDock`
reflects a committed (`ASSIGNED`) assignment only — never a recommendation.

```jsonc
{
  "data": {
    "reference": "SHP-1001",
    "trackingNumber": "E2-TRACK-101",
    "trailerId": "TRL-101",
    "customerName": "FreshMart Retail Pvt Ltd",
    "status": "IN_TRANSIT",
    "truckStatus": "IN_TRANSIT",
    "activeDelay": "NORMAL",
    "origin":      { "name": "Delhi NCR Hub, Delhi", "latitude": 28.6139, "longitude": 77.209 },
    "destination": { "name": "E2 Fulfilment Centre, Kolkata", "latitude": 22.585, "longitude": 88.41 },
    "currentPosition": { "latitude": 24.93226, "longitude": 84.06354, "lastUpdatedAt": "2026-08-26T13:30:00.000Z" },
    "eta": "2026-08-26T14:25:00.000Z",
    "progress": 62,
    "priority": "HIGH",
    "loadType": "REFRIGERATED",
    "appointmentWindow": { "start": "2026-08-26T14:15:00.000Z", "end": "2026-08-26T15:15:00.000Z", "expectedDurationMinutes": 60 },
    "assignedDock": {
      "id": "D2", "code": "D2", "name": "Dock Door 2 (reefer)", "zone": "NORTH",
      "status": "RESERVED", "assignmentStatus": "ASSIGNED",
      "scheduledStart": "2026-08-26T14:15:00.000Z", "scheduledEnd": "2026-08-26T15:15:00.000Z"
    }
  }
}
```

### Trucks

| Method | Path | Query params |
| --- | --- | --- |
| `GET` | `/api/v1/trucks` | `status`, `routeId`, `activeDelay`, `limit`, `offset` |
| `GET` | `/api/v1/trucks/:id` | — |

- `status`: `IN_TRANSIT` `DELAYED` `ARRIVING` `ARRIVED` `DOCKED` `COMPLETED`
- `activeDelay`: `NORMAL` `RAIN` `TRAFFIC` `ROAD_CLOSURE`

Detail rows include the route (no geometry), the shipment and its appointment,
all dock assignments newest-first, and the 20 most recent `LocationHistory`
snapshots.

### Routes

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/routes/:id` |

Returns the full route **including `geometry`** — an array of
`{ latitude, longitude }` points for the map polyline.

### Docks

| Method | Path | Query params |
| --- | --- | --- |
| `GET` | `/api/v1/docks` | `status`, `zone`, `loadType`, `limit`, `offset` |
| `GET` | `/api/v1/docks/:id` | — |
| `PATCH` | `/api/v1/docks/:id/status` | — (JSON body) |

- `status`: `AVAILABLE` `RESERVED` `OCCUPIED` `UNAVAILABLE`
- `loadType` matches against the dock's `supportedLoadTypes` list.

List rows include the dock's current assignment — `ASSIGNED` only, since a
`RECOMMENDED` row is a proposal and would otherwise show an `AVAILABLE` door as
occupied. Assignment history on the detail route is capped at the 20 most recent.
Detail rows include the full assignment history and the dock's unacknowledged
alerts.

#### `PATCH /api/v1/docks/:dockId/status` (Phase 7)

The operator's two buttons — "make unavailable" and "make available". The
frontend sends a status and nothing else; the backend owns every consequence
(§2, §8).

```jsonc
// request
{ "status": "UNAVAILABLE", "reason": "Hydraulic leveler fault" }
```

- `status`: `AVAILABLE` or `UNAVAILABLE` only. `RESERVED` and `OCCUPIED` are
  owned by the assignment engine and the WMS feed; accepting them here would let
  the board lie. Anything else is a `400`.
- `reason` is optional and only recorded when going out of service. It defaults
  to `"Marked unavailable by operations"`.

```jsonc
// response
{
  "data": {
    "dock": { /* the full dock detail, as GET /docks/:id */ },
    "changed": true,
    "affectedAssignments": [
      { "id": "DA-3002", "scheduledStart": "...", "scheduledEnd": "...",
        "shipmentId": "SHP-1001",
        "truck": { "id": "TRK-101", "reference": "TRK-101", "status": "IN_TRANSIT", "eta": "..." } }
    ],
    "alert": { "alertId": "clx...", "type": "DOCK_UNAVAILABLE", "severity": "WARNING", /* ... */ }
  }
}
```

Notes on behaviour:

- Pressing the same button twice is a **no-op success**: `changed: false`, the
  current state is returned and nothing is emitted.
- Taking down a door that still holds an `ASSIGNED` row reports it in
  `affectedAssignments` and raises one `DOCK_UNAVAILABLE` alert naming the
  stranded trucks. **Phase 7 stops there** — the assignment is left in place and
  no replacement is chosen. Automatic reassignment is Phase 8 (§10).
- Putting a door back while a booking still holds it returns it to `RESERVED`,
  not `AVAILABLE` — reporting a taken door as free would be a lie.
- Emits `DOCK_STATUS_CHANGED`, plus `ALERT_CREATED` when an alert was raised. A
  failed alert write is logged but never fails the command.
- `404` on an unknown dock (id or `code`).

### Dock recommendations and assignment (Phase 7)

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/v1/trucks/:truckId/dock-recommendations` | — |
| `POST` | `/api/v1/trucks/:truckId/dock-assignment` | `{ "dockId"?: string }` |

#### `GET /api/v1/trucks/:truckId/dock-recommendations`

Deterministic, explainable ranking of every door that can take the truck (§9).
**Side-effect free** — a recommendation is a proposal, so nothing is written and
operations can review it as often as they like.

```jsonc
{
  "data": {
    "truck": { "id": "TRK-101", "reference": "TRK-101", "status": "IN_TRANSIT", "eta": "...", "progress": 62 },
    "shipment": { "id": "SHP-1001", "reference": "SHP-1001", "priority": "HIGH", "loadType": "REFRIGERATED" },
    "appointment": { "reference": "APT-2001", "windowStart": "...", "windowEnd": "...", "expectedDurationMinutes": 60 },
    // The slot the docks were scored against: the later of ETA and the booked
    // window, plus the expected dock time.
    "requestedWindow": { "start": "...", "end": "...", "minutes": 60 },
    "currentAssignment": { "id": "DA-3002", "dockDoorId": "D2", "dockCode": "D2", "status": "ASSIGNED" },
    "recommendations": [
      {
        "dockId": "D4",
        "dockCode": "D4",
        "dockName": "Dock Door 4 (reefer)",
        "zone": "NORTH",
        "status": "AVAILABLE",
        "score": 96,
        "reasons": [
          "Compatible with refrigerated load",
          "Available before ETA",
          "Covers 50 of the 60 minutes booked",
          "Suitable for high-priority shipment",
          "Door is free right now"
        ],
        "breakdown": {
          "loadTypeFit": 25, "availabilityFit": 30,
          "appointmentFit": 20.8, "priorityFit": 15, "statusBonus": 5
        },
        "availableFrom": null
      }
    ],
    "excluded": [
      { "dockId": "D3", "dockCode": "D3", "reason": "Does not support REFRIGERATED loads" },
      { "dockId": "D7", "dockCode": "D7", "reason": "Dock is out of service: Hydraulic leveler under maintenance" }
    ]
  }
}
```

The score is out of 100 and its five components always sum to it, so a judge can
read exactly why one door beat another:

| Component | Max | What it measures |
| --- | --- | --- |
| `loadTypeFit` | 25 | Full marks for the load a specialist door exists for. General freight loses 5 per specialist type a door also supports (floor 10), so reefer doors stay free for reefers. |
| `availabilityFit` | 30 | Free at or before the truck's slot start; decays linearly with how late the door frees up. |
| `appointmentFit` | 25 | How much of the booked appointment the door can actually cover. A truck with no appointment scores a neutral 15. |
| `priorityFit` | 15 | Lateness, weighted by priority — `HIGH`/`CRITICAL` punish a wait twice as hard as `MEDIUM`/`LOW`, so urgency changes the *ranking*, not just the total. |
| `statusBonus` | 5 | `AVAILABLE` 5, `RESERVED` 3, `OCCUPIED` 0. |

Four hard filters run before scoring; each produces an `excluded` entry with a
sentence: the door is out of service, it cannot take the load type, it is already
booked across the slot, or it only frees up after the slot has ended.

#### `POST /api/v1/trucks/:truckId/dock-assignment`

```jsonc
// request — dockId optional
{ "dockId": "D4" }
```

Returns the same body as the recommendation route plus `created`, `assignment`
and `previousAssignment`. `201` when a new assignment row was written, `200` when
the truck already held that door.

Notes on behaviour:

- Omitting `dockId` commits the **top-ranked** recommendation. Nothing is
  auto-assigned on its own — a truck only gets a dock when someone asks (§9).
- Naming a dock the engine excluded is a `400` quoting the exclusion reason
  (`"Dock D3 cannot take TRK-101: Does not support REFRIGERATED loads"`). The
  backend is the source of truth (§2), so this cannot be overridden.
- `404` on an unknown truck or dock; `409` when no compatible dock exists and no
  dock was named. We never invent a dock (§10) — Phase 8 turns this case into a
  `NO_DOCK_AVAILABLE` alert.
- Moving a truck cancels its previous row (`CANCELLED`, `releasedAt`) and frees
  that door. `REASSIGNED` + `previousAssignmentId` is deliberately **not** used
  here: that chain is reserved for Phase 8's dock-failure path.
- Committing a dock flips it `AVAILABLE → RESERVED` with
  `availableFrom = scheduledEnd`. `OCCUPIED` is the WMS's transition (Phase 9),
  when a truck has physically backed in.
- All of it — superseding the old row, freeing its door, creating the new row and
  reserving its door — runs in one Prisma transaction (§18).
- Emits `DOCK_ASSIGNED` (operations + `truck:{id}` + `shipment:{id}`) and a
  `DOCK_STATUS_CHANGED` for each door whose status moved.

### Dock assignments

| Method | Path | Query params |
| --- | --- | --- |
| `GET` | `/api/v1/dock-assignments` | `status`, `truckId`, `dockDoorId`, `shipmentId`, `limit`, `offset` |

- `status`: `RECOMMENDED` `ASSIGNED` `REASSIGNED` `COMPLETED` `CANCELLED`

Ordered newest-first. `previousAssignmentId` links a replacement back to the
assignment it superseded.

### Alerts

| Method | Path | Query params |
| --- | --- | --- |
| `GET` | `/api/v1/alerts` | `type`, `severity`, `acknowledged`, `truckId`, `shipmentId`, `dockDoorId`, `limit`, `offset` |

- `type`: `TRUCK_DELAYED` `DOCK_UNAVAILABLE` `DOCK_REASSIGNMENT` `NO_DOCK_AVAILABLE` `TRUCK_ARRIVING`
- `severity`: `INFO` `WARNING` `CRITICAL`
- `acknowledged`: `true` or `false` (exact strings — anything else is a `400`)

Ordered newest-first.

### Yard overview

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/yard/overview` |

The operations dashboard payload, assembled from a single `$transaction` batch
so every section describes the same moment.

```jsonc
{
  "data": {
    "generatedAt": "2026-08-26T14:00:00.000Z",
    "summary": {
      "activeTrucks": 11, "delayedTrucks": 2, "arrivingTrucks": 2, "dockedTrucks": 1,
      "docksAvailable": 3, "docksUnavailable": 1,
      "activeAssignments": 4, "unresolvedAlerts": 5
    },
    "activeTrucks":     [ /* status != COMPLETED, with route + shipment summaries and assignedDockId */ ],
    "upcomingArrivals": [ /* ARRIVING, or ETA within ARRIVAL_HORIZON_MINUTES; by ETA asc, max 10 */ ],
    "docks":            [ /* all 8, each with its ASSIGNED currentAssignment or null */ ],
    "activeAssignments":[ /* status ASSIGNED or RECOMMENDED */ ],
    "alerts":           [ /* acknowledged: false, newest first, max 20 */ ]
  }
}
```

`ARRIVAL_HORIZON_MINUTES` (default `120`) is configurable via the environment.

---

## Simulation (Phases 4 & 6)

The backend owns truck movement. It advances every moving truck once every
`SIMULATION_TICK_MS` (2000 by default) along its fixed route, recomputes the
authoritative position, progress and ETA, and drives `IN_TRANSIT → ARRIVING →
ARRIVED`. The loop starts on server boot unless `SIMULATION_AUTOSTART=false`
(it is always off under `NODE_ENV=test`).

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/simulation/start` | Idempotent — a second call is ignored, never a second loop |
| `POST` | `/api/v1/simulation/stop` | Stops the loop and flushes unpersisted movement |
| `POST` | `/api/v1/simulation/reset` | Reload the world from the database, keeping the loop's running/stopped state. A full demo rewind is `pnpm db:seed` |
| `GET` | `/api/v1/simulation/state` | Live state for every simulated truck |
| `GET` | `/api/v1/simulation/trucks/:truckId` | One truck, by id or reference — including its current scenario |
| `POST` | `/api/v1/simulation/trucks/:truckId/delay` | Activate a delay scenario |
| `POST` | `/api/v1/simulation/trucks/:truckId/clear-delay` | Return the truck to normal speed |

The three lifecycle endpoints return the same shape:

```json
{ "data": { "running": true, "truckCount": 9, "tickMs": 2000 } }
```

`GET /api/v1/simulation/trucks/TRK-101`:

```json
{
  "data": {
    "truckId": "TRK-101",
    "reference": "TRK-101",
    "routeId": "RTE-DEL-KOL-01",
    "shipmentId": "SHP-1001",
    "latitude": 24.92185,
    "longitude": 85.31402,
    "previousLatitude": 24.92198,
    "previousLongitude": 85.31418,
    "progress": 62.18175,
    "speedKmph": 58,
    "baseSpeedKmph": 58,
    "eta": "2026-08-27T00:58:11.954Z",
    "status": "IN_TRANSIT",
    "activeDelay": "NORMAL",
    "delayMultiplier": 1,
    "arrivedAt": null,
    "lastUpdatedAt": "2026-08-26T15:15:22.401Z",
    "sequenceNumber": 10
  }
}
```

A truck that is not being simulated (terminal status, or the loop is not running)
404s with the standard error envelope.

### Delay scenarios (Phase 6)

The frontend's **Rain / Traffic / Road Closure / Clear** buttons send a scenario
name and nothing else. The backend owns every consequence (§2): effective speed,
ETA, status, the alert and the realtime events.

```text
POST /api/v1/simulation/trucks/TRK-101/delay
{ "type": "RAIN" }
```

`type` is one of `RAIN` `TRAFFIC` `ROAD_CLOSURE`. `NORMAL` is rejected — clearing
is its own endpoint, so activating and clearing can never be confused.

Effective speed is the truck's **base** speed times the scenario's multiplier:

| Scenario | Multiplier | Env var | Alert severity |
| --- | --- | --- | --- |
| `NORMAL` | `1.00` | — | — |
| `RAIN` | `0.65` | `DELAY_MULTIPLIER_RAIN` | `WARNING` |
| `TRAFFIC` | `0.45` | `DELAY_MULTIPLIER_TRAFFIC` | `WARNING` |
| `ROAD_CLOSURE` | `0.10` | `DELAY_MULTIPLIER_ROAD_CLOSURE` | `CRITICAL` |

There is no `baseSpeedKmph` column. A persisted row carries the *effective* speed
plus the scenario that produced it, so the base divides straight back out at load
time — which is why every multiplier must be greater than zero. A road closure is
therefore a very strong slowdown rather than a full stop (a stationary truck would
stop emitting position updates entirely). The seed is built to match: the RAIN
truck is 39 km/h (60 × 0.65) and the TRAFFIC truck is 27 km/h (60 × 0.45).

Both endpoints return the authoritative resulting state, so the frontend never has
to recompute or re-read anything:

```json
{
  "data": {
    "truck": {
      "truckId": "TRK-101",
      "reference": "TRK-101",
      "progress": 66.69733,
      "speedKmph": 37.7,
      "baseSpeedKmph": 58,
      "eta": "2026-08-27T05:35:28.817Z",
      "status": "DELAYED",
      "activeDelay": "RAIN",
      "delayMultiplier": 0.65,
      "sequenceNumber": 75
    },
    "alert": {
      "alertId": "cmtab2cvw0000sditzaufjr0n",
      "type": "TRUCK_DELAYED",
      "severity": "WARNING",
      "title": "Rain delay on TRK-101",
      "message": "TRK-101 slowed from 58 to 37.7 km/h due to rain; ETA pushed out by 276 min.",
      "truckId": "TRK-101",
      "shipmentId": "SHP-1001",
      "dockDoorId": null,
      "createdAt": "2026-08-26T16:25:45.404Z"
    }
  }
}
```

Notes on behaviour:

- A delayed truck stays `DELAYED` all the way to `ARRIVED` — it is not promoted to
  `ARRIVING` at 95%, so the operator's scenario is never silently overwritten.
  Clearing recomputes the status from progress (`ARRIVING` past the threshold,
  otherwise `IN_TRANSIT`).
- **Clearing raises no alert** and returns `"alert": null`. §11 defines no
  "delay cleared" type, and reusing `TRUCK_DELAYED` would be off-label.
- Pressing the same button twice is a no-op success: one alert, not two.
- One activation writes one `Truck` update, one `LocationHistory` row
  (`DELAY_ACTIVATED` / `DELAY_CLEARED`) and one `Alert`. Position ticks still never
  touch the database (§24).
- Only one primary scenario is active per truck (§7). Switching between two
  scenarios (RAIN -> TRAFFIC) leaves the status `DELAYED` but still emits
  `TRUCK_STATUS_CHANGED`, because that is the only payload carrying `activeDelay`.
- Arriving clears the scenario back to `NORMAL` — an `ARRIVED` truck has no speed
  for a multiplier to act on, and could never be un-delayed afterwards.
- `404` if the truck is not being simulated (unknown, terminal status, or the loop
  never loaded it); `409` if it arrived while the loop was running, or if the
  simulation is stopped; `400` for an unknown scenario name.
- A delay command holds the same lock a tick does, so it can never interleave
  with one; two rapid commands queue.

### Realtime events

The engine emits `TRUCK_POSITION_UPDATED`, `TRUCK_ETA_UPDATED`,
`TRUCK_STATUS_CHANGED` and — since Phase 6 — `ALERT_CREATED` into a
`SimulationEventSink` (§14). Phase 5 backs that sink
with Socket.IO: events are broadcast by name to the `operations`, `truck:{id}` and
`shipment:{id}` rooms, and clients join by emitting `subscribe:operations` /
`subscribe:truck` / `subscribe:shipment`, each answering with a state snapshot.

Phase 7 adds `DOCK_ASSIGNED` and `DOCK_STATUS_CHANGED`, raised by the docking
commands through their own sink for the same reason (§14) — no domain module
imports Socket.IO.

**The full realtime contract — every event, payload and room — is in
[`realtime.md`](./realtime.md).**

---

## Example requests

```bash
# Track a shipment (customer-facing)
curl -s http://localhost:4000/api/v1/tracking/E2-TRACK-101 | jq

# All trucks
curl -s http://localhost:4000/api/v1/trucks | jq

# Dock status
curl -s 'http://localhost:4000/api/v1/docks?status=AVAILABLE' | jq

# Yard overview (operations dashboard)
curl -s http://localhost:4000/api/v1/yard/overview | jq

# Live simulation state
curl -s http://localhost:4000/api/v1/simulation/state | jq '.data[] | {reference, progress, status, eta}'

# Watch one truck advance
curl -s http://localhost:4000/api/v1/simulation/trucks/TRK-101 | jq

# Lifecycle
curl -sX POST http://localhost:4000/api/v1/simulation/stop  | jq
curl -sX POST http://localhost:4000/api/v1/simulation/start | jq

# Scenario B — rain delay
curl -sX POST http://localhost:4000/api/v1/simulation/trucks/TRK-101/delay \
  -H 'Content-Type: application/json' -d '{"type":"RAIN"}' | jq

# Scenario C — traffic delay (a stronger slowdown)
curl -sX POST http://localhost:4000/api/v1/simulation/trucks/TRK-102/delay \
  -H 'Content-Type: application/json' -d '{"type":"TRAFFIC"}' | jq

# Road closure — the strongest slowdown, and a CRITICAL alert
curl -sX POST http://localhost:4000/api/v1/simulation/trucks/TRK-104/delay \
  -H 'Content-Type: application/json' -d '{"type":"ROAD_CLOSURE"}' | jq

# Back to normal
curl -sX POST http://localhost:4000/api/v1/simulation/trucks/TRK-101/clear-delay | jq

# The alerts those delays raised
curl -s 'http://localhost:4000/api/v1/alerts?type=TRUCK_DELAYED&limit=3' | jq

# --- Docking (Phase 7) ---

# Ranked, explainable dock options for an arriving refrigerated truck
curl -s http://localhost:4000/api/v1/trucks/TRK-101/dock-recommendations | jq

# Scenario D — assign the compatible replacement door by hand
curl -s -X POST http://localhost:4000/api/v1/trucks/TRK-101/dock-assignment \
  -H 'Content-Type: application/json' -d '{"dockId":"D4"}' | jq

# ...or let the backend take its own top pick
curl -s -X POST http://localhost:4000/api/v1/trucks/TRK-101/dock-assignment \
  -H 'Content-Type: application/json' -d '{}' | jq

# Take a dock out of service (raises DOCK_UNAVAILABLE if something is assigned)
curl -s -X PATCH http://localhost:4000/api/v1/docks/D2/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"UNAVAILABLE","reason":"Hydraulic leveler fault"}' | jq

# ...and put it back
curl -s -X PATCH http://localhost:4000/api/v1/docks/D2/status \
  -H 'Content-Type: application/json' -d '{"status":"AVAILABLE"}' | jq

# Scenario E — the only oversized door is occupied, so nothing is recommended
curl -s http://localhost:4000/api/v1/trucks/TRK-109/dock-recommendations | jq '.data.excluded'
```
