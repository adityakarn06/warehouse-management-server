# E2 Backend — REST API (Phases 3–5: read APIs + simulation control)

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

- `status`: `AVAILABLE` `RESERVED` `OCCUPIED` `UNAVAILABLE`
- `loadType` matches against the dock's `supportedLoadTypes` list.

List rows include the dock's current assignment — `ASSIGNED` only, since a
`RECOMMENDED` row is a proposal and would otherwise show an `AVAILABLE` door as
occupied. Assignment history on the detail route is capped at the 20 most recent.
Detail rows include the full assignment history and the dock's unacknowledged
alerts.

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

## Simulation (Phase 4)

The backend owns truck movement. It advances every moving truck once every
`SIMULATION_TICK_MS` (2000 by default) along its fixed route, recomputes the
authoritative position, progress and ETA, and drives `IN_TRANSIT → ARRIVING →
ARRIVED`. The loop starts on server boot unless `SIMULATION_AUTOSTART=false`
(it is always off under `NODE_ENV=test`).

Delay commands (`/delay`, `/clear-delay`) are Phase 6 and are not implemented yet.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/simulation/start` | Idempotent — a second call is ignored, never a second loop |
| `POST` | `/api/v1/simulation/stop` | Stops the loop and flushes unpersisted movement |
| `POST` | `/api/v1/simulation/reset` | Reload the world from the database, keeping the loop's running/stopped state. A full demo rewind is `pnpm db:seed` |
| `GET` | `/api/v1/simulation/state` | Live state for every simulated truck |
| `GET` | `/api/v1/simulation/trucks/:truckId` | One truck, by id or reference |

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
    "eta": "2026-08-27T00:58:11.954Z",
    "status": "IN_TRANSIT",
    "activeDelay": "NORMAL",
    "arrivedAt": null,
    "lastUpdatedAt": "2026-08-26T15:15:22.401Z",
    "sequenceNumber": 10
  }
}
```

A truck that is not being simulated (terminal status, or the loop is not running)
404s with the standard error envelope.

### Realtime events

The engine emits `TRUCK_POSITION_UPDATED`, `TRUCK_ETA_UPDATED` and
`TRUCK_STATUS_CHANGED` into a `SimulationEventSink` (§14). Phase 5 backs that sink
with Socket.IO: events are broadcast by name to the `operations`, `truck:{id}` and
`shipment:{id}` rooms, and clients join by emitting `subscribe:operations` /
`subscribe:truck` / `subscribe:shipment`, each answering with a state snapshot.

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
```
