import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Rows for the wire reconciliation CSV (built and downloaded in the browser by app._index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const from = url.searchParams.get("from") || new Date().toISOString().slice(0, 10);
  const to = url.searchParams.get("to") || from;

  const rows = await prisma.glsSync.findMany({
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
    rows: rows.map((row) => ({
      sent_at_utc: row.sentAt?.toISOString(),
      shopify_order: row.orderName,
      alpha_order_id: row.alphaOrderId,
      product_type: row.productType,
      quantity: row.quantity,
      price_paid: row.pricePaid.toFixed(2),
      gls_order_name: row.glsOrderName,
      gls_order_id: row.glsOrderId,
      fulfilled_in_shopify: row.fulfilledAt ? "yes" : "no",
    })),
  };
};
