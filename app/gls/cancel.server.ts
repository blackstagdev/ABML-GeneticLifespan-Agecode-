// Cancel an order at Genetic LifeSpan (V3 spec, section 11).
//
// Triggered automatically when the Shopify order is cancelled (orders/cancelled webhook), or by
// staff with "Cancel at Genetic LifeSpan" in the app (e.g. after a refund). The endpoint is safe to
// call again (it answers already_cancelled), but after a 502/timeout the spec asks us to contact
// Genetic LifeSpan before retrying, so those are never retried automatically.
// Cancelling only stops shipping: it does not refund the customer (Alpha collected the payment).
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendAlert } from "./alerts.server";
import { cancelGlsOrder, type GlsCancelReason } from "./client.server";
import { getGlsConfig } from "./config.server";
import { addOrderTags } from "./shopify-order.server";

export const CANCEL_TAGS = { cancelled: "gls-cancelled", check: "gls-cancel-check" } as const;

// Statuses where Genetic LifeSpan has (or may have) the order.
const CANCELLABLE = ["sent", "needs_check"];

export type CancelOutcome = { ok: boolean; message: string };

async function tag(shop: string, orderGid: string, tagName: string) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    await addOrderTags(admin, orderGid, [tagName]);
  } catch (error) {
    console.error(`Could not tag order with ${tagName}`, error);
  }
}

export async function cancelAtGls(
  jobId: string,
  reason: GlsCancelReason,
  trigger: "shopify_cancel" | "manual",
): Promise<CancelOutcome> {
  const sync = await prisma.glsSync.findUnique({ where: { jobId }, include: { job: true } });
  if (!sync) return { ok: false, message: "This order was never sent to Genetic LifeSpan" };
  const name = sync.orderName;
  const ref = `alpha_order_id ${sync.alphaOrderId}${sync.glsOrderName ? `, GLS order ${sync.glsOrderName}` : ""}`;
  const via = trigger === "shopify_cancel" ? "the order was cancelled in Shopify" : "requested in AgeCode Bridge";

  if (sync.status === "sending") {
    await sendAlert(
      `Order ${name} was cancelled while it was being sent to Genetic LifeSpan`,
      `${ref}: ${sync.summary}\n\nWait a minute, open AgeCode Bridge and press "Cancel at Genetic LifeSpan" on this order.`,
    );
    return { ok: false, message: "The order is being sent right now. Try again in a minute." };
  }
  if (!CANCELLABLE.includes(sync.status)) {
    return { ok: false, message: "This order was never sent to Genetic LifeSpan" };
  }
  if (sync.cancelStatus === "cancelled") return { ok: true, message: `${name} is already cancelled at Genetic LifeSpan` };

  const config = getGlsConfig();
  await prisma.glsSync.update({
    where: { id: sync.id },
    data: { cancelStatus: "requested", cancelReason: reason, cancelError: null },
  });

  const result = await cancelGlsOrder(config, { alpha_order_id: sync.alphaOrderId, reason });
  const save = (data: {
    cancelStatus: string | null;
    cancelError?: string | null;
    cancelResponse?: unknown;
    cancelledAt?: Date;
  }) =>
    prisma.glsSync.update({
      where: { id: sync.id },
      data: {
        cancelStatus: data.cancelStatus,
        cancelError: data.cancelError ? data.cancelError.slice(0, 1000) : null,
        ...(data.cancelResponse !== undefined ? { cancelResponse: (data.cancelResponse ?? null) as object } : {}),
        ...(data.cancelledAt ? { cancelledAt: data.cancelledAt } : {}),
      },
    });

  switch (result.kind) {
    case "dry_run":
      await save({ cancelStatus: null });
      return { ok: false, message: "Dry run: the cancel was not sent to Genetic LifeSpan" };

    case "cancelled": {
      await save({ cancelStatus: "cancelled", cancelResponse: result.body, cancelledAt: new Date() });
      await prisma.orderJob.update({ where: { id: jobId }, data: { status: "gls_cancelled", lastError: null } });
      await tag(sync.job.shop, sync.orderGid, CANCEL_TAGS.cancelled);
      await sendAlert(
        `Order ${name} was cancelled at Genetic LifeSpan`,
        [
          `${ref}: ${sync.summary} (${via}, reason ${reason})${result.alreadyCancelled ? ". It was already cancelled there" : ""}.`,
          "It will not ship. Genetic LifeSpan does not refund the customer: refund in Shopify if needed and adjust the wire reconciliation.",
        ].join("\n"),
      );
      return { ok: true, message: `${name} cancelled at Genetic LifeSpan` };
    }

    case "shipped":
      await save({ cancelStatus: "shipped", cancelError: result.message, cancelResponse: result.body });
      await sendAlert(
        `Order ${name} could not be cancelled: Genetic LifeSpan already shipped it`,
        `${ref}: ${sync.summary} (${via}).\n\nA shipped order is a return, not a cancel: email Genetic LifeSpan (rommel.aleman@geneticlifespan.com).`,
      );
      return { ok: false, message: `${name} already shipped: email Genetic LifeSpan for a return` };

    case "not_found":
      await save({ cancelStatus: "not_found", cancelError: result.message, cancelResponse: result.body });
      if (sync.status === "needs_check") {
        // The unconfirmed send never created an order, so there is nothing to ship.
        await prisma.orderJob.update({ where: { id: jobId }, data: { status: "cancelled", lastError: null } });
        return { ok: true, message: `${name}: Genetic LifeSpan has no such order, nothing will ship` };
      }
      await sendAlert(
        `Cancel for ${name}: Genetic LifeSpan says the order doesn't exist`,
        `${ref}: ${sync.summary} (${via}).\n\nThe cancel answered 404 although the order was accepted. Check with Genetic LifeSpan.`,
      );
      return { ok: false, message: `Genetic LifeSpan has no order ${sync.alphaOrderId}. Check with them.` };

    case "rejected":
      await save({ cancelStatus: "failed", cancelError: `${result.status}: ${result.message}`, cancelResponse: result.body });
      await sendAlert(
        `Cancel for ${name} was rejected by Genetic LifeSpan`,
        `${ref}: ${result.status} ${result.message}\n\nNothing was cancelled. Fix the problem (e.g. API key), then press "Cancel at Genetic LifeSpan" again.`,
      );
      return { ok: false, message: `Genetic LifeSpan rejected the cancel (${result.status}): ${result.message}` };

    case "unknown":
      await save({ cancelStatus: "needs_check", cancelError: result.message, cancelResponse: result.body });
      await tag(sync.job.shop, sync.orderGid, CANCEL_TAGS.check);
      await sendAlert(
        `Cancel for ${name} did not go through: contact Genetic LifeSpan`,
        [
          `${ref}: ${sync.summary} (${via}).`,
          `Genetic LifeSpan answered: ${result.message}`,
          "Nothing was cancelled. Their spec asks to contact them before retrying: email rommel.aleman@geneticlifespan.com",
          `with the alpha_order_id, then press "Cancel at Genetic LifeSpan" again in AgeCode Bridge if they ask you to.`,
        ].join("\n"),
      );
      return { ok: false, message: "Cancel not confirmed: contact Genetic LifeSpan before trying again" };
  }
}
