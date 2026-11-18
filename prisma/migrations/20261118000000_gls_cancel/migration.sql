-- V3 spec (11/13/2026): cancel endpoint POST /api/channels/{channel}/orders/cancel
ALTER TABLE "GlsSync" ADD COLUMN "cancelStatus" TEXT;
ALTER TABLE "GlsSync" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "GlsSync" ADD COLUMN "cancelError" TEXT;
ALTER TABLE "GlsSync" ADD COLUMN "cancelResponse" JSONB;
ALTER TABLE "GlsSync" ADD COLUMN "cancelledAt" TIMESTAMP(3);
