import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendAlert } from "../gls/alerts.server";

// orders/cancelled: the GLS API has no cancel endpoint, so alert the team when an order
// that was already sent to Genetic LifeSpan (or may have been) gets cancelled.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  const order = payload as { admin_graphql_api_id?: string; id?: number; name?: string; cancel_reason?: string };
  const orderGid = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;

  const sync = await prisma.glsSync.findUnique({ where: { orderGid } });
  if (sync && ["sent", "needs_check", "sending"].includes(sync.status)) {
    await sendAlert(
      `Order ${order.name} was cancelled after it was sent to Genetic LifeSpan`,
      [
        `Reason: ${order.cancel_reason ?? "not given"}`,
        `alpha_order_id ${sync.alphaOrderId}: ${sync.summary}`,
        `GLS order: ${sync.glsOrderName ?? "unconfirmed (needs check)"}`,
        "",
        "Contact Genetic LifeSpan to cancel it and adjust the wire reconciliation.",
      ].join("\n"),
    );
  }

  return new Response();
};
