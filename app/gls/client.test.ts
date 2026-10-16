import { describe, expect, it, vi } from "vitest";
import { glsOrdersUrl, sendGlsOrder } from "./client.server";
import { getGlsConfig } from "./config.server";
import type { GlsPayload } from "./payload";

const payload: GlsPayload = {
  alpha_order_id: "#1001",
  product_type: "AgeCode Premier",
  quantity: 1,
  price_paid: 399,
  email: "provider@example.com",
  phone: "+15125550142",
  first_name: "Jane",
  last_name: "Doe",
  shipping_address: { address1: "123 Main St", city: "Austin", province: "TX", zip: "78701", country: "US" },
};

const live = getGlsConfig({ GLS_MODE: "live", GLS_API_KEY: "secret" } as NodeJS.ProcessEnv);

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("getGlsConfig", () => {
  it("stays in dry run without an API key, even if live is requested", () => {
    expect(getGlsConfig({ GLS_MODE: "live" } as NodeJS.ProcessEnv).mode).toBe("dry_run");
  });

  it("points mock mode at the app's own mock endpoint", () => {
    const config = getGlsConfig({ GLS_MODE: "mock", SHOPIFY_APP_URL: "https://app.example.com/" } as NodeJS.ProcessEnv);
    expect(glsOrdersUrl(config)).toBe("https://app.example.com/mock/gls/api/channels/alpha-biomed/orders");
  });

  it("uses the documented endpoint in live mode", () => {
    expect(glsOrdersUrl(live)).toBe(
      "https://gls-channel-api.geneticlifespan.com/api/channels/alpha-biomed/orders",
    );
  });
});

describe("sendGlsOrder", () => {
  it("does not call the API in dry run", async () => {
    const fetchImpl = respond(201, {});
    const result = await sendGlsOrder(getGlsConfig({} as NodeJS.ProcessEnv), payload, fetchImpl);
    expect(result).toEqual({ kind: "dry_run" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the key in X-API-Key and reads the GLS order number", async () => {
    const fetchImpl = respond(201, { ok: true, order_id: 1234567890, order_name: "#1005" });
    const result = await sendGlsOrder(live, payload, fetchImpl);
    expect(result).toMatchObject({ kind: "sent", glsOrderId: "1234567890", glsOrderName: "#1005" });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-API-Key"]).toBe("secret");
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("does not retry validation or auth errors", async () => {
    for (const status of [400, 401]) {
      const result = await sendGlsOrder(live, payload, respond(status, { ok: false, error: "bad" }));
      expect(result).toMatchObject({ kind: "error", status, retryable: false, message: "bad" });
    }
  });

  it("retries server errors but not a 502 that names bad fields", async () => {
    expect(await sendGlsOrder(live, payload, respond(500, { ok: false, error: "down" }))).toMatchObject({
      retryable: true,
    });
    expect(
      await sendGlsOrder(live, payload, respond(502, { ok: false, error: "Shopify error", details: { phone: ["is invalid"] } })),
    ).toMatchObject({ retryable: false, message: 'Shopify error {"phone":["is invalid"]}' });
  });

  it("treats 201 without ok:true as a failure", async () => {
    expect(await sendGlsOrder(live, payload, respond(201, { ok: false, error: "nope" }))).toMatchObject({
      kind: "error",
    });
  });

  it("retries network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await sendGlsOrder(live, payload, fetchImpl)).toMatchObject({ kind: "error", retryable: true });
  });
});
