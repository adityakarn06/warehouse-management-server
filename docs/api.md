# E2 Backend — REST API

Base URL: `http://localhost:4000`
All domain endpoints live under `/api/v1`.

Companion documents: **`realtime.md`** for the Socket.IO contract, and
**`architecture.md`** for how the pieces fit together and why.

## For frontend developers — the short version

1. **The backend is the source of truth.** Truck position, progress, speed, ETA,
   status, delay scenario, dock availability, assignments, reassignments and
   alerts are all decided here. The frontend asks for an action, subscribes, and
   renders. It never picks a replacement dock or computes an ETA itself.
2. **Read state over REST, follow it over Socket.IO.** Load a page with a `GET`,
   then subscribe to the rooms you care about; every subsequent change arrives as
   an event. Do not poll — alerts especially.
3. **Positions arrive every ~2 seconds; you interpolate between them.** Each
   `TRUCK_POSITION_UPDATED` carries `targetLatitude`/`targetLongitude` — where
   the truck will be at the *next* tick — precisely so you can animate towards it.
   See `architecture.md`.
4. **Every command answers with the resulting state.** A delay, an assignment or
   a dock failure returns what the backend decided, so you never need a
   follow-up `GET` to find out what happened.
5. **`sequenceNumber` is your high-water mark.** Drop any truck update whose
   sequence is below the last one you applied; it survives a simulation reset.

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
| `201` | A dock assignment was created |
| `400` | Body, query or route parameter failed Zod validation; or a command the domain refuses outright (an incompatible dock, an unknown delay scenario) |
| `404` | Unknown resource, or unknown route |
| `409` | The command conflicts with current state — the door was taken in between, the loop is not running, a trailer is not docked where the feed says |
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

Despite the path segment, `:trackingNumber` accepts any of four identifiers
(problem statement §1) — a tracking number, a shipment reference, a shipment
id, or a truck's trailer id — tried in that order and stopping at the first
match. `resolvedBy` in the response names which arm matched:
`TRACKING_NUMBER` | `SHIPMENT_REFERENCE` | `SHIPMENT_ID` | `TRAILER_ID`.

```jsonc
{
  "data": {
    "reference": "SHP-1001",
    "trackingNumber": "E2-TRACK-101",
    "trailerId": "TRL-101",
    "resolvedBy": "TRACKING_NUMBER",
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
snapshots. `:id` accepts a truck's own id, its `reference` (`TRK-101`), or its
`trailerId` (`TRL-101`) — same fallback order as every other id-or-natural-key
lookup in the API.

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
| `GET` | `/api/v1/docks/schedule` | `from`, `to`, `includeRecommended` |
| `GET` | `/api/v1/docks/:id` | — |
| `PATCH` | `/api/v1/docks/:id/status` | — (JSON body) |
| `POST` | `/api/v1/docks/:id/release` | — |

- `status`: `AVAILABLE` `RESERVED` `OCCUPIED` `UNAVAILABLE`
- `loadType` matches against the dock's `supportedLoadTypes` list.

List rows include the dock's current assignment — `ASSIGNED` only, since a
`RECOMMENDED` row is a proposal and would otherwise show an `AVAILABLE` door as
occupied. Assignment history on the detail route is capped at the 20 most recent.
Detail rows include the full assignment history and the dock's unacknowledged
alerts.

#### `GET /api/v1/docks/schedule`

The dock-door assignment schedule (problem statement §7 output) — a
forward-looking timeline per door, as opposed to `GET /docks/:id`'s
recency-ordered history for a single door. Registered ahead of `/docks/:id` so
`schedule` is never matched as a dock id.

- `from` / `to`: ISO datetimes bounding the window. Default `from` is now,
  `to` is `now + ARRIVAL_HORIZON_MINUTES`.
- `includeRecommended`: `"true"` also lists `RECOMMENDED` rows. Defaults to
  `false` — committed (`ASSIGNED`) only, so the schedule never shows a proposal
  as a booking.

An assignment with no `scheduledStart`/`scheduledEnd` (both nullable) always
appears regardless of `from`/`to`, on the same reasoning the assignment engine
itself uses when checking for a clash: no window does not mean no booking, and
excluding it would let a door that is actually taken read as free on the
schedule.

```jsonc
{
  "data": {
    "generatedAt": "2026-08-27T17:00:00.000Z",
    "from": "2026-08-27T17:00:00.000Z",
    "to": "2026-08-27T19:00:00.000Z",
    "includeRecommended": false,
    "docks": [
      {
        "dockId": "D2", "dockCode": "D2", "dockName": "Dock Door 2 (reefer)",
        "zone": "NORTH", "status": "RESERVED",
        "assignments": [
          { "id": "DA-3002", "status": "ASSIGNED", "truckId": "TRK-101",
            "truckReference": "TRK-101", "trailerId": "TRL-101",
            "shipmentReference": "SHP-1001", "priority": "HIGH", "loadType": "REFRIGERATED",
            "score": 91, "reasons": ["..."],
            "scheduledStart": "2026-08-27T17:15:00.000Z", "scheduledEnd": "2026-08-27T18:15:00.000Z" }
        ]
      }
    ]
  }
}
```

#### `PATCH /api/v1/docks/:dockId/status` (Phase 7, cascade in Phase 8)

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
    "alert": { "alertId": "clx...", "type": "DOCK_UNAVAILABLE", "severity": "WARNING", /* ... */ },
    "reassignments": [
      {
        "truckId": "TRK-101",
        "truckReference": "TRK-101",
        "shipmentId": "SHP-1001",
        "outcome": "REASSIGNED",
        "previousAssignmentId": "DA-3002",
        "previousDockDoorId": "D2",
        "previousDockCode": "D2",
        "newAssignmentId": "clx...",
        "newDockDoorId": "D4",
        "newDockCode": "D4",
        "score": 87,
        "reasons": ["Compatible with refrigerated load", "Available before ETA", "..."],
        "alert": { "alertId": "clx...", "type": "DOCK_REASSIGNMENT", "severity": "INFO", /* ... */ }
      }
    ]
  }
}
```

Notes on behaviour:

- Pressing the same button twice is a **no-op success**: `changed: false`, the
  current state is returned and nothing is emitted.
- Taking down a door that still holds an `ASSIGNED` row reports it in
  `affectedAssignments`, raises one `DOCK_UNAVAILABLE` alert naming the affected
  trucks, and then **runs the failure cascade** (§10): each of those trucks is
  re-scored against every remaining door and moved, or reported as having
  nowhere to go. `affectedAssignments` describes the door as it was *before* the
  cascade; `reassignments` says where each truck ended up.
- `outcome: "REASSIGNED"` — the old row becomes `REASSIGNED` (`reassignedAt`
  stamped, `releasedAt` left null) and the new row points back at it through
  `previousAssignmentId`. The replacement door flips `AVAILABLE → RESERVED`.
- `outcome: "NO_DOCK_AVAILABLE"` — no dock is invented (§10). The old row is
  `CANCELLED`, the truck is left genuinely unassigned, and a `CRITICAL`
  `NO_DOCK_AVAILABLE` alert carries the scorer's own exclusion sentences in
  `metadata.excluded` so the board can say *why* nothing fit.
- `outcome: "REASSIGNMENT_FAILED"` — the move itself failed, so the truck is
  still `ASSIGNED` to the door that just went down and needs a human. It gets a
  `CRITICAL` alert of its own; it is never silently omitted from this array,
  because "absent" would be indistinguishable from "never affected".
- Trucks on a multi-booking door are handled earliest-slot-first, so the demo is
  deterministic (§25). Each truck's move is its own transaction: one failing
  must not roll back another's.
- Putting a door back while a booking still holds it returns it to `RESERVED`,
  not `AVAILABLE` — reporting a taken door as free would be a lie. After the
  cascade a repaired door is normally `AVAILABLE`, because its booking left with
  the reassignment.
- Emits `DOCK_STATUS_CHANGED` for every door whose status moved, `ALERT_CREATED`
  per alert, and `DOCK_REASSIGNED` per truck that was moved. A failed alert
  write is logged but never fails the command — the door is authoritatively down
  and the truck authoritatively moved either way.
- `404` on an unknown dock (id or `code`).

#### `POST /api/v1/docks/:dockId/release` (Phase 8)

Hands a door back to the yard. Every committed assignment on it becomes
`COMPLETED` with `releasedAt` stamped, and the door returns to `AVAILABLE` with
`availableFrom` cleared.

```jsonc
// response
{
  "data": {
    "dockDoorId": "D4",
    "dockCode": "D4",
    "status": "AVAILABLE",
    "releasedAssignmentIds": ["clx..."]
  }
}
```

- A door that is `UNAVAILABLE` stays `UNAVAILABLE`: releasing a booking does not
  repair a broken dock. The response carries the *resulting* status either way.
- Emits `DOCK_STATUS_CHANGED` only when the status actually moved.
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

- Omitting `dockId` — or sending no body at all — commits the **top-ranked**
  recommendation. Nothing is auto-assigned on its own: a truck only gets a dock
  when someone asks (§9).
- Naming a dock the engine excluded is a `400` quoting the exclusion reason
  (`"Dock D3 cannot take TRK-101: Does not support REFRIGERATED loads"`). The
  backend is the source of truth (§2), so this cannot be overridden.
- `404` on an unknown truck or dock; `409` when no compatible dock exists and no
  dock was named, or when the door stopped being usable between scoring and
  committing — taken by another truck, or taken out of service. We never invent a dock (§10) — on the *failure* path the same
  situation becomes a `NO_DOCK_AVAILABLE` alert instead of an error, because
  nobody pressed a button to be told no.
- Moving a truck by hand cancels its previous row (`CANCELLED`, `releasedAt`)
  and frees that door. `REASSIGNED` + `previousAssignmentId` is deliberately
  **not** used here: that chain belongs to the dock-failure path, so the
  timeline distinguishes "operations moved this truck" from "the yard forced
  this truck to move".
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

Ordered newest-first. `TRUCK_ARRIVING` is written from two independent paths —
`SimulationManager` itself, the tick a truck's status crosses into `ARRIVING`,
and the WMS feed's `TRAILER_STATUS_UPDATED` — so it fires whether a truck is
being driven by the simulation loop or reported on by an external system.

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

### Docking queue

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/yard/docking-queue` |

"Identify the trailer that needs to be docked for each arrival window"
(problem statement §4). Trucks that are `ARRIVING`/`ARRIVED`, or whose
appointment window opens within `ARRIVAL_HORIZON_MINUTES` **and has not yet
closed**, and that hold no committed door yet — grouped into buckets by
appointment window (`windowStart`/`windowEnd`, `null` for the `UNSCHEDULED`
bucket), sorted by window then priority then ETA. A window whose `windowEnd`
has already passed drops out of the queue rather than pinning a stuck truck in
it forever. Each entry carries only its **top** ranked dock recommendation (via
`recommendDocks`, side-effect free — this never writes a `RECOMMENDED` row).
The operator still presses assign; nothing here commits a door (§2).

Recommendations are fetched concurrently across a window's entries.
`topRecommendation` is `null` both when the scorer excludes every door (e.g. an
oversized load with no oversized door free — Scenario E) and, defensively, if
scoring that one truck fails for any reason — one bad entry never fails the
whole request.

```jsonc
{
  "data": {
    "generatedAt": "2026-08-27T17:00:00.000Z",
    "horizonMinutes": 120,
    "windows": [
      {
        "windowStart": "2026-08-27T18:05:00.000Z", "windowEnd": "2026-08-27T18:50:00.000Z",
        "entries": [
          { "truckId": "...", "truckReference": "TRK-112", "trailerId": "TRL-112",
            "status": "DELAYED", "eta": "...", "progress": 96.8,
            "shipmentReference": "SHP-1012", "priority": "LOW", "loadType": "GENERAL",
            "topRecommendation": { "dockId": "D3", "dockCode": "D3", "score": 88, "reasons": ["..."] } }
        ]
      }
    ]
  }
}
```

### Allocation summary

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/yard/allocation-summary` |

The trailer-to-door allocation summary (problem statement §7 output).
Committed (`ASSIGNED`) assignments only, plus every active truck holding none.
`chainedFrom` carries the assignment this one superseded — set only when the
truck arrived at its door through the reassignment chain (§10), otherwise
`null`.

```jsonc
{
  "data": {
    "generatedAt": "2026-08-27T17:00:00.000Z",
    "totals": {
      "allocatedTrailers": 3, "unallocatedTrailers": 8,
      "docksByStatus": { "AVAILABLE": 3, "RESERVED": 2, "OCCUPIED": 2, "UNAVAILABLE": 1 }
    },
    "allocations": [
      { "assignmentId": "DA-3006", "status": "ASSIGNED", "trailerId": "TRL-107",
        "truckId": "TRK-107", "truckReference": "TRK-107", "shipmentReference": "SHP-1007",
        "priority": "HIGH", "loadType": "GENERAL", "dockId": "D8", "dockCode": "D8", "zone": "SOUTH",
        "scheduledStart": "...", "scheduledEnd": "...", "chainedFrom": "DA-3005" }
    ],
    "unallocated": [
      { "truckId": "...", "truckReference": "TRK-102", "trailerId": "TRL-102",
        "status": "IN_TRANSIT", "shipmentReference": "SHP-1002", "priority": "MEDIUM" }
    ]
  }
}
```

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
| `GET` | `/api/v1/simulation/status` | The loop's own health — read-only, mutates nothing |
| `GET` | `/api/v1/simulation/state` | Live state for every simulated truck |
| `GET` | `/api/v1/simulation/trucks/:truckId` | One truck, by id or reference — including its current scenario |
| `POST` | `/api/v1/simulation/trucks/:truckId/delay` | Activate a delay scenario |
| `POST` | `/api/v1/simulation/trucks/:truckId/clear-delay` | Return the truck to normal speed |

The three lifecycle endpoints and `/status` all return the same shape — the
difference is only that `/status` mutates nothing, so a dashboard can poll it,
and it keeps answering after `beginShutdown()` has started 503ing non-GET
requests:

```json
{
  "data": {
    "running": true,
    "truckCount": 9,
    "tickMs": 2000,
    "lastTickAt": "2026-08-26T15:15:22.401Z",
    "lastTickError": null
  }
}
```

`lastTickAt` and `lastTickError` are the loop's health. A per-truck tick failure
is logged and swallowed so one bad truck cannot kill the interval, which would
otherwise make a wedged engine indistinguishable from a healthy one from
outside. `lastTickError` names the most recent failing truck and is cleared by
the first clean tick after it — it reads as "is it broken now", not "has it ever
been broken".

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

## WMS feed (Phase 9)

There is no real WMS. We simulate one: an external warehouse system pushing
operational facts at the backend over HTTP (§15). Ingestion drives the same
domain services every other phase writes through — the controller parses and
delegates, and all business logic lives in `WmsEventHandler`.

```text
POST /wms/events -> WMS Controller -> WmsEventHandler -> { SimulationManager,
                                                           DockService,
                                                           AlertService }
                                                      -> Prisma
                                                      -> Socket.IO
```

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/api/v1/wms/events` | one typed event (discriminated on `eventType`) |
| `POST` | `/api/v1/wms/simulate` | `{ "scenario"? }` — a deterministic scripted sequence |

**No new realtime events.** Ingestion reuses the seven in
[`realtime.md`](./realtime.md); a WMS message is a new *source*, not a new
contract.

**Trailer resolution.** `trailerId` accepts the WMS's own identifier
(`TRL-101`), the truck reference (`TRK-101`) or the row id — tried in that
order, 404 otherwise.

### `POST /api/v1/wms/events`

Six event types. Every one accepts an optional `occurredAt` (ISO 8601); the
backend still stamps its own clock on the rows it writes, so a feed with a
skewed clock cannot reorder the timeline.

```jsonc
// request — the shape from §15
{
  "eventType": "TRAILER_STATUS_UPDATED",
  "trailerId": "TRL-101",
  "status": "ARRIVING",
  "eta": "2026-08-27T18:40:00.000Z",
  "yardLocation": { "lat": 28.4, "lng": 77.2 }
}
```

```jsonc
// response
{
  "data": {
    "eventType": "TRAILER_STATUS_UPDATED",
    "applied": true,                       // false when the fact was already true
    "truckId": "TRK-101",
    "dockDoorId": null,
    "effects": ["TRK-101 IN_TRANSIT -> ARRIVING"],
    "emitted": ["TRUCK_STATUS_CHANGED", "ALERT_CREATED"],
    "alert": { "alertId": "...", "type": "TRUCK_ARRIVING", "severity": "INFO" /* ... */ }
  }
}
```

| `eventType` | Fields | What the backend does |
| --- | --- | --- |
| `TRAILER_LOCATION_UPDATED` | `trailerId`, `yardLocation{lat,lng}`, `progress?`, `speedKmph?` | Moves the truck. Emits `TRUCK_POSITION_UPDATED`. Writes **no** `LocationHistory` row. Send `progress` too for a truck under simulation — see below. |
| `TRAILER_STATUS_UPDATED` | `trailerId`, `status`, `eta?`, `yardLocation?` | Moves truck and shipment, snapshots the transition, raises one `TRUCK_ARRIVING` alert on entry to `ARRIVING`. |
| `TRAILER_ARRIVED` | `trailerId`, `yardLocation?` | `ARRIVED`, progress 100, speed 0, ETA and delay cleared, parked at the route destination. |
| `TRAILER_DOCKED` | `trailerId`, `dockCode` | Door → `OCCUPIED`, truck → `DOCKED`, shipment → `DOCKED`, one `LocationHistory(DOCKED)`. |
| `DOCK_STATUS_UPDATED` | `dockCode`, `status`, `reason?` | `OCCUPIED` / release; `AVAILABLE` and `UNAVAILABLE` delegate to the operator command and inherit the Phase 8 cascade. |
| `APPOINTMENT_UPDATED` | `appointmentReference`, `windowStart?`, `windowEnd?`, `expectedDurationMinutes?`, `notes?` | Moves the slot. Emits nothing. |

Notes on behaviour:

- **`status: "DELAYED"` and `status: "DOCKED"` are refused (400)** on
  `TRAILER_STATUS_UPDATED`. The delay scenarios own `DELAYED` because they also
  set `activeDelay`; accepting it here would produce a truck that is `DELAYED`
  with `activeDelay: NORMAL`. `TRAILER_DOCKED` owns `DOCKED` because it checks
  the truck actually holds that door and flips the door in the same
  transaction — setting it here would record a docked trailer against a door
  still reading `RESERVED`.
- **A truck with an active delay cannot be put back on the road (409).** Moving
  it to `IN_TRANSIT`/`ARRIVING` would leave `activeDelay: RAIN` and the reduced
  speed standing next to a normal-looking status. Clear it with
  `POST /api/v1/simulation/trucks/:truckId/clear-delay` first. Arriving is not
  blocked: the journey is over, so `TRAILER_ARRIVED` ends the scenario with it.
- **An arrival never moves a truck backwards.** `TRAILER_ARRIVED` for a trailer
  that is already `ARRIVED`, `DOCKED` or `COMPLETED` is a no-op
  (`applied: false`), so a retried or late message cannot restamp `arrivedAt`,
  pull the shipment back from `DOCKED` or reverse the truck's status while the
  door it is standing at stays `OCCUPIED`.
- **`status: "RESERVED"` is refused (400) on `DOCK_STATUS_UPDATED`.** That is the
  assignment engine's transition. `OCCUPIED` is the one status *only* this feed
  may write — a trailer has physically backed in.
- **`TRAILER_DOCKED` requires a committed assignment** on that door and answers
  `409` otherwise, naming the door the truck actually holds. The WMS reports
  physical reality; it does not create bookings the scoring engine never ranked.
  It also refuses a door that is out of service, for the same reason the
  `OCCUPIED` path does.
- **`DOCK_STATUS_UPDATED { status: "AVAILABLE" }` on an `OCCUPIED` door releases
  it** — completing whatever assignment was holding it, because a trailer
  leaving the bay is a departure. On any other door it is the operator's
  put-back-in-service command, which is a no-op unless the door is out of
  service.
- **Occupying a door that is out of service is refused (409).** Believing the
  feed there would clear a fault nobody fixed.
- **`APPOINTMENT_UPDATED` emits no realtime event.** §13 fixes the contract at
  seven events and the frontend can re-read a window. Its real effect is on the
  scoring engine — a moved slot re-ranks
  `GET /api/v1/trucks/:truckId/dock-recommendations` through `appointmentFit`.
  It is refused (400) if it changes nothing, or if the merged window would end
  at or before it starts.
- **Re-sending a fact that is already true is a success** with
  `applied: false` and no second alert — a feed that retries must not collect
  errors.
- **Send `progress` alongside `yardLocation` when the simulation is running.**
  The engine recomputes a moving truck's position from `progress` on its next
  tick, so a lat/lng with no progress is corrected away about two seconds later.
  With `progress` the update is a true resync — the engine picks up from the
  reported point. For a truck parked in the yard the position sticks either way.
- **`emitted` is reported by whoever emitted.** For a truck the engine is
  tracking, the list comes from the engine — including `TRUCK_ETA_UPDATED`,
  which it raises whenever a resync changes the arrival time.
- `404` for an unknown trailer, dock or appointment; `400` for an unknown
  `eventType` or a malformed payload, with the Zod issues in `error.details`.

### `POST /api/v1/wms/simulate`

Replays a fixed sequence through the same handler — there is no second code
path, so whatever the demo proves, the real endpoint does too. Deterministic by
name: no randomness anywhere (§25).

```jsonc
// request — body optional; defaults to TRAILER_ARRIVAL
{ "scenario": "TRAILER_ARRIVAL" }
```

| Scenario | Sequence | Ends with |
| --- | --- | --- |
| `TRAILER_ARRIVAL` (default) | `TRAILER_LOCATION_UPDATED` → `TRAILER_STATUS_UPDATED(ARRIVING)` → `TRAILER_ARRIVED` → `TRAILER_DOCKED(D2)` on `TRL-101` | `D2` `OCCUPIED`, `TRK-101` `DOCKED`, `SHP-1001` `DOCKED` |
| `DOCK_OCCUPANCY` | `D3` → `OCCUPIED` → `AVAILABLE` | `D3` back to `AVAILABLE` |
| `APPOINTMENT_SHIFT` | `APT-2001` pushed out 60 min | re-ranked dock recommendations for `TRK-101` |

```jsonc
// response — one step per event, in the order it was fed
{
  "data": {
    "scenario": "TRAILER_ARRIVAL",
    "steps": [
      { "eventType": "TRAILER_LOCATION_UPDATED", "ok": true, "result": { /* ... */ }, "error": null },
      { "eventType": "TRAILER_DOCKED", "ok": true, "result": { /* ... */ }, "error": null }
    ]
  }
}
```

A failing step is captured into its own entry and the run continues — a
half-finished demo that says which half failed beats one that stops silently.
`TRAILER_ARRIVAL` moves seeded demo rows, so **`pnpm db:seed` resets it**.

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

# --- Dock failure and automatic reassignment (Phase 8) ---

# Scenario D — take down the door TRK-101 is standing on. The *backend* picks D4.
curl -s -X PATCH http://localhost:4000/api/v1/docks/D2/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"UNAVAILABLE","reason":"Hydraulic fault"}' | jq '.data.reassignments'

# The chain it wrote: DA-3002 REASSIGNED -> a new ASSIGNED row on D4
curl -s 'http://localhost:4000/api/v1/dock-assignments?truckId=TRK-101' \
  | jq '.data[] | {id, dockDoorId, status, previousAssignmentId}'

# Scenario E — with D7 already down, dropping D4 too leaves the reefer nowhere to go
curl -s -X PATCH http://localhost:4000/api/v1/docks/D4/status \
  -H 'Content-Type: application/json' -d '{"status":"UNAVAILABLE"}' | jq '.data.reassignments'

curl -s 'http://localhost:4000/api/v1/alerts?type=NO_DOCK_AVAILABLE' | jq '.data[0]'

# Hand a door back to the yard
curl -s -X POST http://localhost:4000/api/v1/docks/D4/release | jq

# --- WMS feed (Phase 9) ---

# The scripted demo — TRL-101 arrives and backs into D2
curl -s -X POST http://localhost:4000/api/v1/wms/simulate \
  -H 'Content-Type: application/json' -d '{"scenario":"TRAILER_ARRIVAL"}' \
  | jq '.data.steps[] | {eventType, ok, effects: .result.effects}'

# D2 is now OCCUPIED, TRK-101 DOCKED
curl -s http://localhost:4000/api/v1/docks/D2 | jq '.data.status'
curl -s http://localhost:4000/api/v1/trucks/TRK-101 | jq '.data.status'

# One hand-sent event
curl -s -X POST http://localhost:4000/api/v1/wms/events \
  -H 'Content-Type: application/json' -d '{
    "eventType": "TRAILER_STATUS_UPDATED",
    "trailerId": "TRL-102",
    "status": "ARRIVING",
    "yardLocation": { "lat": 22.585, "lng": 88.409 }
  }' | jq '.data'

# The WMS-only transition, and releasing the bay again
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"DOCK_STATUS_UPDATED","dockCode":"D3","status":"OCCUPIED"}' | jq '.data.effects'
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"DOCK_STATUS_UPDATED","dockCode":"D3","status":"AVAILABLE"}' | jq '.data.effects'

# Scenario D through the feed: the backend still picks D4 itself
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"DOCK_STATUS_UPDATED","dockCode":"D2","status":"UNAVAILABLE","reason":"WMS: leveler fault"}' \
  | jq '{effects: .data.effects, emitted: .data.emitted}'

# Rejected: DELAYED (the delay endpoints own it), RESERVED (the engine owns it),
# an unknown trailer, and docking a door the truck was never assigned
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"TRAILER_STATUS_UPDATED","trailerId":"TRL-102","status":"DELAYED"}' | jq '.error'   # 400
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"TRAILER_STATUS_UPDATED","trailerId":"TRL-102","status":"DOCKED"}' | jq '.error'    # 400
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"TRAILER_STATUS_UPDATED","trailerId":"TRL-103","status":"IN_TRANSIT"}' | jq '.error' # 409 — clear the delay first
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"DOCK_STATUS_UPDATED","dockCode":"D3","status":"RESERVED"}' | jq '.error'           # 400
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"TRAILER_DOCKED","trailerId":"TRL-999","dockCode":"D2"}' | jq '.error'              # 404
curl -s -X POST http://localhost:4000/api/v1/wms/events -H 'Content-Type: application/json' \
  -d '{"eventType":"TRAILER_DOCKED","trailerId":"TRL-101","dockCode":"D3"}' | jq '.error'              # 409

# The scenario moves seeded demo rows — put them back
pnpm db:seed
```
