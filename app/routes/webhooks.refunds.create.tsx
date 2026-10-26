import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendAlert } from "../gls/alerts.server";
import type { BuiltItem } from "../gls/payload";

// refunds/create: alert the team when a refund touches an AgeCode item already sent to Genetic LifeSpan.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  const refund = payload as {
    order_id?: number;
    refund_line_items?: { line_item_id: number; quantity: number }[];
  };
  const orderGid = `gid://shopify/Order/${refund.order_id}`;
  const refunded = new Map(
    (refund.refund_line_items ?? []).map((item) => [`gid://shopify/LineItem/${item.line_item_id}`, item.quantity]),
  );

  const sync = await prisma.glsSync.findUnique({ where: { orderGid } });
  if (!sync || !["sent", "needs_check", "sending"].includes(sync.status)) return new Response();

  const affected = (sync.items as unknown as BuiltItem[]).filter((item) => refunded.has(item.lineItemId));
  if (affected.length) {
    await sendAlert(
      `Refund on ${sync.orderName} includes AgeCode items sent to Genetic LifeSpan`,
      [
        `alpha_order_id ${sync.alphaOrderId}, GLS order ${sync.glsOrderName ?? "unconfirmed"}`,
        ...affected.map(
          (item) => `${item.productType}: refunded qty ${refunded.get(item.lineItemId)} of ${item.quantity}`,
        ),
        "",
        "Contact Genetic LifeSpan and adjust the wire reconciliation.",
      ].join("\n"),
    );
  }

  return new Response();
};
