-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "LoadType" AS ENUM ('GENERAL', 'REFRIGERATED', 'HAZARDOUS', 'OVERSIZED');

-- CreateEnum
CREATE TYPE "TruckStatus" AS ENUM ('IN_TRANSIT', 'DELAYED', 'ARRIVING', 'ARRIVED', 'DOCKED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'IN_TRANSIT', 'DELAYED', 'ARRIVING', 'ARRIVED', 'DOCKED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "DockStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'OCCUPIED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('RECOMMENDED', 'ASSIGNED', 'REASSIGNED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('TRUCK_DELAYED', 'DOCK_UNAVAILABLE', 'DOCK_REASSIGNMENT', 'NO_DOCK_AVAILABLE', 'TRUCK_ARRIVING');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DelayScenario" AS ENUM ('NORMAL', 'RAIN', 'TRAFFIC', 'ROAD_CLOSURE');

-- CreateEnum
CREATE TYPE "LocationSnapshotReason" AS ENUM ('DEPARTURE', 'PERIODIC', 'DELAY_ACTIVATED', 'DELAY_CLEARED', 'ARRIVING', 'ARRIVED', 'DOCKED', 'COMPLETED');

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "originName" TEXT NOT NULL,
    "originLatitude" DOUBLE PRECISION NOT NULL,
    "originLongitude" DOUBLE PRECISION NOT NULL,
    "destinationName" TEXT NOT NULL,
    "destinationLatitude" DOUBLE PRECISION NOT NULL,
    "destinationLongitude" DOUBLE PRECISION NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "estimatedDurationMinutes" INTEGER NOT NULL,
    "averageSpeedKmph" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "geometry" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Truck" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "trailerId" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "driverPhone" TEXT,
    "carrier" TEXT NOT NULL,
    "status" "TruckStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "activeDelay" "DelayScenario" NOT NULL DEFAULT 'NORMAL',
    "routeId" TEXT NOT NULL,
    "currentLatitude" DOUBLE PRECISION NOT NULL,
    "currentLongitude" DOUBLE PRECISION NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "speedKmph" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "eta" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Truck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "originName" TEXT NOT NULL,
    "destinationName" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "loadType" "LoadType" NOT NULL DEFAULT 'GENERAL',
    "weightKg" DOUBLE PRECISION,
    "palletCount" INTEGER,
    "description" TEXT,
    "truckId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "expectedDurationMinutes" INTEGER NOT NULL DEFAULT 45,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DockDoor" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone" TEXT NOT NULL DEFAULT 'MAIN',
    "status" "DockStatus" NOT NULL DEFAULT 'AVAILABLE',
    "supportedLoadTypes" "LoadType"[],
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "availableFrom" TIMESTAMP(3),
    "unavailableReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DockDoor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DockAssignment" (
    "id" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "dockDoorId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'RECOMMENDED',
    "score" DOUBLE PRECISION,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "reassignedAt" TIMESTAMP(3),
    "previousAssignmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DockAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "truckId" TEXT,
    "shipmentId" TEXT,
    "dockDoorId" TEXT,
    "metadata" JSONB,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationHistory" (
    "id" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL,
    "speedKmph" DOUBLE PRECISION NOT NULL,
    "status" "TruckStatus" NOT NULL,
    "eta" TIMESTAMP(3),
    "reason" "LocationSnapshotReason" NOT NULL DEFAULT 'PERIODIC',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Route_code_key" ON "Route"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Truck_reference_key" ON "Truck"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Truck_trailerId_key" ON "Truck"("trailerId");

-- CreateIndex
CREATE INDEX "Truck_status_idx" ON "Truck"("status");

-- CreateIndex
CREATE INDEX "Truck_routeId_idx" ON "Truck"("routeId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_reference_key" ON "Shipment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_trackingNumber_key" ON "Shipment"("trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_truckId_key" ON "Shipment"("truckId");

-- CreateIndex
CREATE INDEX "Shipment_status_idx" ON "Shipment"("status");

-- CreateIndex
CREATE INDEX "Shipment_priority_idx" ON "Shipment"("priority");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_reference_key" ON "Appointment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_shipmentId_key" ON "Appointment"("shipmentId");

-- CreateIndex
CREATE INDEX "Appointment_windowStart_idx" ON "Appointment"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "DockDoor_code_key" ON "DockDoor"("code");

-- CreateIndex
CREATE INDEX "DockDoor_status_idx" ON "DockDoor"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DockAssignment_previousAssignmentId_key" ON "DockAssignment"("previousAssignmentId");

-- CreateIndex
CREATE INDEX "DockAssignment_truckId_status_idx" ON "DockAssignment"("truckId", "status");

-- CreateIndex
CREATE INDEX "DockAssignment_dockDoorId_status_idx" ON "DockAssignment"("dockDoorId", "status");

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");

-- CreateIndex
CREATE INDEX "Alert_type_idx" ON "Alert"("type");

-- CreateIndex
CREATE INDEX "Alert_truckId_idx" ON "Alert"("truckId");

-- CreateIndex
CREATE INDEX "LocationHistory_truckId_recordedAt_idx" ON "LocationHistory"("truckId", "recordedAt");

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DockAssignment" ADD CONSTRAINT "DockAssignment_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DockAssignment" ADD CONSTRAINT "DockAssignment_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DockAssignment" ADD CONSTRAINT "DockAssignment_dockDoorId_fkey" FOREIGN KEY ("dockDoorId") REFERENCES "DockDoor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DockAssignment" ADD CONSTRAINT "DockAssignment_previousAssignmentId_fkey" FOREIGN KEY ("previousAssignmentId") REFERENCES "DockAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_dockDoorId_fkey" FOREIGN KEY ("dockDoorId") REFERENCES "DockDoor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationHistory" ADD CONSTRAINT "LocationHistory_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE;
