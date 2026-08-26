# E2 Backend — Socket.IO Realtime API (Phase 5)

Everything the frontend needs to consume live truck movement, alerts and dock
changes. The REST surface is documented separately in [`api.md`](./api.md).

```text
SimulationManager ──SimulationEvent──▶ RealtimeService ──▶ Socket.IO rooms
   (never imports socket.io)             (owns rooms)
```

Only `RealtimeService` (`src/websocket/realtime-service.ts`) talks to Socket.IO.
Domain code hands it a `RealtimeEvent` and the service decides which rooms see it.

---

## Connecting

```ts
import { io } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './websocket-contract';

const socket = io('http://localhost:4000', { transports: ['websocket'] });
```

| | |
| --- | --- |
| URL | `http://<host>:<port>` — the same origin as the REST API (one process, §3) |
| Path | `/socket.io` (the default) |
| Namespace | `/` (the default) — separation is by **room**, not namespace |
| CORS | governed by `CORS_ORIGIN`; `*` by default |
| Transport | WebSocket, with Socket.IO's usual polling fallback |

No authentication — the hackathon build has none anywhere (§27).

The typed contract lives in `src/websocket/events.ts`
(`ServerToClientEvents`, `ClientToServerEvents`, and every payload interface).
A TypeScript frontend can copy that file verbatim.

---

## Rooms

Nothing is broadcast to a socket that has not subscribed. There are three rooms
(§12), and a client may hold any combination of them:

| Room | Who joins it | What it carries |
| --- | --- | --- |
| `operations` | the operations dashboard | every operational event, for every truck and dock |
| `truck:{truckId}` | a client watching one truck | that truck's position / ETA / status / dock events and its alerts |
| `shipment:{shipmentId}` | a customer tracking client | the same, for the truck carrying that shipment |

Room names always use **canonical ids**. A client may subscribe with a human
reference (`TRK-101`, `SHP-1001`, `E2-TRACK-101`); the server resolves it and
the ack reports the room actually joined.

A socket in two rooms that both match an event still receives **one** copy —
`io.to([...rooms])` de-duplicates delivery.

---

## Client → server events

Every subscribe answers through the Socket.IO **ack callback**, carrying the
current state so a client can draw immediately instead of waiting up to a tick.

```ts
type SubscribeAck<T> =
  | { ok: true; room: string; data: T }
  | { ok: false; error: string };
```

| Event | Payload | Ack `data` |
| --- | --- | --- |
| `subscribe:operations` | — | `LiveTruckView[]` — every truck the loop is advancing |
| `subscribe:truck` | `{ truckId }` (id or reference) | `LiveTruckView` |
| `subscribe:shipment` | `{ shipmentId }` (id, reference or tracking number) | `{ shipmentId, truck: LiveTruckView \| null }` |
| `unsubscribe:operations` | — | `null` |
| `unsubscribe:truck` | `{ truckId }` | `null` |
| `unsubscribe:shipment` | `{ shipmentId }` | `null` |

Failures are acks, never disconnects: an unknown truck, an unknown shipment or a
malformed payload all come back as `{ ok: false, error }` on a socket that stays
open.

### Operations dashboard

```ts
socket.emit('subscribe:operations', (res) => {
  if (!res.ok) return console.error(res.error);
  res.data.forEach(drawTruck);      // 9 live trucks in the seeded demo
});
```

### Customer tracking

```ts
socket.emit('subscribe:shipment', { shipmentId: 'E2-TRACK-101' }, (res) => {
  if (!res.ok) return showNotFound(res.error);
  // res.room === 'shipment:SHP-1001'
  if (res.data.truck) drawTruck(res.data.truck);
});
```

### `LiveTruckWireView` (the snapshot shape)

```json
{
  "truckId": "TRK-101",
  "reference": "TRK-101",
  "routeId": "RTE-DEL-KOL-01",
  "shipmentId": "SHP-1001",
  "latitude": 24.92990926372086,
  "longitude": 84.06841,
  "progress": 62.0,
  "speedKmph": 58,
  "baseSpeedKmph": 58,
  "eta": "2026-08-27T00:58:11.954Z",
  "status": "IN_TRANSIT",
  "activeDelay": "NORMAL",
  "arrivedAt": null,
  "lastUpdatedAt": "2026-08-26T15:44:02.275Z",
  "sequenceNumber": 3
}
```

`speedKmph` is the truck's *effective* speed — `baseSpeedKmph` times the
multiplier for `activeDelay`. Clearing a delay restores `speedKmph` to
`baseSpeedKmph`.

Every timestamp is an ISO string, not a `Date` — the server serialises them
before they go into the ack. The same shape is served over REST by
`GET /api/v1/simulation/state`.

For a truck the loop is not advancing (`DOCKED`, `COMPLETED`, or the simulation
stopped) the snapshot is rebuilt from the database and `sequenceNumber` is `0`;
the `operations` snapshot falls back to the database the same way when the loop
has not loaded the fleet, so a dashboard never joins to an empty yard.

---

## Server → client events

Events are emitted **by name** — there is no `{ type, data }` envelope on the wire:

```ts
socket.on('TRUCK_POSITION_UPDATED', (data) => { /* data is TruckPositionPayload */ });
```

| Event | Rooms | Emitted since |
| --- | --- | --- |
| `TRUCK_POSITION_UPDATED` | `operations`, `truck:{id}`, `shipment:{id}` | Phase 5 |
| `TRUCK_ETA_UPDATED` | `operations`, `truck:{id}`, `shipment:{id}` | Phase 5 |
| `TRUCK_STATUS_CHANGED` | `operations`, `truck:{id}`, `shipment:{id}` | Phase 5 |
| `ALERT_CREATED` | `operations` + the truck/shipment it names | Phase 6 |
| `DOCK_STATUS_CHANGED` | `operations` | contract only — Phase 8 |
| `DOCK_ASSIGNED` | `operations`, `truck:{id}`, `shipment:{id}` | contract only — Phase 7 |
| `DOCK_REASSIGNED` | `operations`, `truck:{id}`, `shipment:{id}` | contract only — Phase 8 |

The last three are fully defined and routed today; no code path emits them yet, so
a frontend can wire the handlers now and see them light up in later phases.
`ALERT_CREATED` went live in Phase 6, when the delay commands became the first
thing to raise an alert.

Payloads carry ids and scalars only (§24) — never route geometry, never a full
database record.

### `TRUCK_POSITION_UPDATED`

One per moving truck per tick (~every 2 s; 9 trucks in the seeded demo).

| Field | Type | Notes |
| --- | --- | --- |
| `truckId` | `string` | canonical id |
| `reference` | `string` | `TRK-101` |
| `shipmentId` | `string \| null` | |
| `latitude` / `longitude` | `number` | the authoritative position **now** |
| `previousLatitude` / `previousLongitude` | `number?` | last tick's position; absent on the first update |
| `targetLatitude` / `targetLongitude` | `number` | where the truck is projected to be at the next tick |
| `progress` | `number` | 0–100 along the route |
| `speedKmph` | `number` | effective speed |
| `eta` | `string \| null` | absolute ISO instant |
| `status` | `TruckStatus` | `IN_TRANSIT \| DELAYED \| ARRIVING \| ...` |
| `serverTimestamp` | `string` | ISO, when the backend computed this |
| `sequenceNumber` | `number` | monotonic **per truck** |

```json
{
  "truckId": "TRK-101",
  "reference": "TRK-101",
  "shipmentId": "SHP-1001",
  "latitude": 24.92185, "longitude": 85.31402,
  "previousLatitude": 24.92198, "previousLongitude": 85.31418,
  "targetLatitude": 24.92172, "targetLongitude": 85.31386,
  "progress": 62.18175,
  "speedKmph": 58,
  "eta": "2026-08-27T00:58:11.954Z",
  "status": "IN_TRANSIT",
  "serverTimestamp": "2026-08-26T15:15:22.401Z",
  "sequenceNumber": 10
}
```

**Interpolation.** The backend is authoritative every ~2 s and the frontend fills
the gap (§4): animate from `latitude`/`longitude` toward `targetLatitude`/
`targetLongitude` over the tick interval, and use `previous*` to smooth a late or
dropped update. Never advance a truck's own progress on the client.

**Ordering.** `sequenceNumber` increases per truck. Drop any update whose
sequence is lower than the last one applied for that truck — but **re-baseline
that high-water mark from every snapshot you receive**, including the one you get
on re-subscribing after a reconnect. The counter is per-process bookkeeping: it
survives `POST /api/v1/simulation/reset`, but a server restart begins it again
from the database.

### `TRUCK_ETA_UPDATED`

Only when the ETA actually changed — a truck holding a constant speed keeps a
constant arrival *instant*, so what counts down is the time remaining, not the
timestamp. Silence here means the truck is on schedule.

```json
{
  "truckId": "TRK-101", "reference": "TRK-101", "shipmentId": "SHP-1001",
  "eta": "2026-08-27T01:22:40.100Z",
  "progress": 62.18175,
  "speedKmph": 38,
  "serverTimestamp": "2026-08-26T15:15:22.401Z",
  "sequenceNumber": 11
}
```

### `TRUCK_STATUS_CHANGED`

On a transition only, and it carries both sides of it.

```json
{
  "truckId": "TRK-101", "reference": "TRK-101", "shipmentId": "SHP-1001",
  "previousStatus": "IN_TRANSIT",
  "status": "DELAYED",
  "activeDelay": "RAIN",
  "progress": 66.7,
  "speedKmph": 37.7,
  "eta": "2026-08-27T05:35:28.817Z",
  "serverTimestamp": "2026-08-26T16:25:45.399Z",
  "sequenceNumber": 75
}
```

`activeDelay` is the scenario in force *after* the change, so a dashboard can
label the truck ("RAIN") from this event alone without re-reading it. A delayed
truck stays `DELAYED` past the 95% `ARRIVING` threshold, right up to `ARRIVED`.

### `ALERT_CREATED`

Raised by backend domain logic when something operationally meaningful happens.
Today that is a delay activation (Phase 6); Phases 7–8 add the dock cases.

```json
{
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
```

`type` is one of `TRUCK_DELAYED`, `DOCK_UNAVAILABLE`, `DOCK_REASSIGNMENT`,
`NO_DOCK_AVAILABLE`, `TRUCK_ARRIVING`; `severity` is `INFO`, `WARNING` or
`CRITICAL`. Alerts are pushed, never polled.

A delay activation emits `TRUCK_ETA_UPDATED`, then `TRUCK_STATUS_CHANGED`, then
`ALERT_CREATED`. Clearing a delay emits the first two only — there is no
"delay cleared" alert type. The persisted row is also readable at
`GET /api/v1/alerts?type=TRUCK_DELAYED`, and its `metadata` carries the scenario,
both speeds and the ETA shift in minutes.

### `DOCK_STATUS_CHANGED` *(contract only — Phase 8)*

Operations-room only; the affected truck learns about the consequences through the
`DOCK_REASSIGNED` and `ALERT_CREATED` that follow.

```json
{
  "dockDoorId": "D2",
  "code": "D2",
  "previousStatus": "AVAILABLE",
  "status": "UNAVAILABLE",
  "unavailableReason": "Hydraulic failure",
  "serverTimestamp": "2026-08-26T15:15:22.401Z"
}
```

### `DOCK_ASSIGNED` *(contract only — Phase 7)*

```json
{
  "assignmentId": "clx...",
  "truckId": "TRK-101",
  "shipmentId": "SHP-1001",
  "dockDoorId": "D2",
  "dockCode": "D2",
  "status": "ASSIGNED",
  "score": 91,
  "reasons": ["Compatible with refrigerated load", "Available before ETA"],
  "serverTimestamp": "2026-08-26T15:15:22.401Z"
}
```

### `DOCK_REASSIGNED` *(contract only — Phase 8)*

`DOCK_ASSIGNED` plus where the truck came from.

```json
{
  "assignmentId": "clx...",
  "previousAssignmentId": "clw...",
  "previousDockDoorId": "D2",
  "previousDockCode": "D2",
  "truckId": "TRK-101",
  "shipmentId": "SHP-1001",
  "dockDoorId": "D4",
  "dockCode": "D4",
  "status": "ASSIGNED",
  "score": 87,
  "reasons": ["D2 unavailable", "D4 compatible and free before ETA"],
  "serverTimestamp": "2026-08-26T15:15:22.401Z"
}
```

---

## Lifecycle notes

- Events flow only while the simulation loop is running. `POST /api/v1/simulation/stop`
  silences the feed without disconnecting anyone; `POST /api/v1/simulation/start`
  resumes it. Subscriptions survive both.
- Room membership is per socket and is dropped on disconnect. A reconnecting
  client must re-subscribe — and gets a fresh snapshot when it does.
- On shutdown the simulation stops first, then Socket.IO closes (§22), so no event
  is emitted over a closing server.

---

## Verifying it

With the server running (`pnpm dev`):

```bash
pnpm realtime:demo                                  # defaults: localhost:4000, TRK-101, 12s
pnpm realtime:demo --truck TRK-105 --seconds 20
```

`scripts/realtime-client.ts` connects two clients — one operations, one tracking a
single truck — prints both join snapshots, then reports per-client event counts,
the distinct trucks each saw, and the measured gap between position updates:

```text
[operations]
  position events : 54
  distinct trucks : 9 (TRK-101, TRK-102, ... TRK-112)
  cadence (TRK-101) : mean 2001ms, min 2001ms, max 2002ms over 5 gap(s)

[tracking TRK-101]
  position events : 6
  distinct trucks : 1 (TRK-101)

OK: the tracking client only ever saw TRK-101.
```

`tests/realtime.test.ts` covers the same guarantees without a database: room
routing, the simulation→sink seam, and an end-to-end socket test with two real
clients on an ephemeral port.
