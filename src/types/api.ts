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

/**
 * Customer-facing tracking payload. Deliberately flat and hand-shaped — no raw
 * Prisma rows leak through this endpoint.
 */
export interface TrackingResponse {
  reference: string;
  trackingNumber: string;
  trailerId: string;
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
