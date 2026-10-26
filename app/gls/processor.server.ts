// Order processing: Shopify order -> one GLS order -> fulfill + tag the AgeCode items.
//
// Genetic LifeSpan's API does not dedupe, so a request is never repeated unless we know it
// didn't create anything (4xx, DNS/connection refused, 429). A 5xx or timeout puts the order in
// "needs_check" until someone confirms with Genetic LifeSpan and presses "Mark as sent" or "Resend".
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendAlert } from "./alerts.server";
import { sendGlsOrder } from "./client.server";
import { getGlsConfig, nextAttemptDelayMs, type GlsConfig } from "./config.server";
import { buildGlsOrder, describeItems, type BuiltItem } from "./payload";
import { addOrderTags, fulfillOrderLines, loadOrder, setSyncMetafield } from "./shopify-order.server";

export const TAGS = {
  sent: "gls-sent",
  error: "gls-error",
  check: "gls-check",
  dryRun: "gls-dry-run",
} as const;

const STALE_LOCK_MS = 10 * 60 * 1000;

const shortError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

export async function enqueueOrder(shop: string, orderGid: string, orderName?: string | null) {
  return prisma.orderJob.upsert({
    where: { orderGid },
    create: { shop, orderGid, orderName: orderName ?? null },
    update: {},
  });
}

// Puts a job back in the queue (Retry/Send buttons, "Queue order").
// `resend` is only for orders Genetic LifeSpan confirmed they don't have (needs_check).
export async function requeueJob(jobId: string, { resend = false } = {}) {
  const sync = await prisma.glsSync.findUnique({ where: { jobId } });
  if (sync && sync.status !== "sent") {
    if (["needs_check", "sending"].includes(sync.status) && !resend) {
      throw new Error("This order may already exist at Genetic LifeSpan. Confirm with them first.");
    }
    // Rebuild the payload from the current order (picks up fixes such as a corrected phone number).
    await prisma.glsSync.delete({ where: { id: sync.id } });
  }
  return prisma.orderJob.update({
    where: { id: jobId },
    data: { status: "retry", attempts: 0, nextAttemptAt: new Date(), lastError: null, lockedAt: null },
  });
}

// After Genetic LifeSpan confirms an order from a needs_check row exists on their side.
export async function markSentManually(jobId: string, glsOrderName: string) {
  await prisma.glsSync.update({
    where: { jobId },
    data: { status: "sent", glsOrderName: glsOrderName || "confirmed by Genetic LifeSpan", sentAt: new Date(), lastError: null },
  });
  // Let the worker finish the Shopify side (fulfill, tag, metafield).
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
    // Unexpected error (Shopify API down, DB error...). The GLS request is protected by the
    // "sending" status, so retrying the job can't create a duplicate.
    await finishJob(job.id, job.orderName, attempts, { status: "retryable_error", error: shortError(error) }, config);
  }
}

type Outcome =
  | { status: "done" | "dry_run" | "no_agecode" | "cancelled" }
  | { status: "retryable_error" | "permanent_error" | "needs_check"; error: string };

async function runJob(shop: string, jobId: string, orderGid: string, config: GlsConfig): Promise<Outcome> {
  const { admin } = await unauthenticated.admin(shop);
  const order = await loadOrder(admin, orderGid);
  if (!order) return { status: "permanent_error", error: "Order not found in Shopify" };

  await prisma.orderJob.update({ where: { id: jobId }, data: { orderName: order.name } });

  let sync = await prisma.glsSync.findUnique({ where: { jobId } });

  if (!sync) {
    const built = buildGlsOrder(order, { forceTest: config.forceTest });
    if (!built) return { status: "no_agecode" };
    sync = await prisma.glsSync.create({
      data: {
        jobId,
        orderGid,
        orderName: order.name,
        alphaOrderId: built.alphaOrderId,
        isTest: built.isTest,
        items: built.items as unknown as object,
        summary: describeItems(built.items),
        pricePaid: built.pricePaid,
        status: built.payload ? "pending" : "failed",
        lastError: built.errors.length ? built.errors.join("; ") : null,
        requestPayload: (built.payload ?? { errors: built.errors }) as object,
      },
    });
  }

  // A previous run died between saving "sending" and saving the answer: never resend blindly.
  if (sync.status === "sending") {
    sync = await prisma.glsSync.update({
      where: { id: sync.id },
      data: { status: "needs_check", lastError: "The app stopped while sending. Check with Genetic LifeSpan." },
    });
  }

  if (sync.status === "failed") return { status: "permanent_error", error: sync.lastError ?? "Order data invalid" };
  if (sync.status === "needs_check") return { status: "needs_check", error: sync.lastError ?? "Check with Genetic LifeSpan" };

  if (["pending", "dry_run"].includes(sync.status)) {
    if (order.cancelled) return { status: "cancelled" };

    if (config.mode !== "dry_run") {
      // Persist intent first so a crash mid-request can't lead to a second POST.
      await prisma.glsSync.update({ where: { id: sync.id }, data: { status: "sending", attempts: { increment: 1 } } });
    }

    const result = await sendGlsOrder(config, sync.requestPayload as never);

    if (result.kind === "dry_run") {
      await prisma.glsSync.update({ where: { id: sync.id }, data: { status: "dry_run" } });
      await addOrderTags(admin, orderGid, [TAGS.dryRun]);
      return { status: "dry_run" };
    }
    if (result.kind === "not_sent") {
      await prisma.glsSync.update({
        where: { id: sync.id },
        data: { status: "pending", lastError: result.message, lastStatusCode: result.status },
      });
      return { status: "retryable_error", error: result.message };
    }
    if (result.kind === "rejected") {
      await prisma.glsSync.update({
        where: { id: sync.id },
        data: {
          status: "failed",
          lastError: result.message.slice(0, 1000),
          lastStatusCode: result.status,
          responseBody: (result.body ?? null) as object,
        },
      });
      return { status: "permanent_error", error: `Genetic LifeSpan rejected the order (${result.status}): ${result.message}` };
    }
    if (result.kind === "unknown") {
      await prisma.glsSync.update({
        where: { id: sync.id },
        data: {
          status: "needs_check",
          lastError: result.message.slice(0, 1000),
          lastStatusCode: result.status,
          responseBody: (result.body ?? null) as object,
        },
      });
      return { status: "needs_check", error: result.message };
    }

    sync = await prisma.glsSync.update({
      where: { id: sync.id },
      data: {
        status: "sent",
        lastError: null,
        lastStatusCode: result.status,
        responseBody: result.body as object,
        glsOrderId: result.glsOrderId,
        glsOrderName: result.glsOrderName,
        sentAt: new Date(),
      },
    });
  }

  // Sent: finish the Shopify side. Each step is safe to repeat if a later one fails.
  const items = sync.items as unknown as BuiltItem[];
  if (config.autoFulfill && !sync.fulfilledAt) {
    await fulfillOrderLines(
      admin,
      orderGid,
      items.map((item) => item.lineItemId),
      `Sent to Genetic LifeSpan for fulfillment${sync.glsOrderName ? ` (GLS order ${sync.glsOrderName})` : ""}`,
    );
    await prisma.glsSync.update({ where: { id: sync.id }, data: { fulfilledAt: new Date() } });
  }

  await setSyncMetafield(admin, orderGid, {
    alpha_order_id: sync.alphaOrderId,
    gls_order_id: sync.glsOrderId,
    gls_order_name: sync.glsOrderName,
    sent_at: sync.sentAt,
    test: sync.isTest,
    items: items.map((item) => ({
      product_type: item.productType,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    })),
  });
  await addOrderTags(admin, orderGid, [TAGS.sent]);
  return { status: "done" };
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

  if (outcome.status === "needs_check") {
    await prisma.orderJob.update({
      where: { id: jobId },
      data: { status: "needs_check", attempts, lockedAt: null, lastError: outcome.error },
    });
    await tagOrder(jobId, TAGS.check);
    const sync = await prisma.glsSync.findUnique({ where: { jobId } });
    await sendAlert(
      `Order ${orderName ?? jobId}: check with Genetic LifeSpan before resending`,
      [
        `Genetic LifeSpan did not confirm the order: ${outcome.error}`,
        `It may or may not have been created on their side. Their API does not dedupe, so it was NOT resent.`,
        "",
        `Ask Genetic LifeSpan (rommel.aleman@geneticlifespan.com) whether alpha_order_id ${sync?.alphaOrderId ?? orderName} exists, then in AgeCode Bridge:`,
        `- it exists: "Mark as sent" (enter their order number)`,
        `- it doesn't: "Resend"`,
      ].join("\n"),
    );
    return;
  }

  if (outcome.status === "retryable_error" || outcome.status === "permanent_error") {
    await prisma.orderJob.update({
      where: { id: jobId },
      data: { status: "failed", attempts, lockedAt: null, lastError: outcome.error },
    });
    await tagOrder(jobId, TAGS.error);
    await sendAlert(
      `Order ${orderName ?? jobId} was not sent to Genetic LifeSpan`,
      `${outcome.error}\n\nFix the order in Shopify if needed, then open AgeCode Bridge and press Retry.`,
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

async function tagOrder(jobId: string, tag: string) {
  try {
    const job = await prisma.orderJob.findUniqueOrThrow({ where: { id: jobId } });
    const { admin } = await unauthenticated.admin(job.shop);
    await addOrderTags(admin, job.orderGid, [tag]);
  } catch (error) {
    console.error(`Could not tag order with ${tag}`, error);
  }
}
