/**
 * E2: Where's My Truck? — deterministic demo seed.
 *
 * Every id is the human reference (TRK-101, D3, SHP-1001) so the frontend can
 * hit /api/v1/trucks/TRK-101 directly. Every timestamp is a fixed offset from
 * BASE (the top of the current hour), so the demo is identical on every run but
 * always sits around "now".
 *
 * Re-running is safe: all domain rows are deleted first, in FK-safe order.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  AlertSeverity,
  AlertType,
  AssignmentStatus,
  DelayScenario,
  DockStatus,
  LoadType,
  LocationSnapshotReason,
  Priority,
  ShipmentStatus,
  TruckStatus,
} from '../src/generated/prisma/enums.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

/** Top of the current hour. All demo timestamps are offsets from here. */
const BASE = (() => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d;
})();

const minutes = (n: number): Date => new Date(BASE.getTime() + n * 60_000);

/** Prisma's Json input type is structural; seed literals are known-good JSON. */
const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Geometry helpers (seed-only; the real route engine arrives in Phase 4)
// ---------------------------------------------------------------------------

interface Coordinate {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371;
const toRadians = (deg: number): number => (deg * Math.PI) / 180;

function haversineKm(a: Coordinate, b: Coordinate): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Point on the polyline at `progress` (0-100) of its total length. */
function pointAtProgress(geometry: Coordinate[], progress: number): Coordinate {
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  if (!first || !last) throw new Error('geometry must not be empty');

  const legs: number[] = [];
  let total = 0;
  for (let i = 1; i < geometry.length; i += 1) {
    const from = geometry[i - 1];
    const to = geometry[i];
    if (!from || !to) continue;
    const km = haversineKm(from, to);
    legs.push(km);
    total += km;
  }

  const clamped = Math.min(100, Math.max(0, progress));
  if (clamped <= 0 || total === 0) return first;
  if (clamped >= 100) return last;

  let remaining = (clamped / 100) * total;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i] ?? 0;
    const from = geometry[i];
    const to = geometry[i + 1];
    if (!from || !to) continue;

    if (remaining <= leg) {
      const t = leg === 0 ? 0 : remaining / leg;
      return {
        latitude: round5(from.latitude + (to.latitude - from.latitude) * t),
        longitude: round5(from.longitude + (to.longitude - from.longitude) * t),
      };
    }
    remaining -= leg;
  }

  return last;
}

const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

// ---------------------------------------------------------------------------
// Warehouse + routes
// ---------------------------------------------------------------------------

/** E2 Fulfilment Centre, Kolkata — the destination of every route. */
const WAREHOUSE: Coordinate = { latitude: 22.585, longitude: 88.41 };

interface RouteSeed {
  id: string;
  name: string;
  originName: string;
  distanceKm: number;
  estimatedDurationMinutes: number;
  averageSpeedKmph: number;
  geometry: Coordinate[];
}

const routes: RouteSeed[] = [
  {
    id: 'RTE-DEL-KOL-01',
    name: 'Delhi NCR → Kolkata (NH-19 corridor)',
    originName: 'Delhi NCR Hub, Delhi',
    distanceKm: 1490,
    estimatedDurationMinutes: 1740,
    averageSpeedKmph: 52,
    geometry: [
      { latitude: 28.6139, longitude: 77.209 }, // Delhi
      { latitude: 28.4089, longitude: 77.3178 }, // Faridabad
      { latitude: 27.4924, longitude: 77.6737 }, // Mathura
      { latitude: 27.1767, longitude: 78.0081 }, // Agra
      { latitude: 26.7855, longitude: 79.015 }, // Etawah
      { latitude: 26.4499, longitude: 80.3319 }, // Kanpur
      { latitude: 25.4358, longitude: 81.8463 }, // Prayagraj
      { latitude: 25.3176, longitude: 82.9739 }, // Varanasi
      { latitude: 24.9489, longitude: 84.0289 }, // Sasaram
      { latitude: 23.7957, longitude: 86.4304 }, // Dhanbad
      { latitude: 23.5204, longitude: 87.3119 }, // Durgapur
      WAREHOUSE,
    ],
  },
  {
    id: 'RTE-VNS-KOL-01',
    name: 'Varanasi → Kolkata (NH-19 east)',
    originName: 'Varanasi Cross-dock, Uttar Pradesh',
    distanceKm: 680,
    estimatedDurationMinutes: 780,
    averageSpeedKmph: 55,
    geometry: [
      { latitude: 25.3176, longitude: 82.9739 }, // Varanasi
      { latitude: 25.282, longitude: 83.12 }, // Mughalsarai
      { latitude: 24.9489, longitude: 84.0289 }, // Sasaram
      { latitude: 24.7521, longitude: 84.3742 }, // Aurangabad
      { latitude: 24.29, longitude: 85.42 }, // Barhi
      { latitude: 23.7957, longitude: 86.4304 }, // Dhanbad
      { latitude: 23.6739, longitude: 86.9524 }, // Asansol
      { latitude: 23.5204, longitude: 87.3119 }, // Durgapur
      { latitude: 23.2324, longitude: 87.8615 }, // Bardhaman
      WAREHOUSE,
    ],
  },
  {
    id: 'RTE-RAN-KOL-01',
    name: 'Ranchi → Kolkata (NH-33 / NH-19)',
    originName: 'Ranchi Depot, Jharkhand',
    distanceKm: 400,
    estimatedDurationMinutes: 450,
    averageSpeedKmph: 53,
    geometry: [
      { latitude: 23.3441, longitude: 85.3096 }, // Ranchi
      { latitude: 23.16, longitude: 85.59 }, // Bundu
      { latitude: 23.3321, longitude: 86.3652 }, // Purulia
      { latitude: 23.545, longitude: 86.67 }, // Raghunathpur
      { latitude: 23.6739, longitude: 86.9524 }, // Asansol
      { latitude: 23.5204, longitude: 87.3119 }, // Durgapur
      { latitude: 23.2324, longitude: 87.8615 }, // Bardhaman
      WAREHOUSE,
    ],
  },
];

const routeById = new Map(routes.map((route) => [route.id, route]));

// ---------------------------------------------------------------------------
// Dock doors
// ---------------------------------------------------------------------------

interface DockSeed {
  id: string;
  name: string;
  zone: string;
  status: DockStatus;
  supportedLoadTypes: LoadType[];
  latitude: number;
  longitude: number;
  availableFrom: Date | null;
  unavailableReason: string | null;
}

const docks: DockSeed[] = [
  {
    id: 'D1',
    name: 'Dock Door 1',
    zone: 'NORTH',
    status: DockStatus.OCCUPIED,
    supportedLoadTypes: [LoadType.GENERAL],
    latitude: 22.5858,
    longitude: 88.4092,
    availableFrom: minutes(15),
    unavailableReason: null,
  },
  {
    id: 'D2',
    name: 'Dock Door 2 (reefer)',
    zone: 'NORTH',
    status: DockStatus.RESERVED,
    supportedLoadTypes: [LoadType.REFRIGERATED, LoadType.GENERAL],
    latitude: 22.5857,
    longitude: 88.4096,
    availableFrom: null,
    unavailableReason: null,
  },
  {
    id: 'D3',
    name: 'Dock Door 3',
    zone: 'NORTH',
    status: DockStatus.AVAILABLE,
    supportedLoadTypes: [LoadType.GENERAL],
    latitude: 22.5856,
    longitude: 88.41,
    availableFrom: null,
    unavailableReason: null,
  },
  {
    id: 'D4',
    name: 'Dock Door 4 (reefer)',
    zone: 'NORTH',
    status: DockStatus.AVAILABLE,
    supportedLoadTypes: [LoadType.REFRIGERATED, LoadType.GENERAL],
    latitude: 22.5855,
    longitude: 88.4104,
    availableFrom: null,
    unavailableReason: null,
  },
  {
    id: 'D5',
    name: 'Dock Door 5 (hazmat)',
    zone: 'SOUTH',
    status: DockStatus.AVAILABLE,
    supportedLoadTypes: [LoadType.HAZARDOUS, LoadType.GENERAL],
    latitude: 22.5842,
    longitude: 88.4092,
    availableFrom: null,
    unavailableReason: null,
  },
  {
    // The only oversized-capable door, and it is busy — this is what makes the
    // NO_DOCK_AVAILABLE demo (Scenario E) reachable for SHP-1009.
    id: 'D6',
    name: 'Dock Door 6 (oversized)',
    zone: 'SOUTH',
    status: DockStatus.OCCUPIED,
    supportedLoadTypes: [LoadType.OVERSIZED, LoadType.GENERAL],
    latitude: 22.5841,
    longitude: 88.4096,
    availableFrom: minutes(90),
    unavailableReason: null,
  },
  {
    id: 'D7',
    name: 'Dock Door 7',
    zone: 'SOUTH',
    status: DockStatus.UNAVAILABLE,
    supportedLoadTypes: [LoadType.GENERAL, LoadType.REFRIGERATED],
    latitude: 22.584,
    longitude: 88.41,
    availableFrom: null,
    unavailableReason: 'Hydraulic leveler under maintenance',
  },
  {
    id: 'D8',
    name: 'Dock Door 8',
    zone: 'SOUTH',
    status: DockStatus.RESERVED,
    supportedLoadTypes: [LoadType.GENERAL],
    latitude: 22.5839,
    longitude: 88.4104,
    availableFrom: null,
    unavailableReason: null,
  },
];

// ---------------------------------------------------------------------------
// Trucks
// ---------------------------------------------------------------------------

interface TruckSeed {
  id: string;
  trailerId: string;
  driverName: string;
  driverPhone: string;
  carrier: string;
  routeId: string;
  status: TruckStatus;
  activeDelay: DelayScenario;
  progress: number;
  speedKmph: number;
  etaOffsetMinutes: number | null;
  departedOffsetMinutes: number;
  arrivedOffsetMinutes: number | null;
}

const trucks: TruckSeed[] = [
  {
    id: 'TRK-101',
    trailerId: 'TRL-101',
    driverName: 'Rajesh Kumar',
    driverPhone: '+91 98100 11201',
    carrier: 'Northline Freight',
    routeId: 'RTE-DEL-KOL-01',
    status: TruckStatus.IN_TRANSIT,
    activeDelay: DelayScenario.NORMAL,
    progress: 62,
    speedKmph: 58,
    etaOffsetMinutes: 55,
    departedOffsetMinutes: -1020,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-102',
    trailerId: 'TRL-102',
    driverName: 'Imran Sheikh',
    driverPhone: '+91 98300 11202',
    carrier: 'Ganges Logistics',
    routeId: 'RTE-VNS-KOL-01',
    status: TruckStatus.IN_TRANSIT,
    activeDelay: DelayScenario.NORMAL,
    progress: 41,
    speedKmph: 62,
    etaOffsetMinutes: 240,
    departedOffsetMinutes: -320,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-103',
    trailerId: 'TRL-103',
    driverName: 'Sunil Yadav',
    driverPhone: '+91 98110 11203',
    carrier: 'Northline Freight',
    routeId: 'RTE-DEL-KOL-01',
    status: TruckStatus.DELAYED,
    activeDelay: DelayScenario.RAIN,
    progress: 28,
    speedKmph: 39,
    etaOffsetMinutes: 690,
    departedOffsetMinutes: -540,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-104',
    trailerId: 'TRL-104',
    driverName: 'Pradeep Mahto',
    driverPhone: '+91 94310 11204',
    carrier: 'Jharkhand Carriers',
    routeId: 'RTE-RAN-KOL-01',
    status: TruckStatus.ARRIVING,
    activeDelay: DelayScenario.NORMAL,
    progress: 94,
    speedKmph: 46,
    etaOffsetMinutes: 18,
    departedOffsetMinutes: -420,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-105',
    trailerId: 'TRL-105',
    driverName: 'Anil Oraon',
    driverPhone: '+91 94320 11205',
    carrier: 'Jharkhand Carriers',
    routeId: 'RTE-RAN-KOL-01',
    status: TruckStatus.IN_TRANSIT,
    activeDelay: DelayScenario.NORMAL,
    progress: 55,
    speedKmph: 64,
    etaOffsetMinutes: 165,
    departedOffsetMinutes: -250,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-106',
    trailerId: 'TRL-106',
    driverName: 'Mohammed Alam',
    driverPhone: '+91 98301 11206',
    carrier: 'Ganges Logistics',
    routeId: 'RTE-VNS-KOL-01',
    status: TruckStatus.DELAYED,
    activeDelay: DelayScenario.TRAFFIC,
    progress: 66,
    speedKmph: 27,
    etaOffsetMinutes: 300,
    departedOffsetMinutes: -600,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-107',
    trailerId: 'TRL-107',
    driverName: 'Bikash Ghosh',
    driverPhone: '+91 98311 11207',
    carrier: 'Bengal Roadways',
    routeId: 'RTE-DEL-KOL-01',
    status: TruckStatus.ARRIVING,
    activeDelay: DelayScenario.NORMAL,
    progress: 96,
    speedKmph: 44,
    etaOffsetMinutes: 12,
    departedOffsetMinutes: -1680,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-108',
    trailerId: 'TRL-108',
    driverName: 'Ravi Shankar Tiwari',
    driverPhone: '+91 98120 11208',
    carrier: 'Ganges Logistics',
    routeId: 'RTE-VNS-KOL-01',
    status: TruckStatus.IN_TRANSIT,
    activeDelay: DelayScenario.NORMAL,
    progress: 18,
    speedKmph: 66,
    etaOffsetMinutes: 585,
    departedOffsetMinutes: -140,
    arrivedOffsetMinutes: null,
  },
  {
    id: 'TRK-109',
    trailerId: 'TRL-109',
    driverName: 'Debashis Mondal',
    driverPhone: '+91 98312 11209',
    carrier: 'Bengal Roadways',
    routeId: 'RTE-RAN-KOL-01',
    status: TruckStatus.ARRIVED,
    activeDelay: DelayScenario.NORMAL,
    progress: 100,
    speedKmph: 0,
    etaOffsetMinutes: -10,
    departedOffsetMinutes: -470,
    arrivedOffsetMinutes: -10,
  },
  {
    id: 'TRK-110',
    trailerId: 'TRL-110',
    driverName: 'Harpreet Singh',
    driverPhone: '+91 98101 11210',
    carrier: 'Northline Freight',
    routeId: 'RTE-DEL-KOL-01',
    status: TruckStatus.DOCKED,
    activeDelay: DelayScenario.NORMAL,
    progress: 100,
    speedKmph: 0,
    etaOffsetMinutes: -45,
    departedOffsetMinutes: -1800,
    arrivedOffsetMinutes: -45,
  },
  {
    id: 'TRK-111',
    trailerId: 'TRL-111',
    driverName: 'Sanjay Verma',
    driverPhone: '+91 98302 11211',
    carrier: 'Ganges Logistics',
    routeId: 'RTE-VNS-KOL-01',
    status: TruckStatus.COMPLETED,
    activeDelay: DelayScenario.NORMAL,
    progress: 100,
    speedKmph: 0,
    etaOffsetMinutes: -190,
    departedOffsetMinutes: -960,
    arrivedOffsetMinutes: -190,
  },
  {
    id: 'TRK-112',
    trailerId: 'TRL-112',
    driverName: 'Kartik Bera',
    driverPhone: '+91 94321 11212',
    carrier: 'Jharkhand Carriers',
    routeId: 'RTE-RAN-KOL-01',
    status: TruckStatus.IN_TRANSIT,
    activeDelay: DelayScenario.NORMAL,
    progress: 73,
    speedKmph: 60,
    etaOffsetMinutes: 95,
    departedOffsetMinutes: -330,
    arrivedOffsetMinutes: null,
  },
];

// ---------------------------------------------------------------------------
// Shipments (1 per truck) + appointments (1 per shipment)
// ---------------------------------------------------------------------------

interface ShipmentSeed {
  id: string;
  trackingNumber: string;
  truckId: string;
  customerName: string;
  status: ShipmentStatus;
  priority: Priority;
  loadType: LoadType;
  weightKg: number;
  palletCount: number;
  description: string;
  appointmentId: string;
  windowStartOffsetMinutes: number;
  windowEndOffsetMinutes: number;
  expectedDurationMinutes: number;
  appointmentNotes: string;
}

const shipments: ShipmentSeed[] = [
  {
    id: 'SHP-1001',
    trackingNumber: 'E2-TRACK-101',
    truckId: 'TRK-101',
    customerName: 'FreshMart Retail Pvt Ltd',
    status: ShipmentStatus.IN_TRANSIT,
    priority: Priority.HIGH,
    loadType: LoadType.REFRIGERATED,
    weightKg: 14200,
    palletCount: 22,
    description: 'Chilled dairy and ready-to-eat, 2-8°C',
    appointmentId: 'APT-2001',
    windowStartOffsetMinutes: 45,
    windowEndOffsetMinutes: 105,
    expectedDurationMinutes: 60,
    appointmentNotes: 'Reefer bay required; pre-cool before doors open',
  },
  {
    id: 'SHP-1002',
    trackingNumber: 'E2-TRACK-102',
    truckId: 'TRK-102',
    customerName: 'Sundaram Home Appliances',
    status: ShipmentStatus.IN_TRANSIT,
    priority: Priority.MEDIUM,
    loadType: LoadType.GENERAL,
    weightKg: 9800,
    palletCount: 18,
    description: 'Small kitchen appliances, palletised',
    appointmentId: 'APT-2002',
    windowStartOffsetMinutes: 240,
    windowEndOffsetMinutes: 300,
    expectedDurationMinutes: 45,
    appointmentNotes: '',
  },
  {
    id: 'SHP-1003',
    trackingNumber: 'E2-TRACK-103',
    truckId: 'TRK-103',
    customerName: 'Medicare Distribution',
    status: ShipmentStatus.DELAYED,
    priority: Priority.CRITICAL,
    loadType: LoadType.REFRIGERATED,
    weightKg: 6400,
    palletCount: 10,
    description: 'Vaccine cold chain, 2-8°C, temperature logged',
    appointmentId: 'APT-2003',
    windowStartOffsetMinutes: 660,
    windowEndOffsetMinutes: 720,
    expectedDurationMinutes: 60,
    appointmentNotes: 'Escalate to duty manager if window is missed',
  },
  {
    id: 'SHP-1004',
    trackingNumber: 'E2-TRACK-104',
    truckId: 'TRK-104',
    customerName: 'Eastern Chemicals Ltd',
    status: ShipmentStatus.ARRIVING,
    priority: Priority.HIGH,
    loadType: LoadType.HAZARDOUS,
    weightKg: 11500,
    palletCount: 14,
    description: 'Class 3 flammable solvents, drummed',
    appointmentId: 'APT-2004',
    windowStartOffsetMinutes: 15,
    windowEndOffsetMinutes: 75,
    expectedDurationMinutes: 90,
    appointmentNotes: 'Hazmat handler must sign off before unloading',
  },
  {
    id: 'SHP-1005',
    trackingNumber: 'E2-TRACK-105',
    truckId: 'TRK-105',
    customerName: 'Bharat Stationery Wholesale',
    status: ShipmentStatus.IN_TRANSIT,
    priority: Priority.LOW,
    loadType: LoadType.GENERAL,
    weightKg: 7300,
    palletCount: 16,
    description: 'Paper goods and office supplies',
    appointmentId: 'APT-2005',
    windowStartOffsetMinutes: 165,
    windowEndOffsetMinutes: 240,
    expectedDurationMinutes: 30,
    appointmentNotes: '',
  },
  {
    id: 'SHP-1006',
    trackingNumber: 'E2-TRACK-106',
    truckId: 'TRK-106',
    customerName: 'Kalinga Wind Energy',
    status: ShipmentStatus.DELAYED,
    priority: Priority.MEDIUM,
    loadType: LoadType.OVERSIZED,
    weightKg: 21000,
    palletCount: 4,
    description: 'Turbine nacelle housing, over-width',
    appointmentId: 'APT-2006',
    windowStartOffsetMinutes: 300,
    windowEndOffsetMinutes: 420,
    expectedDurationMinutes: 90,
    appointmentNotes: 'Requires oversized bay and spotter',
  },
  {
    id: 'SHP-1007',
    trackingNumber: 'E2-TRACK-107',
    truckId: 'TRK-107',
    customerName: 'Metro Apparel Group',
    status: ShipmentStatus.ARRIVING,
    priority: Priority.HIGH,
    loadType: LoadType.GENERAL,
    weightKg: 8600,
    palletCount: 20,
    description: 'Seasonal apparel, hanging garment racks',
    appointmentId: 'APT-2007',
    windowStartOffsetMinutes: 10,
    windowEndOffsetMinutes: 70,
    expectedDurationMinutes: 45,
    appointmentNotes: 'Store-ready cartons; scan at door',
  },
  {
    id: 'SHP-1008',
    trackingNumber: 'E2-TRACK-108',
    truckId: 'TRK-108',
    customerName: 'FreshMart Retail Pvt Ltd',
    status: ShipmentStatus.IN_TRANSIT,
    priority: Priority.MEDIUM,
    loadType: LoadType.REFRIGERATED,
    weightKg: 12900,
    palletCount: 21,
    description: 'Frozen ready meals, -18°C',
    appointmentId: 'APT-2008',
    windowStartOffsetMinutes: 585,
    windowEndOffsetMinutes: 660,
    expectedDurationMinutes: 60,
    appointmentNotes: '',
  },
  {
    id: 'SHP-1009',
    trackingNumber: 'E2-TRACK-109',
    truckId: 'TRK-109',
    customerName: 'Coastal Marine Engineering',
    status: ShipmentStatus.ARRIVED,
    priority: Priority.CRITICAL,
    loadType: LoadType.OVERSIZED,
    weightKg: 24500,
    palletCount: 3,
    description: 'Propeller shaft assembly, over-length',
    appointmentId: 'APT-2009',
    windowStartOffsetMinutes: -30,
    windowEndOffsetMinutes: 30,
    expectedDurationMinutes: 90,
    appointmentNotes: 'Waiting in yard — no oversized door free',
  },
  {
    id: 'SHP-1010',
    trackingNumber: 'E2-TRACK-110',
    truckId: 'TRK-110',
    customerName: 'Sundaram Home Appliances',
    status: ShipmentStatus.DOCKED,
    priority: Priority.MEDIUM,
    loadType: LoadType.GENERAL,
    weightKg: 10400,
    palletCount: 19,
    description: 'Mixed white goods, floor-loaded',
    appointmentId: 'APT-2010',
    windowStartOffsetMinutes: -30,
    windowEndOffsetMinutes: 15,
    expectedDurationMinutes: 45,
    appointmentNotes: '',
  },
  {
    id: 'SHP-1011',
    trackingNumber: 'E2-TRACK-111',
    truckId: 'TRK-111',
    customerName: 'Bharat Stationery Wholesale',
    status: ShipmentStatus.DELIVERED,
    priority: Priority.LOW,
    loadType: LoadType.GENERAL,
    weightKg: 5600,
    palletCount: 12,
    description: 'Bulk printing paper',
    appointmentId: 'APT-2011',
    windowStartOffsetMinutes: -180,
    windowEndOffsetMinutes: -120,
    expectedDurationMinutes: 30,
    appointmentNotes: 'Completed earlier today',
  },
  {
    id: 'SHP-1012',
    trackingNumber: 'E2-TRACK-112',
    truckId: 'TRK-112',
    customerName: 'Eastern Chemicals Ltd',
    status: ShipmentStatus.IN_TRANSIT,
    priority: Priority.LOW,
    loadType: LoadType.HAZARDOUS,
    weightKg: 9100,
    palletCount: 11,
    description: 'Class 8 corrosives, IBC totes',
    appointmentId: 'APT-2012',
    windowStartOffsetMinutes: 95,
    windowEndOffsetMinutes: 180,
    expectedDurationMinutes: 90,
    appointmentNotes: 'Hazmat paperwork pre-cleared',
  },
];

// ---------------------------------------------------------------------------
// Dock assignments
// ---------------------------------------------------------------------------

interface AssignmentSeed {
  id: string;
  truckId: string;
  shipmentId: string;
  dockDoorId: string;
  status: AssignmentStatus;
  score: number;
  reasons: string[];
  scheduledStartOffsetMinutes: number;
  scheduledEndOffsetMinutes: number;
  assignedOffsetMinutes: number | null;
  releasedOffsetMinutes: number | null;
  reassignedOffsetMinutes: number | null;
  previousAssignmentId: string | null;
}

const assignments: AssignmentSeed[] = [
  {
    // Backs D1 = OCCUPIED.
    id: 'DA-3001',
    truckId: 'TRK-110',
    shipmentId: 'SHP-1010',
    dockDoorId: 'D1',
    status: AssignmentStatus.ASSIGNED,
    score: 88,
    reasons: [
      'Compatible with general load',
      'Door free at arrival time',
      'Fits appointment window',
    ],
    scheduledStartOffsetMinutes: -30,
    scheduledEndOffsetMinutes: 15,
    assignedOffsetMinutes: -55,
    releasedOffsetMinutes: null,
    reassignedOffsetMinutes: null,
    previousAssignmentId: null,
  },
  {
    // Backs D2 = RESERVED. This is the Scenario D target (D2 → D4).
    id: 'DA-3002',
    truckId: 'TRK-101',
    shipmentId: 'SHP-1001',
    dockDoorId: 'D2',
    status: AssignmentStatus.ASSIGNED,
    score: 93,
    reasons: [
      'Compatible with refrigerated load',
      'Available before ETA',
      'Fits appointment window',
      'Suitable for high-priority shipment',
    ],
    scheduledStartOffsetMinutes: 45,
    scheduledEndOffsetMinutes: 105,
    assignedOffsetMinutes: -70,
    releasedOffsetMinutes: null,
    reassignedOffsetMinutes: null,
    previousAssignmentId: null,
  },
  {
    id: 'DA-3003',
    truckId: 'TRK-111',
    shipmentId: 'SHP-1011',
    dockDoorId: 'D3',
    status: AssignmentStatus.COMPLETED,
    score: 79,
    reasons: ['Compatible with general load', 'Fits appointment window'],
    scheduledStartOffsetMinutes: -180,
    scheduledEndOffsetMinutes: -150,
    assignedOffsetMinutes: -200,
    releasedOffsetMinutes: -145,
    reassignedOffsetMinutes: null,
    previousAssignmentId: null,
  },
  {
    id: 'DA-3004',
    truckId: 'TRK-104',
    shipmentId: 'SHP-1004',
    dockDoorId: 'D5',
    status: AssignmentStatus.RECOMMENDED,
    score: 84,
    reasons: [
      'Only door certified for hazardous load',
      'Available before ETA',
      'Suitable for high-priority shipment',
    ],
    scheduledStartOffsetMinutes: 20,
    scheduledEndOffsetMinutes: 110,
    assignedOffsetMinutes: null,
    releasedOffsetMinutes: null,
    reassignedOffsetMinutes: null,
    previousAssignmentId: null,
  },
  {
    // Superseded when D7 went out of service.
    id: 'DA-3005',
    truckId: 'TRK-107',
    shipmentId: 'SHP-1007',
    dockDoorId: 'D7',
    status: AssignmentStatus.REASSIGNED,
    score: 81,
    reasons: ['Compatible with general load', 'Fits appointment window'],
    scheduledStartOffsetMinutes: 10,
    scheduledEndOffsetMinutes: 55,
    assignedOffsetMinutes: -95,
    releasedOffsetMinutes: null,
    reassignedOffsetMinutes: -15,
    previousAssignmentId: null,
  },
  {
    // Replacement for DA-3005; backs D8 = RESERVED.
    id: 'DA-3006',
    truckId: 'TRK-107',
    shipmentId: 'SHP-1007',
    dockDoorId: 'D8',
    status: AssignmentStatus.ASSIGNED,
    score: 90,
    reasons: [
      'Compatible with general load',
      'Available before ETA',
      'Fits appointment window',
      'Nearest free door to original assignment',
    ],
    scheduledStartOffsetMinutes: 10,
    scheduledEndOffsetMinutes: 55,
    assignedOffsetMinutes: -15,
    releasedOffsetMinutes: null,
    reassignedOffsetMinutes: null,
    previousAssignmentId: 'DA-3005',
  },
];

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

interface AlertSeed {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  truckId: string | null;
  shipmentId: string | null;
  dockDoorId: string | null;
  metadata: Record<string, unknown>;
  acknowledged: boolean;
  acknowledgedOffsetMinutes: number | null;
  createdOffsetMinutes: number;
}

const alerts: AlertSeed[] = [
  {
    id: 'AL-4001',
    type: AlertType.TRUCK_DELAYED,
    severity: AlertSeverity.WARNING,
    title: 'TRK-103 delayed by rain',
    message: 'Heavy rain on the NH-19 corridor. Effective speed reduced to 39 km/h.',
    truckId: 'TRK-103',
    shipmentId: 'SHP-1003',
    dockDoorId: null,
    metadata: { delayType: 'RAIN', speedKmph: 39, etaShiftMinutes: 210 },
    acknowledged: false,
    acknowledgedOffsetMinutes: null,
    createdOffsetMinutes: -35,
  },
  {
    id: 'AL-4002',
    type: AlertType.TRUCK_DELAYED,
    severity: AlertSeverity.CRITICAL,
    title: 'TRK-106 held in traffic',
    message: 'Congestion near Durgapur. Oversized load ETA slipped past its appointment window.',
    truckId: 'TRK-106',
    shipmentId: 'SHP-1006',
    dockDoorId: null,
    metadata: { delayType: 'TRAFFIC', speedKmph: 27, etaShiftMinutes: 165 },
    acknowledged: false,
    acknowledgedOffsetMinutes: null,
    createdOffsetMinutes: -20,
  },
  {
    id: 'AL-4003',
    type: AlertType.DOCK_UNAVAILABLE,
    severity: AlertSeverity.WARNING,
    title: 'Dock D7 out of service',
    message: 'D7 marked unavailable: hydraulic leveler under maintenance.',
    truckId: null,
    shipmentId: null,
    dockDoorId: 'D7',
    metadata: { reason: 'Hydraulic leveler under maintenance', affectedAssignments: ['DA-3005'] },
    acknowledged: true,
    acknowledgedOffsetMinutes: -16,
    createdOffsetMinutes: -18,
  },
  {
    id: 'AL-4004',
    type: AlertType.DOCK_REASSIGNMENT,
    severity: AlertSeverity.INFO,
    title: 'TRK-107 reassigned D7 → D8',
    message: 'D7 went out of service. TRK-107 was automatically reassigned to D8 (score 90).',
    truckId: 'TRK-107',
    shipmentId: 'SHP-1007',
    dockDoorId: 'D8',
    metadata: {
      previousDockDoorId: 'D7',
      newDockDoorId: 'D8',
      previousAssignmentId: 'DA-3005',
      newAssignmentId: 'DA-3006',
      score: 90,
    },
    acknowledged: false,
    acknowledgedOffsetMinutes: null,
    createdOffsetMinutes: -15,
  },
  {
    id: 'AL-4005',
    type: AlertType.NO_DOCK_AVAILABLE,
    severity: AlertSeverity.CRITICAL,
    title: 'No dock available for TRK-109',
    message: 'SHP-1009 is oversized. D6 is the only oversized-capable door and it is occupied.',
    truckId: 'TRK-109',
    shipmentId: 'SHP-1009',
    dockDoorId: null,
    metadata: { loadType: 'OVERSIZED', candidateDocks: ['D6'], blockedBy: 'OCCUPIED' },
    acknowledged: false,
    acknowledgedOffsetMinutes: null,
    createdOffsetMinutes: -8,
  },
  {
    id: 'AL-4006',
    type: AlertType.TRUCK_ARRIVING,
    severity: AlertSeverity.INFO,
    title: 'TRK-104 arriving in ~18 min',
    message: 'Hazardous load inbound for D5. Ensure hazmat handler is on the floor.',
    truckId: 'TRK-104',
    shipmentId: 'SHP-1004',
    dockDoorId: 'D5',
    metadata: { etaMinutes: 18, progress: 94 },
    acknowledged: false,
    acknowledgedOffsetMinutes: null,
    createdOffsetMinutes: -5,
  },
  {
    id: 'AL-4007',
    type: AlertType.TRUCK_ARRIVING,
    severity: AlertSeverity.INFO,
    title: 'TRK-107 arriving in ~12 min',
    message: 'Inbound to D8 after reassignment from D7.',
    truckId: 'TRK-107',
    shipmentId: 'SHP-1007',
    dockDoorId: 'D8',
    metadata: { etaMinutes: 12, progress: 96 },
    acknowledged: true,
    acknowledgedOffsetMinutes: -2,
    createdOffsetMinutes: -3,
  },
];

// ---------------------------------------------------------------------------
// Location history — meaningful snapshots only, never a per-tick log.
// ---------------------------------------------------------------------------

interface LocationSeed {
  truckId: string;
  progress: number;
  speedKmph: number;
  status: TruckStatus;
  reason: LocationSnapshotReason;
  etaOffsetMinutes: number | null;
  recordedOffsetMinutes: number;
}

const locationHistory: LocationSeed[] = [
  {
    truckId: 'TRK-101',
    progress: 0,
    speedKmph: 55,
    status: TruckStatus.IN_TRANSIT,
    reason: LocationSnapshotReason.DEPARTURE,
    etaOffsetMinutes: 120,
    recordedOffsetMinutes: -1020,
  },
  {
    truckId: 'TRK-101',
    progress: 35,
    speedKmph: 60,
    status: TruckStatus.IN_TRANSIT,
    reason: LocationSnapshotReason.PERIODIC,
    etaOffsetMinutes: 90,
    recordedOffsetMinutes: -420,
  },
  {
    truckId: 'TRK-101',
    progress: 62,
    speedKmph: 58,
    status: TruckStatus.IN_TRANSIT,
    reason: LocationSnapshotReason.PERIODIC,
    etaOffsetMinutes: 55,
    recordedOffsetMinutes: -10,
  },
  {
    truckId: 'TRK-103',
    progress: 0,
    speedKmph: 60,
    status: TruckStatus.IN_TRANSIT,
    reason: LocationSnapshotReason.DEPARTURE,
    etaOffsetMinutes: 480,
    recordedOffsetMinutes: -540,
  },
  {
    truckId: 'TRK-103',
    progress: 28,
    speedKmph: 39,
    status: TruckStatus.DELAYED,
    reason: LocationSnapshotReason.DELAY_ACTIVATED,
    etaOffsetMinutes: 690,
    recordedOffsetMinutes: -35,
  },
  {
    truckId: 'TRK-107',
    progress: 0,
    speedKmph: 58,
    status: TruckStatus.IN_TRANSIT,
    reason: LocationSnapshotReason.DEPARTURE,
    etaOffsetMinutes: 60,
    recordedOffsetMinutes: -1680,
  },
  {
    truckId: 'TRK-107',
    progress: 74,
    speedKmph: 56,
    status: TruckStatus.IN_TRANSIT,
    reason: LocationSnapshotReason.PERIODIC,
    etaOffsetMinutes: 150,
    recordedOffsetMinutes: -240,
  },
  {
    truckId: 'TRK-107',
    progress: 96,
    speedKmph: 44,
    status: TruckStatus.ARRIVING,
    reason: LocationSnapshotReason.ARRIVING,
    etaOffsetMinutes: 12,
    recordedOffsetMinutes: -3,
  },
  {
    truckId: 'TRK-110',
    progress: 0,
    speedKmph: 57,
    status: TruckStatus.IN_TRANSIT,
    reason: LocationSnapshotReason.DEPARTURE,
    etaOffsetMinutes: -60,
    recordedOffsetMinutes: -1800,
  },
  {
    truckId: 'TRK-110',
    progress: 100,
    speedKmph: 0,
    status: TruckStatus.ARRIVED,
    reason: LocationSnapshotReason.ARRIVED,
    etaOffsetMinutes: -45,
    recordedOffsetMinutes: -45,
  },
  {
    truckId: 'TRK-110',
    progress: 100,
    speedKmph: 0,
    status: TruckStatus.DOCKED,
    reason: LocationSnapshotReason.DOCKED,
    etaOffsetMinutes: -45,
    recordedOffsetMinutes: -30,
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function geometryFor(routeId: string): Coordinate[] {
  const route = routeById.get(routeId);
  if (!route) throw new Error(`Unknown route ${routeId}`);
  return route.geometry;
}

const truckRouteById = new Map(trucks.map((truck) => [truck.id, truck.routeId]));

function truckPoint(truckId: string, progress: number): Coordinate {
  const routeId = truckRouteById.get(truckId);
  if (!routeId) throw new Error(`Unknown truck ${truckId}`);
  return pointAtProgress(geometryFor(routeId), progress);
}

async function main(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // Wipe, FK-safe. The assignment self-link is broken first so the chained
      // rows can be deleted in a single statement.
      await tx.locationHistory.deleteMany();
      await tx.alert.deleteMany();
      await tx.dockAssignment.updateMany({ data: { previousAssignmentId: null } });
      await tx.dockAssignment.deleteMany();
      await tx.appointment.deleteMany();
      await tx.shipment.deleteMany();
      await tx.truck.deleteMany();
      await tx.dockDoor.deleteMany();
      await tx.route.deleteMany();

      await tx.route.createMany({
        data: routes.map((route) => {
          const last = route.geometry[route.geometry.length - 1] ?? WAREHOUSE;
          const first = route.geometry[0] ?? WAREHOUSE;
          return {
            id: route.id,
            code: route.id,
            name: route.name,
            originName: route.originName,
            originLatitude: first.latitude,
            originLongitude: first.longitude,
            destinationName: 'E2 Fulfilment Centre, Kolkata',
            destinationLatitude: last.latitude,
            destinationLongitude: last.longitude,
            distanceKm: route.distanceKm,
            estimatedDurationMinutes: route.estimatedDurationMinutes,
            averageSpeedKmph: route.averageSpeedKmph,
            geometry: toJson(route.geometry),
          };
        }),
      });

      await tx.dockDoor.createMany({
        data: docks.map((dock) => ({
          id: dock.id,
          code: dock.id,
          name: dock.name,
          zone: dock.zone,
          status: dock.status,
          supportedLoadTypes: dock.supportedLoadTypes,
          latitude: dock.latitude,
          longitude: dock.longitude,
          availableFrom: dock.availableFrom,
          unavailableReason: dock.unavailableReason,
        })),
      });

      await tx.truck.createMany({
        data: trucks.map((truck) => {
          const point = pointAtProgress(geometryFor(truck.routeId), truck.progress);
          return {
            id: truck.id,
            reference: truck.id,
            trailerId: truck.trailerId,
            driverName: truck.driverName,
            driverPhone: truck.driverPhone,
            carrier: truck.carrier,
            status: truck.status,
            activeDelay: truck.activeDelay,
            routeId: truck.routeId,
            currentLatitude: point.latitude,
            currentLongitude: point.longitude,
            progress: truck.progress,
            speedKmph: truck.speedKmph,
            eta: truck.etaOffsetMinutes === null ? null : minutes(truck.etaOffsetMinutes),
            departedAt: minutes(truck.departedOffsetMinutes),
            arrivedAt:
              truck.arrivedOffsetMinutes === null ? null : minutes(truck.arrivedOffsetMinutes),
            lastUpdatedAt: BASE,
          };
        }),
      });

      await tx.shipment.createMany({
        data: shipments.map((shipment) => {
          const routeId = truckRouteById.get(shipment.truckId);
          const route = routeId ? routeById.get(routeId) : undefined;
          return {
            id: shipment.id,
            reference: shipment.id,
            trackingNumber: shipment.trackingNumber,
            customerName: shipment.customerName,
            originName: route?.originName ?? 'Unknown origin',
            destinationName: 'E2 Fulfilment Centre, Kolkata',
            status: shipment.status,
            priority: shipment.priority,
            loadType: shipment.loadType,
            weightKg: shipment.weightKg,
            palletCount: shipment.palletCount,
            description: shipment.description,
            truckId: shipment.truckId,
          };
        }),
      });

      await tx.appointment.createMany({
        data: shipments.map((shipment) => ({
          id: shipment.appointmentId,
          reference: shipment.appointmentId,
          shipmentId: shipment.id,
          windowStart: minutes(shipment.windowStartOffsetMinutes),
          windowEnd: minutes(shipment.windowEndOffsetMinutes),
          expectedDurationMinutes: shipment.expectedDurationMinutes,
          notes: shipment.appointmentNotes === '' ? null : shipment.appointmentNotes,
        })),
      });

      // Chained rows go last so previousAssignmentId always resolves.
      const chained = assignments.filter((a) => a.previousAssignmentId !== null);
      const unchained = assignments.filter((a) => a.previousAssignmentId === null);

      const toRow = (a: AssignmentSeed) => ({
        id: a.id,
        truckId: a.truckId,
        shipmentId: a.shipmentId,
        dockDoorId: a.dockDoorId,
        status: a.status,
        score: a.score,
        reasons: a.reasons,
        scheduledStart: minutes(a.scheduledStartOffsetMinutes),
        scheduledEnd: minutes(a.scheduledEndOffsetMinutes),
        assignedAt: a.assignedOffsetMinutes === null ? null : minutes(a.assignedOffsetMinutes),
        releasedAt: a.releasedOffsetMinutes === null ? null : minutes(a.releasedOffsetMinutes),
        reassignedAt:
          a.reassignedOffsetMinutes === null ? null : minutes(a.reassignedOffsetMinutes),
        previousAssignmentId: a.previousAssignmentId,
      });

      await tx.dockAssignment.createMany({ data: unchained.map(toRow) });
      await tx.dockAssignment.createMany({ data: chained.map(toRow) });

      await tx.alert.createMany({
        data: alerts.map((alert) => ({
          id: alert.id,
          type: alert.type,
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          truckId: alert.truckId,
          shipmentId: alert.shipmentId,
          dockDoorId: alert.dockDoorId,
          metadata: toJson(alert.metadata),
          acknowledged: alert.acknowledged,
          acknowledgedAt:
            alert.acknowledgedOffsetMinutes === null
              ? null
              : minutes(alert.acknowledgedOffsetMinutes),
          createdAt: minutes(alert.createdOffsetMinutes),
        })),
      });

      await tx.locationHistory.createMany({
        data: locationHistory.map((snapshot) => {
          const point = truckPoint(snapshot.truckId, snapshot.progress);
          return {
            truckId: snapshot.truckId,
            latitude: point.latitude,
            longitude: point.longitude,
            progress: snapshot.progress,
            speedKmph: snapshot.speedKmph,
            status: snapshot.status,
            eta:
              snapshot.etaOffsetMinutes === null ? null : minutes(snapshot.etaOffsetMinutes),
            reason: snapshot.reason,
            recordedAt: minutes(snapshot.recordedOffsetMinutes),
          };
        }),
      });
    },
    { timeout: 30_000 },
  );

  const counts = {
    Route: await prisma.route.count(),
    DockDoor: await prisma.dockDoor.count(),
    Truck: await prisma.truck.count(),
    Shipment: await prisma.shipment.count(),
    Appointment: await prisma.appointment.count(),
    DockAssignment: await prisma.dockAssignment.count(),
    Alert: await prisma.alert.count(),
    LocationHistory: await prisma.locationHistory.count(),
  };

  console.log(`\nSeed complete (base time ${BASE.toISOString()})\n`);
  console.table(counts);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
