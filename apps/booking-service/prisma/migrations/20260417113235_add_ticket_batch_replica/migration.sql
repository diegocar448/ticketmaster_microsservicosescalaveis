-- CreateTable: réplica do TicketBatch sincronizada via Kafka a partir do event-service.
-- Não há FK para events/sections (cross-service): integridade é garantida via eventos.
CREATE TABLE "ticket_batches" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "sectionId" UUID,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "totalQuantity" INTEGER NOT NULL,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "saleStartAt" TIMESTAMP(3) NOT NULL,
    "saleEndAt" TIMESTAMP(3) NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_batches_pkey" PRIMARY KEY ("id")
);

-- Índice em eventId — consulta frequente: "quais batches deste evento?"
CREATE INDEX "ticket_batches_eventId_idx" ON "ticket_batches"("eventId");
