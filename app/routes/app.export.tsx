import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { BuiltItem } from "../gls/payload";

// Rows for the wire reconciliation CSV (built and downloaded in the browser by app._index).
// One row per AgeCode product line, so totals per product type are easy to sum.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const from = url.searchParams.get("from") || new Date().toISOString().slice(0, 10);
  const to = url.searchParams.get("to") || from;

  const syncs = await prisma.glsSync.findMany({
    where: {
      status: "sent",
      job: { shop: session.shop },
      sentAt: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) },
    },
    orderBy: { sentAt: "asc" },
  });

  return {
    from,
    to,
    rows: syncs.flatMap((sync) =>
      (sync.items as unknown as BuiltItem[]).map((item) => ({
        sent_at_utc: sync.sentAt?.toISOString(),
        shopify_order: sync.orderName,
        alpha_order_id: sync.alphaOrderId,
        test_order: sync.isTest ? "yes" : "no",
        product_type: item.productType,
        quantity: item.quantity,
        unit_price: item.unitPrice.toFixed(2),
        line_total: item.lineTotal.toFixed(2),
        order_price_paid: sync.pricePaid.toFixed(2),
        gls_order_name: sync.glsOrderName,
        gls_order_id: sync.glsOrderId,
        fulfilled_in_shopify: sync.fulfilledAt ? "yes" : "no",
      })),
    ),
  };
};
