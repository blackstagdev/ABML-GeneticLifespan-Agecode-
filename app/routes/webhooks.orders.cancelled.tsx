import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendAlert } from "../gls/alerts.server";

// orders/cancelled: the GLS API has no cancel endpoint, so alert the team when an order
// that was already sent to Genetic LifeSpan gets cancelled.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  const order = payload as { admin_graphql_api_id?: string; id?: number; name?: string; cancel_reason?: string };
  const orderGid = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;

  const sent = await prisma.glsSync.findMany({ where: { orderGid, status: "sent" } });
  if (sent.length) {
    await sendAlert(
      `Order ${order.name} was cancelled after it was sent to Genetic LifeSpan`,
      [
        `Reason: ${order.cancel_reason ?? "not given"}`,
        ...sent.map((row) => `${row.alphaOrderId}: ${row.productType} x${row.quantity}, GLS order ${row.glsOrderName}`),
        "",
        "Contact Genetic LifeSpan to cancel these orders and adjust the wire reconciliation.",
      ].join("\n"),
    );
  }

  return new Response();
};
