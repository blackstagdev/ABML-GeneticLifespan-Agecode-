// HTTP client for the Genetic LifeSpan channel API.
// POST {apiBase}/api/channels/{channelId}/orders with X-API-Key.
//
// The API does not dedupe (V2 spec, section 7):
//   201          -> created; store order_id/order_name and never resend
//   4xx          -> nothing was created; fix the payload and send again
//   5xx/timeout  -> unknown; do NOT retry, ask Genetic LifeSpan whether the alpha_order_id exists
import type { GlsConfig } from "./config.server";
import type { GlsPayload } from "./payload";

export type SendResult =
  | { kind: "sent"; status: number; body: unknown; glsOrderId: string; glsOrderName: string }
  | { kind: "dry_run" }
  // the request never reached GLS (DNS failure, connection refused) or was rate limited: safe to retry
  | { kind: "not_sent"; status: number | null; body: unknown; message: string }
  // GLS rejected it (4xx): nothing was created, needs a fix before resending
  | { kind: "rejected"; status: number; body: unknown; message: string }
  // 5xx, timeout or dropped connection: the order may or may not exist at GLS
  | { kind: "unknown"; status: number | null; body: unknown; message: string };

// Network errors that happen before the request is delivered, so nothing can have been created.
const NOT_DELIVERED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

export function glsOrdersUrl(config: GlsConfig) {
  return `${config.apiBase}/api/channels/${encodeURIComponent(config.channelId)}/orders`;
}

function errorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (error as { code?: string })?.code;
}

export async function sendGlsOrder(
  config: GlsConfig,
  payload: GlsPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (config.mode === "dry_run") return { kind: "dry_run" };

  let response: Response;
  try {
    response = await fetchImpl(glsOrdersUrl(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    const code = errorCode(error);
    const message = `Network error${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : String(error)}`;
    return code && NOT_DELIVERED_CODES.has(code)
      ? { kind: "not_sent", status: null, body: null, message }
      : { kind: "unknown", status: null, body: null, message };
  }

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  const json = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (response.status === 201 && json.ok === true) {
    return {
      kind: "sent",
      status: response.status,
      body,
      glsOrderId: String(json.order_id ?? ""),
      glsOrderName: String(json.order_name ?? ""),
    };
  }

  const reason =
    typeof json.error === "string"
      ? json.error
      : `Unexpected response ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
  const message = json.details ? `${reason} ${JSON.stringify(json.details)}` : reason;

  if (response.status === 429) return { kind: "not_sent", status: response.status, body, message };
  if (response.status >= 400 && response.status < 500) {
    return { kind: "rejected", status: response.status, body, message };
  }
  // 5xx, or a 2xx/3xx we don't understand: we can't tell whether the order was created.
  return { kind: "unknown", status: response.status, body, message };
}
