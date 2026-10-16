// Alerts for orders that need a person (failed sends, cancellations after sending, refunds).
// Always logged. Optionally posted to a chat webhook (Slack/Teams-compatible {text})
// and/or emailed through Resend.
import { getGlsConfig } from "./config.server";

export async function sendAlert(subject: string, details: string) {
  const config = getGlsConfig();
  const text = `[AgeCode Bridge] ${subject}\n${details}`;
  console.warn(text);

  const tasks: Promise<unknown>[] = [];

  if (config.alertWebhookUrl) {
    tasks.push(
      fetch(config.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    );
  }

  if (config.resendApiKey && config.alertEmailTo) {
    tasks.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.resendApiKey}`,
        },
        body: JSON.stringify({
          from: config.alertEmailFrom,
          to: config.alertEmailTo.split(",").map((email) => email.trim()),
          subject: `[AgeCode Bridge] ${subject}`,
          text: details,
        }),
      }),
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") console.error("Alert delivery failed", result.reason);
  }
}
