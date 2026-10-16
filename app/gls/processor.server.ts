// Order processing: Shopify order -> GLS API -> fulfill + tag the AgeCode items.
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendAlert } from "./alerts.server";
import { sendGlsOrder } from "./client.server";
import { getGlsConfig, nextAttemptDelayMs, type GlsConfig } from "./config.server";
import { buildGlsLines } from "./payload";
import { addOrderTags, fulfillOrderLines, loadOrder, setSyncMetafield } from "./shopify-order.server";

export const TAGS = {
  sent: "gls-sent",
  error: "gls-error",
  dryRun: "gls-dry-run",
} as const;

const STALE_LOCK_MS = 10 * 60 * 1000;

const shortError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

export async function enqueueOrder(shop: string, orderGid: string, orderName?: string | null) {
  const job = await prisma.orderJob.upsert({
    where: { orderGid },
    create: { shop, orderGid, orderName: orderName ?? null },
    update: {},
  });
  return job;
}

// Puts a job back in the queue (used by the Retry button and the manual "queue order" form).
export async function requeueJob(jobId: string) {
  await prisma.glsSync.updateMany({
    where: { jobId, status: "failed" },
    data: { status: "pending", retryable: true, lastError: null },
  });
  return prisma.orderJob.update({
    where: { id: jobId },
    data: { status: "retry", attempts: 0, nextAttemptAt: new Date(), lastError: null, lockedAt: null },
  });
}

async function claim(jobId: string) {
  const claimed = await prisma.orderJob.updateMany({
    where: { id: jobId, status: { in: ["pending", "retry"] }, nextAttemptAt: { lte: new Date() } },
    data: { status: "processing", lockedAt: new Date() },
  });
  return claimed.count === 1;
}

export async function processDueJobs(limit = 10) {
  // Release jobs left in "processing" by a crash or restart.
  await prisma.orderJob.updateMany({
    where: { status: "processing", lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
    data: { status: "retry", lockedAt: null },
  });

  const due = await prisma.orderJob.findMany({
    where: { status: { in: ["pending", "retry"] }, nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

  for (const job of due) {
    await processJob(job.id);
  }
  return due.length;
}

export async function processJob(jobId: string) {
  if (!(await claim(jobId))) return;
  const job = await prisma.orderJob.findUniqueOrThrow({ where: { id: jobId } });
  const config = getGlsConfig();
  const attempts = job.attempts + 1;

  try {
    const outcome = await runJob(job.shop, job.id, job.orderGid, config);
    await finishJob(job.id, job.orderName, attempts, outcome, config);
  } catch (error) {
    // Unexpected error (Shopify API down, DB error...): retry the whole job.
    await finishJob(job.id, job.orderName, attempts, { status: "retryable_error", error: shortError(error) }, config);
  }
}

type Outcome =
  | { status: "done" | "dry_run" | "no_agecode" | "cancelled" }
  | { status: "retryable_error" | "permanent_error"; error: string };

async function runJob(shop: string, jobId: string, orderGid: string, config: GlsConfig): Promise<Outcome> {
  const { admin } = await unauthenticated.admin(shop);
  const order = await loadOrder(admin, orderGid);
  if (!order) return { status: "permanent_error", error: "Order not found in Shopify" };

  await prisma.orderJob.update({ where: { id: jobId }, data: { orderName: order.name } });

  const built = buildGlsLines(order, config);
  if (!built.length) return { status: "no_agecode" };

  // Record every AgeCode line (idempotent: one row per order line item).
  for (const line of built) {
    await prisma.glsSync.upsert({
      where: { orderGid_lineItemGid: { orderGid, lineItemGid: line.lineItemId } },
      create: {
        jobId,
        orderGid,
        orderName: order.name,
        lineItemGid: line.lineItemId,
        alphaOrderId: line.alphaOrderId,
        productType: line.productType,
        quantity: line.quantity,
        pricePaid: line.pricePaid,
        requestPayload: (line.payload ?? { errors: line.errors }) as object,
      },
      update: {},
    });
  }

  const rows = await prisma.glsSync.findMany({ where: { jobId } });
  const unsent = rows.filter((row) => row.status !== "sent");

  if (unsent.length && order.cancelled) return { status: "cancelled" };

  // Send every line that hasn't been accepted by GLS yet.
  for (const row of unsent) {
    const line = built.find((candidate) => candidate.lineItemId === row.lineItemGid);
    if (!line) continue;

    if (!line.payload) {
      await prisma.glsSync.update({
        where: { id: row.id },
        data: {
          status: "failed",
          retryable: false,
          attempts: { increment: 1 },
          lastError: line.errors.join("; "),
          requestPayload: { errors: line.errors },
        },
      });
      continue;
    }

    const result = await sendGlsOrder(config, line.payload);
    const base = { attempts: { increment: 1 }, requestPayload: line.payload as object };

    if (result.kind === "sent") {
      await prisma.glsSync.update({
        where: { id: row.id },
        data: {
          ...base,
          status: "sent",
          retryable: false,
          lastError: null,
          lastStatusCode: result.status,
          responseBody: result.body as object,
          glsOrderId: result.glsOrderId,
          glsOrderName: result.glsOrderName,
          sentAt: new Date(),
        },
      });
    } else if (result.kind === "dry_run") {
      await prisma.glsSync.update({
        where: { id: row.id },
        data: { ...base, status: "dry_run", lastError: null },
      });
    } else {
      await prisma.glsSync.update({
        where: { id: row.id },
        data: {
          ...base,
          status: "failed",
          retryable: result.retryable,
          lastError: result.message.slice(0, 1000),
          lastStatusCode: result.status,
          responseBody: (result.body ?? null) as object,
        },
      });
    }
  }

  const finalRows = await prisma.glsSync.findMany({ where: { jobId }, orderBy: { alphaOrderId: "asc" } });
  const sent = finalRows.filter((row) => row.status === "sent");

  // Fulfill lines GLS accepted (retried on the next run if Shopify fails).
  const toFulfill = sent.filter((row) => !row.fulfilledAt);
  if (config.autoFulfill && toFulfill.length) {
    const names = toFulfill.map((row) => row.glsOrderName).filter(Boolean).join(", ");
    await fulfillOrderLines(
      admin,
      orderGid,
      toFulfill.map((row) => row.lineItemGid),
      `Sent to Genetic LifeSpan for fulfillment${names ? ` (GLS order ${names})` : ""}`,
    );
    await prisma.glsSync.updateMany({
      where: { id: { in: toFulfill.map((row) => row.id) } },
      data: { fulfilledAt: new Date() },
    });
  }

  if (sent.length) {
    await setSyncMetafield(
      admin,
      orderGid,
      sent.map((row) => ({
        alpha_order_id: row.alphaOrderId,
        product_type: row.productType,
        quantity: row.quantity,
        gls_order_id: row.glsOrderId,
        gls_order_name: row.glsOrderName,
        sent_at: row.sentAt,
      })),
    );
  }

  const failed = finalRows.filter((row) => row.status === "failed");
  const tags: string[] = [];
  if (sent.length) tags.push(TAGS.sent);
  if (finalRows.some((row) => row.status === "dry_run")) tags.push(TAGS.dryRun);

  if (failed.length) {
    const error = failed.map((row) => `${row.alphaOrderId} (${row.productType}): ${row.lastError}`).join("\n");
    if (tags.length) await addOrderTags(admin, orderGid, tags);
    return failed.every((row) => row.retryable)
      ? { status: "retryable_error", error }
      : { status: "permanent_error", error };
  }

  if (tags.length) await addOrderTags(admin, orderGid, tags);
  return sent.length === finalRows.length ? { status: "done" } : { status: "dry_run" };
}

async function finishJob(jobId: string, orderName: string | null, attempts: number, outcome: Outcome, config: GlsConfig) {
  if (outcome.status === "retryable_error" && attempts < config.maxAttempts) {
    await prisma.orderJob.update({
      where: { id: jobId },
      data: {
        status: "retry",
        attempts,
        lockedAt: null,
        lastError: outcome.error,
        nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(attempts)),
      },
    });
    return;
  }

  if (outcome.status === "retryable_error" || outcome.status === "permanent_error") {
    await prisma.orderJob.update({
      where: { id: jobId },
      data: { status: "failed", attempts, lockedAt: null, lastError: outcome.error },
    });
    await tagError(jobId);
    await sendAlert(
      `Order ${orderName ?? jobId} was not sent to Genetic LifeSpan`,
      `${outcome.error}\n\nOpen AgeCode Bridge in Shopify admin to fix the order and press Retry.`,
    );
    return;
  }

  await prisma.orderJob.update({
    where: { id: jobId },
    data: { status: outcome.status, attempts, lockedAt: null, lastError: null },
  });

  if (outcome.status === "cancelled") {
    await sendAlert(`Order ${orderName ?? jobId} was cancelled before it was sent`, "Nothing was sent to Genetic LifeSpan.");
  }
}

async function tagError(jobId: string) {
  try {
    const job = await prisma.orderJob.findUniqueOrThrow({ where: { id: jobId } });
    const { admin } = await unauthenticated.admin(job.shop);
    await addOrderTags(admin, job.orderGid, [TAGS.error]);
  } catch (error) {
    console.error("Could not tag order with gls-error", error);
  }
}
