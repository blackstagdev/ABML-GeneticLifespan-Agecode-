import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueueOrder } from "../gls/processor.server";
import { processSoon } from "../gls/worker.server";

// orders/paid: queue the order and answer Shopify right away (it expects a reply within 5 seconds).
// The order is processed straight after; the worker retries anything that fails.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const order = payload as { admin_graphql_api_id?: string; id?: number; name?: string };
  const orderGid = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;

  console.log(`Received ${topic} for ${order.name ?? orderGid} on ${shop}`);
  const job = await enqueueOrder(shop, orderGid, order.name);
  processSoon(job.id);

  return new Response();
};
