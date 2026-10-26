-- V2 spec (10/23/2026): one Genetic LifeSpan request per Shopify order instead of one per line.
-- The old per-line table only ever held dry-run rows, so it is recreated.
-- DropTable
DROP TABLE IF EXISTS "GlsSync";

-- CreateTable
CREATE TABLE "GlsSync" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "alphaOrderId" TEXT NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "items" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "pricePaid" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastStatusCode" INTEGER,
    "requestPayload" JSONB NOT NULL,
    "responseBody" JSONB,
    "glsOrderId" TEXT,
    "glsOrderName" TEXT,
    "sentAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlsSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlsSync_jobId_key" ON "GlsSync"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "GlsSync_orderGid_key" ON "GlsSync"("orderGid");

-- CreateIndex
CREATE INDEX "GlsSync_sentAt_idx" ON "GlsSync"("sentAt");

-- AddForeignKey
ALTER TABLE "GlsSync" ADD CONSTRAINT "GlsSync_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OrderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
