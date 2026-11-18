import type { ActionFunctionArgs } from "react-router";
import { getGlsConfig, MOCK_API_KEY } from "../gls/config.server";
import { GLS_PRODUCT_TYPES } from "../gls/payload";

// Stand-in for POST https://gls-channel-api.geneticlifespan.com/api/channels/alpha-biomed/orders (V3 spec)
// Only active when GLS_MODE=mock. Validates like the spec and returns the documented responses.
// Put "+fail500", "+fail400" or "+fail502" in the customer email to simulate errors.
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let mockOrderNumber = 1000;

// alpha_order_id -> mock order, used by the mock cancel endpoint (orders_.cancel)
type MockOrder = { order_id: number; order_name: string; cancelled_at: string | null };
declare global {
  // eslint-disable-next-line no-var
  var agecodeMockOrders: Map<string, MockOrder> | undefined;
}
export const mockOrders: Map<string, MockOrder> = (global.agecodeMockOrders ??= new Map());

type MockItem = { product_type?: string; quantity?: number; unit_price?: number };

export const loader = () => new Response("Not found", { status: 404 });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (getGlsConfig().mode !== "mock") return new Response("Not found", { status: 404 });

  const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (key !== MOCK_API_KEY) return json({ ok: false, error: "Invalid or missing API key for this channel" }, 401);

  const body = (await request.json().catch(() => null)) as {
    [field: string]: unknown;
    email?: string;
    alpha_order_id?: string;
    product_type?: string;
    quantity?: number;
    unit_price?: number;
    price_paid?: number;
    items?: MockItem[];
    shipping_address?: Record<string, string | undefined>;
  } | null;
  if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

  const email = body.email ?? "";
  if (email.includes("+fail500")) return json({ ok: false, error: "Simulated server error" }, 500);
  if (email.includes("+fail400")) return json({ ok: false, error: "Simulated validation error" }, 400);
  if (email.includes("+fail502")) return json({ ok: false, error: "Shopify error", details: { phone: ["is invalid"] } }, 502);

  const missing = ["email", "phone", "first_name", "last_name"].filter(
    (field) => body[field] === undefined || body[field] === "",
  );
  for (const field of ["address1", "city", "zip", "country"]) {
    if (!body.shipping_address?.[field]) missing.push(`shipping_address.${field}`);
  }
  if (!body.shipping_address?.province && !body.shipping_address?.state) missing.push("shipping_address.province");
  if (body.shipping_address?.address2 !== undefined) {
    return json({ ok: false, error: "address2 is not accepted; put it on address1" }, 400);
  }

  const items: MockItem[] = body.items?.length
    ? body.items
    : [{ product_type: body.product_type, quantity: body.quantity, unit_price: body.unit_price }];
  if (!body.items?.length && !body.product_type) missing.push("product_type or items");
  if (missing.length) return json({ ok: false, error: `Missing required fields: ${missing.join(", ")}` }, 400);

  const lines = [];
  for (const item of items) {
    if (!(GLS_PRODUCT_TYPES as readonly string[]).includes(item.product_type ?? "")) {
      return json({ ok: false, error: `Unknown product_type: ${item.product_type}` }, 400);
    }
    const quantity = item.quantity ?? 1;
    const unitPrice = item.unit_price ?? (body.price_paid !== undefined ? body.price_paid / quantity : undefined);
    if (unitPrice === undefined) return json({ ok: false, error: "unit_price (or price_paid) is required" }, 400);
    lines.push({
      product_type: item.product_type,
      quantity,
      unit_price: unitPrice,
      line_total: Math.round(unitPrice * quantity * 100) / 100,
    });
  }

  mockOrderNumber += 1;
  const created: MockOrder = { order_id: Date.now(), order_name: `#MOCK${mockOrderNumber}`, cancelled_at: null };
  if (body.alpha_order_id) mockOrders.set(body.alpha_order_id, created);
  return json(
    {
      ok: true,
      channel: params.channel,
      order_id: created.order_id,
      order_name: created.order_name,
      financial_status: "paid",
      fulfillment_status: "unfulfilled",
      tags: "alphabiomed_order",
      note: `Channel: ${params.channel} | External order: ${body.alpha_order_id ?? ""}`,
      items: lines,
    },
    201,
  );
};
