// Runtime configuration, read from environment variables (set in Render).
// See .env.example for the full list.

export type GlsMode = "live" | "dry_run" | "mock";

export interface GlsConfig {
  mode: GlsMode;
  apiBase: string;
  channelId: string;
  apiKey: string;
  // send every order in the V2 test format (TEST- prefix, first name TEST)
  forceTest: boolean;
  autoFulfill: boolean;
  maxAttempts: number;
  requestTimeoutMs: number;
  alertWebhookUrl: string;
  alertEmailTo: string;
  resendApiKey: string;
  alertEmailFrom: string;
}

export const MOCK_API_KEY = "mock-key";

function bool(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getGlsConfig(env: NodeJS.ProcessEnv = process.env): GlsConfig {
  const requested = (env.GLS_MODE || "").toLowerCase();
  // Without an API key we never call the real endpoint.
  let mode: GlsMode = "dry_run";
  if (requested === "mock") mode = "mock";
  else if (requested === "live" && env.GLS_API_KEY) mode = "live";

  const appUrl = (env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

  return {
    mode,
    apiBase:
      mode === "mock"
        ? `${appUrl}/mock/gls`
        : (env.GLS_API_BASE || "https://gls-channel-api.geneticlifespan.com").replace(/\/$/, ""),
    channelId: env.GLS_CHANNEL_ID || "alpha-biomed",
    apiKey: mode === "mock" ? MOCK_API_KEY : env.GLS_API_KEY || "",
    forceTest: bool(env.GLS_TEST_ORDERS, false),
    autoFulfill: bool(env.AUTO_FULFILL, true),
    maxAttempts: Number(env.GLS_MAX_ATTEMPTS) || 6,
    // Generous: a timeout leaves the order in "needs check" (the API can't be retried safely).
    requestTimeoutMs: Number(env.GLS_TIMEOUT_MS) || 30000,
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || "",
    alertEmailTo: env.ALERT_EMAIL_TO || "",
    resendApiKey: env.RESEND_API_KEY || "",
    alertEmailFrom: env.ALERT_EMAIL_FROM || "AgeCode Bridge <alerts@alphabiomedlabs.com>",
  };
}

// Minutes to wait before attempt N+1 (index = attempts already made - 1).
// Only used for failures where nothing reached Genetic LifeSpan (Shopify API errors, DNS, 429).
export const RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 360];

export function nextAttemptDelayMs(attempts: number) {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MINUTES.length - 1);
  return RETRY_BACKOFF_MINUTES[index] * 60 * 1000;
}
