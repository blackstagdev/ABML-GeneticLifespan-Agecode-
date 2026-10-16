import type { ActionFunctionArgs } from "react-router";
import { getGlsConfig, MOCK_API_KEY } from "../gls/config.server";
import { GLS_PRODUCT_TYPES } from "../gls/payload";

// Stand-in for POST https://gls-channel-api.geneticlifespan.com/api/channels/alpha-biomed/orders
// Only active when GLS_MODE=mock. Validates like the spec and returns the documented responses.
// Put "+fail500", "+fail400" or "+fail502" in the customer email to simulate errors.
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let mockOrderNumber = 1000;

export const loader = () => new Response("Not found", { status: 404 });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (getGlsConfig().mode !== "mock") return new Response("Not found", { status: 404 });

  const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (key !== MOCK_API_KEY) return json({ ok: false, error: "Invalid or missing API key for this channel" }, 401);

  const body = (await request.json().catch(() => null)) as {
    [field: string]: unknown;
    email?: string;
    product_type?: string;
    alpha_order_id?: string;
    shipping_address?: Record<string, string | undefined>;
  } | null;
  if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

  const email = body.email ?? "";
  if (email.includes("+fail500")) return json({ ok: false, error: "Simulated server error" }, 500);
  if (email.includes("+fail400")) return json({ ok: false, error: "Simulated validation error" }, 400);
  if (email.includes("+fail502")) return json({ ok: false, error: "Shopify error", details: { phone: ["is invalid"] } }, 502);

  const missing = ["product_type", "email", "phone", "price_paid", "first_name", "last_name"].filter(
    (field) => body[field] === undefined || body[field] === "",
  );
  for (const field of ["address1", "city", "zip", "country"]) {
    if (!body.shipping_address?.[field]) missing.push(`shipping_address.${field}`);
  }
  if (!body.shipping_address?.province && !body.shipping_address?.state) missing.push("shipping_address.province");
  if (missing.length) return json({ ok: false, error: `Missing required fields: ${missing.join(", ")}` }, 400);

  if (!(GLS_PRODUCT_TYPES as readonly string[]).includes(body.product_type ?? "")) {
    return json({ ok: false, error: `Unknown product_type: ${body.product_type}` }, 400);
  }

  mockOrderNumber += 1;
  return json(
    {
      ok: true,
      channel: params.channel,
      order_id: Date.now(),
      order_name: `#MOCK${mockOrderNumber}`,
      financial_status: "pending",
      fulfillment_status: "unfulfilled",
      tags: "alphabiomed_order",
      note: `Channel: ${params.channel} | External order: ${body.alpha_order_id ?? ""}`,
    },
    201,
  );
};
