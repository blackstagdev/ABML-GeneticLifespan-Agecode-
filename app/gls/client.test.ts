import { describe, expect, it, vi } from "vitest";
import { cancelGlsOrder, glsCancelReason, glsCancelUrl, glsOrdersUrl, sendGlsOrder } from "./client.server";
import { getGlsConfig } from "./config.server";
import type { GlsPayload } from "./payload";

const payload: GlsPayload = {
  alpha_order_id: "#1001",
  product_type: "AgeCode Premier",
  quantity: 1,
  unit_price: 1200,
  price_paid: 1200,
  email: "provider@example.com",
  phone: "+15125550142",
  first_name: "Jane",
  last_name: "Doe",
  shipping_address: { address1: "123 Main St", city: "Austin", province: "TX", zip: "78701", country: "US" },
};

const live = getGlsConfig({ GLS_MODE: "live", GLS_API_KEY: "secret" } as NodeJS.ProcessEnv);

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const throws = (error: unknown) =>
  vi.fn(async () => {
    throw error;
  }) as unknown as typeof fetch;

describe("getGlsConfig", () => {
  it("stays in dry run without an API key, even if live is requested", () => {
    expect(getGlsConfig({ GLS_MODE: "live" } as NodeJS.ProcessEnv).mode).toBe("dry_run");
  });

  it("points mock mode at the app's own mock endpoint", () => {
    const config = getGlsConfig({ GLS_MODE: "mock", SHOPIFY_APP_URL: "https://app.example.com/" } as NodeJS.ProcessEnv);
    expect(glsOrdersUrl(config)).toBe("https://app.example.com/mock/gls/api/channels/alpha-biomed/orders");
  });

  it("uses the documented endpoint in live mode", () => {
    expect(glsOrdersUrl(live)).toBe("https://gls-channel-api.geneticlifespan.com/api/channels/alpha-biomed/orders");
  });
});

describe("sendGlsOrder", () => {
  it("does not call the API in dry run", async () => {
    const fetchImpl = respond(201, {});
    expect(await sendGlsOrder(getGlsConfig({} as NodeJS.ProcessEnv), payload, fetchImpl)).toEqual({ kind: "dry_run" });
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

  it("treats 4xx as rejected (nothing created, fix and resend)", async () => {
    for (const status of [400, 401]) {
      expect(await sendGlsOrder(live, payload, respond(status, { ok: false, error: "bad" }))).toMatchObject({
        kind: "rejected",
        status,
        message: "bad",
      });
    }
  });

  it("never treats 5xx as retryable: the order may exist (the API does not dedupe)", async () => {
    expect(await sendGlsOrder(live, payload, respond(500, { ok: false, error: "down" }))).toMatchObject({
      kind: "unknown",
      status: 500,
    });
    expect(
      await sendGlsOrder(live, payload, respond(502, { ok: false, error: "Shopify error", details: { phone: ["is invalid"] } })),
    ).toMatchObject({ kind: "unknown", message: 'Shopify error {"phone":["is invalid"]}' });
  });

  it("treats a timeout or dropped connection as unknown", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(await sendGlsOrder(live, payload, throws(timeout))).toMatchObject({ kind: "unknown" });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(await sendGlsOrder(live, payload, throws(reset))).toMatchObject({ kind: "unknown" });
  });

  it("can retry when the request never reached GLS (DNS, connection refused) or was rate limited", async () => {
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(await sendGlsOrder(live, payload, throws(dns))).toMatchObject({ kind: "not_sent" });
    expect(await sendGlsOrder(live, payload, respond(429, { ok: false, error: "slow down" }))).toMatchObject({
      kind: "not_sent",
    });
  });

  it("treats 201 without ok:true as unknown", async () => {
    expect(await sendGlsOrder(live, payload, respond(201, { ok: false, error: "nope" }))).toMatchObject({
      kind: "unknown",
    });
  });
});

describe("cancelGlsOrder (V3 section 11)", () => {
  const request = { alpha_order_id: "ABM-1001", reason: "customer" as const };

  it("posts to /orders/cancel with the API key and alpha_order_id", async () => {
    const fetchImpl = respond(200, { ok: true, already_cancelled: false, order_name: "#1005" });
    expect(await cancelGlsOrder(live, request, fetchImpl)).toMatchObject({ kind: "cancelled", alreadyCancelled: false });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(glsCancelUrl(live));
    expect(url).toBe("https://gls-channel-api.geneticlifespan.com/api/channels/alpha-biomed/orders/cancel");
    expect(init.headers["X-API-Key"]).toBe("secret");
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it("reports already_cancelled", async () => {
    expect(await cancelGlsOrder(live, request, respond(200, { ok: true, already_cancelled: true }))).toMatchObject({
      kind: "cancelled",
      alreadyCancelled: true,
    });
  });

  it("maps 409 shipped, 404, other 4xx and 502/timeout", async () => {
    const shipped = { ok: false, error: "Order has already shipped. Cancel is only available before fulfillment." };
    expect(await cancelGlsOrder(live, request, respond(409, shipped))).toMatchObject({ kind: "shipped" });
    expect(await cancelGlsOrder(live, request, respond(409, { ok: false, error: "ids do not match" }))).toMatchObject({
      kind: "rejected",
    });
    expect(await cancelGlsOrder(live, request, respond(404, { ok: false, error: "nope" }))).toMatchObject({ kind: "not_found" });
    expect(await cancelGlsOrder(live, request, respond(401, { ok: false, error: "key" }))).toMatchObject({ kind: "rejected" });
    expect(await cancelGlsOrder(live, request, respond(502, { ok: false, error: "x" }))).toMatchObject({ kind: "unknown" });
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    expect(await cancelGlsOrder(live, request, throws(timeout))).toMatchObject({ kind: "unknown" });
  });

  it("does nothing in dry run", async () => {
    const fetchImpl = respond(200, {});
    expect(await cancelGlsOrder(getGlsConfig({} as NodeJS.ProcessEnv), request, fetchImpl)).toEqual({ kind: "dry_run" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps Shopify cancel reasons to customer / declined / other", () => {
    expect(glsCancelReason("customer")).toBe("customer");
    expect(glsCancelReason("DECLINED")).toBe("declined");
    expect(glsCancelReason("fraud")).toBe("other");
    expect(glsCancelReason(undefined)).toBe("other");
  });
});
