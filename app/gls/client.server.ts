// HTTP client for the Genetic LifeSpan channel API.
// POST {apiBase}/api/channels/{channelId}/orders with X-API-Key.
import type { GlsConfig } from "./config.server";
import type { GlsPayload } from "./payload";

export type SendResult =
  | { kind: "sent"; status: number; body: unknown; glsOrderId: string; glsOrderName: string }
  | { kind: "dry_run" }
  | { kind: "error"; status: number | null; body: unknown; message: string; retryable: boolean };

export function glsOrdersUrl(config: GlsConfig) {
  return `${config.apiBase}/api/channels/${encodeURIComponent(config.channelId)}/orders`;
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
    return {
      kind: "error",
      status: null,
      body: null,
      message: `Network error: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
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

  const message =
    typeof json.error === "string"
      ? json.error
      : `Unexpected response ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`;

  return {
    kind: "error",
    status: response.status,
    body,
    message: json.details ? `${message} ${JSON.stringify(json.details)}` : message,
    retryable: isRetryable(response.status, json),
  };
}

// 4xx = our payload or key is wrong, retrying won't help.
// 5xx / 429 = temporary, except a 502 that names bad fields (e.g. { phone: ["is invalid"] }).
export function isRetryable(status: number, json: Record<string, unknown>) {
  if (status === 429) return true;
  if (status === 502 && json.details) return false;
  return status >= 500;
}
