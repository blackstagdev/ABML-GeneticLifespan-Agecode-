import type { ActionFunctionArgs } from "react-router";
import { getGlsConfig, MOCK_API_KEY } from "../gls/config.server";
import { mockOrders } from "./mock.gls.api.channels.$channel.orders";

// Stand-in for POST .../api/channels/alpha-biomed/orders/cancel (V3 spec, section 11). GLS_MODE=mock only.
// alpha_order_id containing "SHIPPED" -> 409, "FAIL502" -> 502; ids the mock never created -> 404.
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const loader = () => new Response("Not found", { status: 404 });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (getGlsConfig().mode !== "mock") return new Response("Not found", { status: 404 });

  const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (key !== MOCK_API_KEY) return json({ ok: false, error: "Invalid or missing API key for this channel" }, 401);

  const body = (await request.json().catch(() => null)) as { alpha_order_id?: string } | null;
  const id = body?.alpha_order_id;
  if (!id) return json({ ok: false, error: "alpha_order_id or shopify_order_id is required" }, 400);
  if (id.includes("FAIL502")) return json({ ok: false, error: "Simulated error: nothing was cancelled" }, 502);

  const order = mockOrders.get(id);
  if (!order) return json({ ok: false, error: "Order not found" }, 404);
  if (id.includes("SHIPPED")) {
    return json(
      {
        ok: false,
        error: "Order has already shipped. Cancel is only available before fulfillment.",
        alpha_order_id: id,
        order_id: order.order_id,
        order_name: order.order_name,
      },
      409,
    );
  }

  const alreadyCancelled = order.cancelled_at !== null;
  order.cancelled_at ??= new Date().toISOString();
  return json(
    {
      ok: true,
      already_cancelled: alreadyCancelled,
      channel: params.channel,
      alpha_order_id: id,
      order_id: order.order_id,
      order_name: order.order_name,
      cancelled_at: order.cancelled_at,
      financial_status: "paid",
    },
    200,
  );
};
