import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendAlert } from "../gls/alerts.server";

// refunds/create: alert the team when a refund touches an AgeCode item already sent to Genetic LifeSpan.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  const refund = payload as {
    order_id?: number;
    refund_line_items?: { line_item_id: number; quantity: number }[];
  };
  const orderGid = `gid://shopify/Order/${refund.order_id}`;
  const refundedLineGids = new Map(
    (refund.refund_line_items ?? []).map((item) => [`gid://shopify/LineItem/${item.line_item_id}`, item.quantity]),
  );

  const sent = await prisma.glsSync.findMany({ where: { orderGid, status: "sent" } });
  const affected = sent.filter((row) => refundedLineGids.has(row.lineItemGid));

  if (affected.length) {
    await sendAlert(
      `Refund on ${affected[0].orderName} includes AgeCode items sent to Genetic LifeSpan`,
      [
        ...affected.map(
          (row) =>
            `${row.alphaOrderId}: ${row.productType}, refunded qty ${refundedLineGids.get(row.lineItemGid)} of ${row.quantity}, GLS order ${row.glsOrderName}`,
        ),
        "",
        "Contact Genetic LifeSpan and adjust the wire reconciliation.",
      ].join("\n"),
    );
  }

  return new Response();
};
