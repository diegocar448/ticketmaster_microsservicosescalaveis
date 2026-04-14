-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "organizerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subtotal" DECIMAL(10,2) NOT NULL,
    "serviceFee" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeCheckoutSessionId" TEXT,
    "stripeChargeId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "paymentMethod" TEXT,
    "cardLastFour" CHAR(4),
    "cardBrand" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "ticketBatchId" UUID NOT NULL,
    "seatId" UUID,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_stripePaymentIntentId_key" ON "orders"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_stripeCheckoutSessionId_key" ON "orders"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotencyKey_key" ON "orders"("idempotencyKey");

-- CreateIndex
CREATE INDEX "orders_buyerId_status_idx" ON "orders"("buyerId", "status");

-- CreateIndex
CREATE INDEX "orders_organizerId_status_idx" ON "orders"("organizerId", "status");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
