import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGlsConfig } from "../gls/config.server";
import { enqueueOrder, markSentManually, requeueJob } from "../gls/processor.server";
import { findOrderGidByName } from "../gls/shopify-order.server";
import { processSoon } from "../gls/worker.server";

const STATUSES = [
  "all",
  "needs_check",
  "failed",
  "retry",
  "pending",
  "processing",
  "dry_run",
  "done",
  "no_agecode",
  "cancelled",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";
  const config = getGlsConfig();

  const [jobs, counts] = await Promise.all([
    prisma.orderJob.findMany({
      where: { shop: session.shop, ...(status !== "all" ? { status } : {}) },
      include: { sync: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.orderJob.groupBy({ by: ["status"], where: { shop: session.shop }, _count: true }),
  ]);

  return {
    status,
    config: {
      mode: config.mode,
      channelId: config.channelId,
      apiBase: config.apiBase,
      hasApiKey: Boolean(process.env.GLS_API_KEY),
      forceTest: config.forceTest,
      autoFulfill: config.autoFulfill,
      alerts: Boolean(config.alertWebhookUrl || (config.resendApiKey && config.alertEmailTo)),
    },
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count])) as Record<string, number>,
    jobs: jobs.map((job) => ({
      id: job.id,
      orderName: job.orderName,
      orderId: job.orderGid.split("/").pop(),
      status: job.status,
      lastError: job.lastError,
      nextAttemptAt: job.nextAttemptAt.toISOString(),
      createdAt: job.createdAt.toISOString(),
      sync: job.sync
        ? {
            alphaOrderId: job.sync.alphaOrderId,
            isTest: job.sync.isTest,
            summary: job.sync.summary,
            pricePaid: job.sync.pricePaid.toFixed(2),
            glsOrderName: job.sync.glsOrderName,
            fulfilled: Boolean(job.sync.fulfilledAt),
            payload: JSON.stringify(job.sync.requestPayload, null, 2),
          }
        : null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "queue") {
    const name = String(form.get("orderName") || "").trim();
    if (!name) return { ok: false, message: "Enter an order number" };
    const order = await findOrderGidByName(admin, name);
    if (!order) return { ok: false, message: `Order ${name} not found` };
    const job = await enqueueOrder(session.shop, order.id, order.name);
    if (job.status !== "pending") {
      try {
        await requeueJob(job.id);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    processSoon(job.id);
    return { ok: true, message: `${order.name} queued` };
  }

  const job = await prisma.orderJob.findFirst({ where: { id: String(form.get("jobId")), shop: session.shop } });
  if (!job) return { ok: false, message: "Order not found" };

  try {
    if (intent === "retry" || intent === "resend") {
      await requeueJob(job.id, { resend: intent === "resend" });
      processSoon(job.id);
      return { ok: true, message: `${job.orderName ?? "Order"} queued` };
    }
    if (intent === "mark_sent") {
      await markSentManually(job.id, String(form.get("glsOrderName") || "").trim());
      processSoon(job.id);
      return { ok: true, message: `${job.orderName ?? "Order"} marked as sent` };
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  return { ok: false, message: "Unknown action" };
};

const MODE_BANNER = {
  dry_run: {
    tone: "warning",
    heading: "Dry run: nothing is sent to Genetic LifeSpan",
    text: "Orders are checked and the request is saved here, but not sent. Set GLS_MODE=live in Render to start sending, then press Send on the dry-run orders that should go to Genetic LifeSpan.",
  },
  mock: {
    tone: "info",
    heading: "Mock mode: orders go to the built-in test API",
    text: "Orders are sent to a fake Genetic LifeSpan endpoint inside this app, and AgeCode items are fulfilled and tagged as in production. Use test orders only.",
  },
  live: {
    tone: "success",
    heading: "Live: paid AgeCode orders are sent to Genetic LifeSpan",
    text: "Tag an order gls-test before it is paid to send it as a test order (TEST- prefix, first name TEST). Email Genetic LifeSpan before a test run so they hold fulfillment.",
  },
} as const;

const STATUS_TONE: Record<string, "success" | "critical" | "warning" | "info" | "neutral"> = {
  done: "success",
  failed: "critical",
  needs_check: "critical",
  retry: "warning",
  pending: "info",
  processing: "info",
  dry_run: "warning",
  no_agecode: "neutral",
  cancelled: "neutral",
};

const label = (status: string) => status.replace("_", " ");

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
}

export default function Index() {
  const { config, counts, jobs, status } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const exporter = useFetcher<{ rows: Record<string, unknown>[]; from: string; to: string }>();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();
  const [orderName, setOrderName] = useState("");
  const [glsOrderNames, setGlsOrderNames] = useState<Record<string, string>>({});
  const [confirmResend, setConfirmResend] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (!exporter.data) return;
    if (!exporter.data.rows.length) {
      shopify.toast.show("No orders sent to Genetic LifeSpan in that range");
      return;
    }
    const blob = new Blob([toCsv(exporter.data.rows)], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `agecode-gls-${exporter.data.from}-to-${exporter.data.to}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }, [exporter.data, shopify]);

  const banner = MODE_BANNER[config.mode];
  const busy = fetcher.state !== "idle";
  const submit = (data: Record<string, string>) => fetcher.submit(data, { method: "POST" });

  return (
    <s-page heading="AgeCode Bridge">
      <s-banner tone={banner.tone} heading={banner.heading}>
        {banner.text}
      </s-banner>

      {counts.needs_check ? (
        <s-banner tone="critical" heading={`${counts.needs_check} order(s) need checking with Genetic LifeSpan`}>
          Genetic LifeSpan didn&apos;t confirm these orders (server error or timeout), so they may or may not exist on
          their side. Their API doesn&apos;t detect duplicates, so the app never resends them automatically. Ask Genetic
          LifeSpan about the alpha_order_id, then press &quot;Mark as sent&quot; or &quot;Resend&quot;.
        </s-banner>
      ) : null}

      <s-section heading="Settings">
        <s-unordered-list>
          <s-list-item>
            Endpoint: {config.apiBase}/api/channels/{config.channelId}/orders
          </s-list-item>
          <s-list-item>API key: {config.hasApiKey ? "set" : "not set"}</s-list-item>
          <s-list-item>
            Test orders: {config.forceTest ? "ALL orders are sent as test orders (GLS_TEST_ORDERS)" : "orders tagged gls-test"}
          </s-list-item>
          <s-list-item>
            Mark AgeCode items fulfilled after sending: {config.autoFulfill ? "on" : "off"}
          </s-list-item>
          <s-list-item>Failure alerts: {config.alerts ? "on" : "not configured (logs only)"}</s-list-item>
        </s-unordered-list>
        <s-paragraph>These come from environment variables in Render.</s-paragraph>
      </s-section>

      <s-section heading="Send an order">
        <s-paragraph>
          Queue an order by number, for example one paid before the app was installed. An order Genetic LifeSpan
          already accepted is never sent twice.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field
            label="Order number"
            placeholder="#1234"
            value={orderName}
            onChange={(event) => setOrderName(event.currentTarget.value)}
          />
          <s-button {...(busy ? { loading: true } : {})} onClick={() => submit({ intent: "queue", orderName })}>
            Queue order
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Orders">
        <s-stack direction="inline" gap="small">
          {STATUSES.map((value) => (
            <s-button
              key={value}
              variant={value === status ? "primary" : "secondary"}
              onClick={() => setSearchParams(value === "all" ? {} : { status: value })}
            >
              {label(value)}
              {value !== "all" && counts[value] ? ` (${counts[value]})` : ""}
            </s-button>
          ))}
        </s-stack>

        <s-table>
          <s-table-header-row>
            <s-table-header>Order</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Sent to Genetic LifeSpan</s-table-header>
            <s-table-header>Details</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {jobs.map((job) => (
              <s-table-row key={job.id}>
                <s-table-cell>
                  <s-link href={`shopify://admin/orders/${job.orderId}`} target="_blank">
                    {job.orderName ?? job.orderId}
                  </s-link>
                  <s-paragraph>{new Date(job.createdAt).toLocaleString()}</s-paragraph>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONE[job.status] ?? "neutral"}>{label(job.status)}</s-badge>
                  {job.status === "retry" ? (
                    <s-paragraph>next try {new Date(job.nextAttemptAt).toLocaleTimeString()}</s-paragraph>
                  ) : null}
                </s-table-cell>
                <s-table-cell>
                  {job.sync ? (
                    <>
                      <s-paragraph>
                        {job.sync.alphaOrderId}
                        {job.sync.isTest ? " (test)" : ""}: {job.sync.summary}, ${job.sync.pricePaid}
                      </s-paragraph>
                      {job.sync.glsOrderName ? (
                        <s-paragraph>
                          GLS order {job.sync.glsOrderName}
                          {job.sync.fulfilled ? " · fulfilled in Shopify" : ""}
                        </s-paragraph>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                </s-table-cell>
                <s-table-cell>
                  {job.lastError ? <s-paragraph>{job.lastError}</s-paragraph> : null}
                  {job.sync ? (
                    <details>
                      <summary>Request</summary>
                      <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px" }}>{job.sync.payload}</pre>
                    </details>
                  ) : null}
                </s-table-cell>
                <s-table-cell>
                  {job.status === "needs_check" ? (
                    <s-stack gap="small">
                      <s-text-field
                        label="GLS order number"
                        placeholder="#1005"
                        value={glsOrderNames[job.id] ?? ""}
                        onChange={(event) =>
                          setGlsOrderNames((names) => ({ ...names, [job.id]: event.currentTarget.value }))
                        }
                      />
                      <s-button
                        variant="secondary"
                        onClick={() =>
                          submit({ intent: "mark_sent", jobId: job.id, glsOrderName: glsOrderNames[job.id] ?? "" })
                        }
                      >
                        Mark as sent
                      </s-button>
                      {confirmResend === job.id ? (
                        <>
                          <s-paragraph>Only if Genetic LifeSpan confirmed this order does NOT exist on their side.</s-paragraph>
                          <s-button
                            variant="primary"
                            tone="critical"
                            onClick={() => {
                              setConfirmResend(null);
                              submit({ intent: "resend", jobId: job.id });
                            }}
                          >
                            Yes, resend
                          </s-button>
                          <s-button variant="tertiary" onClick={() => setConfirmResend(null)}>
                            Cancel
                          </s-button>
                        </>
                      ) : (
                        <s-button variant="tertiary" tone="critical" onClick={() => setConfirmResend(job.id)}>
                          Resend
                        </s-button>
                      )}
                    </s-stack>
                  ) : null}
                  {["failed", "retry", "dry_run", "cancelled"].includes(job.status) ? (
                    <s-button variant="secondary" onClick={() => submit({ intent: "retry", jobId: job.id })}>
                      {job.status === "dry_run" ? "Send" : "Retry"}
                    </s-button>
                  ) : null}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!jobs.length ? <s-paragraph>No orders yet.</s-paragraph> : null}
      </s-section>

      <s-section heading="Export for wire reconciliation">
        <s-paragraph>
          Orders accepted by Genetic LifeSpan, by the date they were sent (UTC): one row per product with Alpha order
          ID, unit price and GLS order number.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-date-field label="From" value={from} onChange={(event) => setFrom(event.currentTarget.value)} />
          <s-date-field label="To" value={to} onChange={(event) => setTo(event.currentTarget.value)} />
          <s-button
            {...(exporter.state !== "idle" ? { loading: true } : {})}
            onClick={() => exporter.load(`/app/export?from=${from}&to=${to}`)}
          >
            Download CSV
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
