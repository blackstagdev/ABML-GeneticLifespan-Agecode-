-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlsSync" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "lineItemGid" TEXT NOT NULL,
    "alphaOrderId" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "pricePaid" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retryable" BOOLEAN NOT NULL DEFAULT true,
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
CREATE UNIQUE INDEX "OrderJob_orderGid_key" ON "OrderJob"("orderGid");

-- CreateIndex
CREATE INDEX "OrderJob_status_nextAttemptAt_idx" ON "OrderJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OrderJob_createdAt_idx" ON "OrderJob"("createdAt");

-- CreateIndex
CREATE INDEX "GlsSync_sentAt_idx" ON "GlsSync"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "GlsSync_orderGid_lineItemGid_key" ON "GlsSync"("orderGid", "lineItemGid");

-- AddForeignKey
ALTER TABLE "GlsSync" ADD CONSTRAINT "GlsSync_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OrderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

