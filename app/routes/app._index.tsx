import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGlsConfig } from "../gls/config.server";
import { enqueueOrder, requeueJob } from "../gls/processor.server";
import { findOrderGidByName } from "../gls/shopify-order.server";
import { processSoon } from "../gls/worker.server";

const STATUSES = ["all", "failed", "retry", "pending", "processing", "dry_run", "done", "no_agecode", "cancelled"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";
  const config = getGlsConfig();

  const [jobs, counts] = await Promise.all([
    prisma.orderJob.findMany({
      where: { shop: session.shop, ...(status !== "all" ? { status } : {}) },
      include: { lines: { orderBy: { alphaOrderId: "asc" } } },
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
      priceMode: config.priceMode,
      autoFulfill: config.autoFulfill,
      alerts: Boolean(config.alertWebhookUrl || (config.resendApiKey && config.alertEmailTo)),
    },
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count])) as Record<string, number>,
    jobs: jobs.map((job) => ({
      id: job.id,
      orderName: job.orderName,
      orderId: job.orderGid.split("/").pop(),
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError,
      nextAttemptAt: job.nextAttemptAt.toISOString(),
      createdAt: job.createdAt.toISOString(),
      lines: job.lines.map((line) => ({
        id: line.id,
        alphaOrderId: line.alphaOrderId,
        productType: line.productType,
        quantity: line.quantity,
        status: line.status,
        glsOrderName: line.glsOrderName,
        fulfilled: Boolean(line.fulfilledAt),
      })),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "retry") {
    const job = await prisma.orderJob.findFirst({ where: { id: String(form.get("jobId")), shop: session.shop } });
    if (!job) return { ok: false, message: "Job not found" };
    await requeueJob(job.id);
    processSoon(job.id);
    return { ok: true, message: `${job.orderName ?? "Order"} queued again` };
  }

  if (intent === "queue") {
    const name = String(form.get("orderName") || "").trim();
    if (!name) return { ok: false, message: "Enter an order number" };
    const order = await findOrderGidByName(admin, name);
    if (!order) return { ok: false, message: `Order ${name} not found` };
    const job = await enqueueOrder(session.shop, order.id, order.name);
    if (job.status !== "pending") await requeueJob(job.id);
    processSoon(job.id);
    return { ok: true, message: `${order.name} queued` };
  }

  return { ok: false, message: "Unknown action" };
};

const MODE_BANNER = {
  dry_run: {
    tone: "warning",
    heading: "Dry run: nothing is sent to Genetic LifeSpan",
    text: "Orders are checked and payloads are saved here, but not sent. Set GLS_API_KEY and GLS_MODE=live in Render when Genetic LifeSpan delivers the API key, then press Retry on the dry-run orders.",
  },
  mock: {
    tone: "info",
    heading: "Mock mode: orders go to the built-in test API",
    text: "Orders are sent to a fake Genetic LifeSpan endpoint inside this app, and AgeCode items are fulfilled and tagged as in production. Use a test store or test orders only.",
  },
  live: {
    tone: "success",
    heading: "Live: paid AgeCode orders are sent to Genetic LifeSpan",
    text: "",
  },
} as const;

const STATUS_TONE: Record<string, "success" | "critical" | "warning" | "info" | "neutral"> = {
  done: "success",
  sent: "success",
  failed: "critical",
  retry: "warning",
  pending: "info",
  processing: "info",
  dry_run: "warning",
  no_agecode: "neutral",
  cancelled: "neutral",
};

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

  return (
    <s-page heading="AgeCode Bridge">
      <s-banner tone={banner.tone} heading={banner.heading}>
        {banner.text}
      </s-banner>

      <s-section heading="Settings">
        <s-unordered-list>
          <s-list-item>
            Endpoint: {config.apiBase}/api/channels/{config.channelId}/orders
          </s-list-item>
          <s-list-item>API key: {config.hasApiKey ? "set" : "not set"}</s-list-item>
          <s-list-item>
            price_paid: {config.priceMode === "unit" ? "per unit" : "line total after discounts"}
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
          Queue an order by number, for example one paid before the app was installed. Lines already
          accepted by Genetic LifeSpan are never sent twice.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field
            label="Order number"
            placeholder="#1234"
            value={orderName}
            onChange={(event) => setOrderName(event.currentTarget.value)}
          />
          <s-button
            {...(busy ? { loading: true } : {})}
            onClick={() => fetcher.submit({ intent: "queue", orderName }, { method: "POST" })}
          >
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
              {value.replace("_", " ")}
              {value !== "all" && counts[value] ? ` (${counts[value]})` : ""}
            </s-button>
          ))}
        </s-stack>

        <s-table>
          <s-table-header-row>
            <s-table-header>Order</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>AgeCode lines</s-table-header>
            <s-table-header>Last error</s-table-header>
            <s-table-header>Received</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {jobs.map((job) => (
              <s-table-row key={job.id}>
                <s-table-cell>
                  <s-link href={`shopify://admin/orders/${job.orderId}`} target="_blank">
                    {job.orderName ?? job.orderId}
                  </s-link>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONE[job.status] ?? "neutral"}>{job.status.replace("_", " ")}</s-badge>
                  {job.status === "retry" ? (
                    <s-text> next try {new Date(job.nextAttemptAt).toLocaleTimeString()}</s-text>
                  ) : null}
                </s-table-cell>
                <s-table-cell>
                  {job.lines.length
                    ? job.lines.map((line) => (
                        <s-paragraph key={line.id}>
                          {line.alphaOrderId}: {line.productType} ×{line.quantity}{" "}
                          <s-badge tone={STATUS_TONE[line.status] ?? "neutral"}>{line.status.replace("_", " ")}</s-badge>
                          {line.glsOrderName ? ` GLS ${line.glsOrderName}` : ""}
                          {line.fulfilled ? " · fulfilled" : ""}
                        </s-paragraph>
                      ))
                    : "—"}
                </s-table-cell>
                <s-table-cell>{job.lastError ?? ""}</s-table-cell>
                <s-table-cell>{new Date(job.createdAt).toLocaleString()}</s-table-cell>
                <s-table-cell>
                  {["failed", "retry", "dry_run", "cancelled"].includes(job.status) ? (
                    <s-button
                      variant="secondary"
                      onClick={() => fetcher.submit({ intent: "retry", jobId: job.id }, { method: "POST" })}
                    >
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
          Lines accepted by Genetic LifeSpan, by the date they were sent (UTC), with Alpha order ID and GLS
          order number.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-date-field
            label="From"
            value={from}
            onChange={(event) => setFrom(event.currentTarget.value)}
          />
          <s-date-field
            label="To"
            value={to}
            onChange={(event) => setTo(event.currentTarget.value)}
          />
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
