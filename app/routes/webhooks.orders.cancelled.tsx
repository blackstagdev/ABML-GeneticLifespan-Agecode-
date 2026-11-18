import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { cancelAtGls } from "../gls/cancel.server";
import { glsCancelReason } from "../gls/client.server";

// orders/cancelled: cancel the order at Genetic LifeSpan too (V3 spec, section 11) so it doesn't ship.
// Runs in the background so Shopify gets its 200 right away; repeated webhooks are harmless
// (the cancel endpoint answers already_cancelled).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  const order = payload as { admin_graphql_api_id?: string; id?: number; name?: string; cancel_reason?: string };
  const orderGid = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;

  const sync = await prisma.glsSync.findUnique({ where: { orderGid } });
  if (sync && ["sent", "needs_check", "sending"].includes(sync.status) && sync.cancelStatus !== "cancelled") {
    void cancelAtGls(sync.jobId, glsCancelReason(order.cancel_reason), "shopify_cancel").catch((error) =>
      console.error(`GLS cancel for ${order.name} failed`, error),
    );
  }

  return new Response();
};
