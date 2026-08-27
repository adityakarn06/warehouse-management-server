import type {
  AlertSeverity,
  AlertType,
  AssignmentStatus,
  DelayScenario,
  DockStatus,
  LoadType,
  Priority,
  ShipmentStatus,
  TruckStatus,
} from '../generated/prisma/enums.js';

/* ---------------------------------------------------------------- envelopes */

export interface ListMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiListEnvelope<T> {
  data: T[];
  meta: ListMeta;
}

/** Normalised `limit`/`offset` after Zod parsing. */
export interface Pagination {
  limit: number;
  offset: number;
}

/* ---------------------------------------------------------------- tracking */

export interface GeoPlace {
  name: string;
  latitude: number;
  longitude: number;
}

export interface CurrentPosition {
  latitude: number;
  longitude: number;
  lastUpdatedAt: string;
}

export interface AppointmentWindow {
  start: string;
  end: string;
  expectedDurationMinutes: number;
}

export interface AssignedDock {
  id: string;
  code: string;
  name: string;
  zone: string;
  status: DockStatus;
  assignmentStatus: AssignmentStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

/** Which identifier arm actually matched (§1 of the problem statement). */
export type TrackingResolvedBy =
  | 'TRACKING_NUMBER'
  | 'SHIPMENT_REFERENCE'
  | 'SHIPMENT_ID'
  | 'TRAILER_ID';

/**
 * Customer-facing tracking payload. Deliberately flat and hand-shaped — no raw
 * Prisma rows leak through this endpoint.
 */
export interface TrackingResponse {
  reference: string;
  trackingNumber: string;
  trailerId: string;
  resolvedBy: TrackingResolvedBy;
  customerName: string;
  status: ShipmentStatus;
  truckStatus: TruckStatus;
  activeDelay: DelayScenario;
  origin: GeoPlace;
  destination: GeoPlace;
  currentPosition: CurrentPosition;
  eta: string | null;
  progress: number;
  priority: Priority;
  loadType: LoadType;
  appointmentWindow: AppointmentWindow | null;
  assignedDock: AssignedDock | null;
}

/* ----------------------------------------------------------- yard overview */

export interface YardRouteSummary {
  id: string;
  code: string;
  name: string;
  originName: string;
  destinationName: string;
  distanceKm: number;
}

export interface YardShipmentSummary {
  id: string;
  reference: string;
  trackingNumber: string;
  priority: Priority;
  loadType: LoadType;
  status: ShipmentStatus;
}

export interface YardTruck {
  id: string;
  reference: string;
  trailerId: string;
  carrier: string;
  status: TruckStatus;
  activeDelay: DelayScenario;
  latitude: number;
  longitude: number;
  progress: number;
  speedKmph: number;
  eta: string | null;
  lastUpdatedAt: string;
  route: YardRouteSummary;
  shipment: YardShipmentSummary | null;
  assignedDockId: string | null;
}

export interface YardDockAssignment {
  id: string;
  status: AssignmentStatus;
  truckId: string;
  truckReference: string;
  shipmentReference: string | null;
  dockDoorId: string;
  dockCode: string;
  score: number | null;
  reasons: string[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  eta: string | null;
}

export interface YardDock {
  id: string;
  code: string;
  name: string;
  zone: string;
  status: DockStatus;
  supportedLoadTypes: LoadType[];
  unavailableReason: string | null;
  currentAssignment: YardDockAssignment | null;
}

export interface YardAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  truckId: string | null;
  shipmentId: string | null;
  dockDoorId: string | null;
  acknowledged: boolean;
  createdAt: string;
}

export interface YardSummary {
  activeTrucks: number;
  delayedTrucks: number;
  arrivingTrucks: number;
  dockedTrucks: number;
  docksAvailable: number;
  docksUnavailable: number;
  activeAssignments: number;
  unresolvedAlerts: number;
}

export interface YardOverview {
  generatedAt: string;
  summary: YardSummary;
  activeTrucks: YardTruck[];
  upcomingArrivals: YardTruck[];
  docks: YardDock[];
  activeAssignments: YardDockAssignment[];
  alerts: YardAlert[];
}

/* ------------------------------------------------------- docking queue */

export interface DockingQueueRecommendation {
  dockId: string;
  dockCode: string;
  score: number;
  reasons: string[];
}

export interface DockingQueueEntry {
  truckId: string;
  truckReference: string;
  trailerId: string;
  status: TruckStatus;
  eta: string | null;
  progress: number;
  shipmentReference: string | null;
  priority: Priority | null;
  loadType: LoadType | null;
  topRecommendation: DockingQueueRecommendation | null;
}

export interface DockingQueueWindow {
  /** `null` for the UNSCHEDULED bucket — trucks with no appointment. */
  windowStart: string | null;
  windowEnd: string | null;
  entries: DockingQueueEntry[];
}

export interface DockingQueueResponse {
  generatedAt: string;
  horizonMinutes: number;
  windows: DockingQueueWindow[];
}

/* -------------------------------------------------------- dock schedule */

export interface DockScheduleAssignment {
  id: string;
  status: AssignmentStatus;
  truckId: string;
  truckReference: string;
  trailerId: string;
  shipmentReference: string | null;
  priority: Priority | null;
  loadType: LoadType | null;
  score: number | null;
  reasons: string[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

export interface DockScheduleEntry {
  dockId: string;
  dockCode: string;
  dockName: string;
  zone: string;
  status: DockStatus;
  assignments: DockScheduleAssignment[];
}

export interface DockScheduleResponse {
  generatedAt: string;
  from: string;
  to: string;
  includeRecommended: boolean;
  docks: DockScheduleEntry[];
}

/* -------------------------------------------------- allocation summary */

export interface AllocationEntry {
  assignmentId: string;
  status: AssignmentStatus;
  trailerId: string;
  truckId: string;
  truckReference: string;
  shipmentReference: string | null;
  priority: Priority | null;
  loadType: LoadType | null;
  dockId: string;
  dockCode: string;
  zone: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  /** The assignment this one superseded, when it arrived via the reassignment chain. */
  chainedFrom: string | null;
}

export interface UnallocatedTrailer {
  truckId: string;
  truckReference: string;
  trailerId: string;
  status: TruckStatus;
  shipmentReference: string | null;
  priority: Priority | null;
}

export interface AllocationTotals {
  allocatedTrailers: number;
  unallocatedTrailers: number;
  docksByStatus: Record<DockStatus, number>;
}

export interface AllocationSummaryResponse {
  generatedAt: string;
  totals: AllocationTotals;
  allocations: AllocationEntry[];
  unallocated: UnallocatedTrailer[];
}

/* ------------------------------------------------------------------ fleet */

export interface FleetRouteSummary {
  id: string;
  code: string;
  name: string;
  originName: string;
  destinationName: string;
  distanceKm: number;
}

export interface FleetShipmentSummary {
  id: string;
  reference: string;
  trackingNumber: string;
  customerName: string;
  status: ShipmentStatus;
  priority: Priority;
  loadType: LoadType;
  weightKg: number | null;
  palletCount: number | null;
}

export interface FleetDockSummary {
  id: string;
  code: string;
  name: string;
  zone: string;
  assignmentId: string;
  assignmentStatus: AssignmentStatus;
}

export interface FleetTruck {
  id: string;
  reference: string;
  trailerId: string;
  carrier: string;
  driverName: string;
  driverPhone: string | null;
  status: TruckStatus;
  activeDelay: DelayScenario;
  progress: number;
  speedKmph: number;
  eta: string | null;
  lastUpdatedAt: string;
  route: FleetRouteSummary | null;
  shipment: FleetShipmentSummary | null;
  dock: FleetDockSummary | null;
}
