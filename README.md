# AgeCode Bridge

A Shopify custom app for **Alpha BioMed Labs**. When a provider pays for an AgeCode test on
alphabiomedlabs.com, the app sends the order to **Genetic LifeSpan's channel API** (spec **V2,
10/23/2026**). Genetic LifeSpan then ships the kit and handles registration, consent and lab work.

```
Shopify checkout (paid) ──orders/paid webhook──▶ AgeCode Bridge (Render)
                                                   │ 1. load order, keep lines whose variant has gls.product_type
                                                   │ 2. POST ONE order to GLS  /api/channels/alpha-biomed/orders
                                                   │ 3. save GLS order #, tag order "gls-sent", set metafield gls.sync
                                                   │ 4. mark the AgeCode items fulfilled (no email) so ShipStation skips them
                                                   └ never resends after a GLS 5xx/timeout (their API does not dedupe)
```

Built from Shopify's React Router app template (Node 22, Prisma + Postgres, Polaris web components).

## What it sends

- An order line is an AgeCode test when its **variant** has the metafield `gls.product_type`. The
  value must be one of:

  | Product | `gls.product_type` |
  |---|---|
  | AgeCode™ Premier | `AgeCode Premier` |
  | AgeCode™ Wellness Essentials (unisex) | `AgeCode Wellness Essentials` |
  | (future) Premier Follow-Up | `AgeCode Premier Follow-Up` |

  The V1 values `AgeCode Wellness Essentials Male` / `Female` are still accepted and sent as
  `AgeCode Wellness Essentials`. Gender is collected at kit registration.

- **One Genetic LifeSpan order per Shopify order.**
  - With one AgeCode line, the request uses the single-product fields: `product_type`, `quantity`,
    `unit_price`.
  - With several AgeCode lines, it sends an `items[]` array.
  - Other products in the order are ignored.

- **Prices:**
  - `unit_price` is the per-unit price after all discounts. Tax and shipping are not included.
  - `price_paid` is the AgeCode product total.

- **Customer details:**
  - Name, email, phone and shipping address come from the order. The phone falls back to the
    billing, order and then customer phone, and is formatted as E.164.
  - Apt/suite is appended to `address1`; the API has no `address2`.
  - `alpha_order_id` is the Shopify order name, e.g. `#1234`.

- **Test orders:**
  - Tag the order **`gls-test`** before it's paid. It's then sent with `alpha_order_id`
    `TEST-1234` and `first_name` `TEST`.
  - Setting `GLS_TEST_ORDERS=true` sends **every** order that way.
  - Genetic LifeSpan has **no sandbox**. Email them before a test run so they hold fulfillment.

## Never sending an order twice

Genetic LifeSpan's API **does not dedupe**. A repeated request creates a second order. So:

| Result | What the app does |
|---|---|
| `201` + `ok:true` | **Sent.** Stores their `order_id` / `order_name` and never sends again |
| `4xx` | Nothing was created. Status `failed`, tagged `gls-error`, alert sent. Fix the order, then **Retry** |
| `5xx`, timeout, dropped connection | **May or may not exist at GLS.** Status `needs_check`, tagged `gls-check`, alert sent. **Never resent automatically** |
| DNS failure / connection refused / `429` | Nothing reached GLS. Retried automatically after 1, 5, 30, 120 and 360 min |

The app saves `sending` **before** each POST. If it crashes mid-request, the order goes to
`needs_check` instead of being resent. For a `needs_check` order, ask Genetic LifeSpan whether the
`alpha_order_id` exists, then in the app:
- **It exists:** enter their order number and press **Mark as sent**. The app then fulfills and tags it.
- **It doesn't:** press **Resend**, which asks you to confirm.

## Order statuses

| Status | Meaning |
|---|---|
| `pending` / `processing` | Waiting to be sent / being sent |
| `retry` | Nothing reached GLS yet (Shopify API error, DNS, 429). Retried automatically |
| `done` | Accepted by GLS (and fulfilled if `AUTO_FULFILL=true`) |
| `dry_run` | Request built and saved but not sent (`GLS_MODE=dry_run`) |
| `needs_check` | GLS didn't confirm. See above |
| `failed` | Needs a person: missing phone or address, unknown product type, or GLS 4xx |
| `no_agecode` / `cancelled` | Nothing to send |

## Setup

### 1. Create the app in Shopify
1. Install Shopify CLI (`npm i -g @shopify/cli@latest`), then log in with `shopify auth login`.
2. Create the app in the Dev Dashboard under the **store's organization** (Alpha BioMed LLC), and put
   its Client ID in `shopify.app.toml`.
   - Apps in the store's own organization install directly from **Install app**; they don't need a
     distribution method.
   - Their protected customer data (name, email, phone, address) is available without review.

### 2. Deploy to Render
1. Push this repo to GitHub.
2. In Render, choose **New › Blueprint** and pick the repo. `render.yaml` creates the web service
   and a Postgres database.
3. Fill in the `sync: false` variables:
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`: Client ID and secret.
   - `SHOPIFY_APP_URL`: the service URL, e.g. `https://agecode-bridge.onrender.com`.
   - `GLS_API_KEY`: the key from Genetic LifeSpan.
   - Alerts (optional): `ALERT_WEBHOOK_URL` and/or `ALERT_EMAIL_TO` + `RESEND_API_KEY`.
4. Check that `https://<service>/healthz` returns `ok`.

### 3. Push the app config and install
1. Run `npm run deploy`. This registers the app URL, scopes and webhooks (`orders/paid`,
   `orders/cancelled`, `refunds/create`).
2. Install the app on the store from the Dev Dashboard (**Install app**).

## Environment variables

See [.env.example](.env.example) for the full list. The main ones:

| Variable | Default | |
|---|---|---|
| `GLS_MODE` | `dry_run` | `dry_run`: send nothing · `mock`: send to the built-in fake API · `live`: send to Genetic LifeSpan. `live` without `GLS_API_KEY` stays in dry run |
| `GLS_API_KEY` | | Secret from Genetic LifeSpan. Keep it in Render only |
| `GLS_API_BASE` | `https://gls-channel-api.geneticlifespan.com` | |
| `GLS_CHANNEL_ID` | `alpha-biomed` | |
| `GLS_TEST_ORDERS` | `false` | `true` sends every order in the test format |
| `GLS_TIMEOUT_MS` | `30000` | A timeout means `needs_check`, so keep it generous |
| `AUTO_FULFILL` | `true` | Mark AgeCode items fulfilled (no customer email) after GLS accepts them |
| `ALERT_WEBHOOK_URL`, `ALERT_EMAIL_TO`, `RESEND_API_KEY` | | Alerts for `failed`/`needs_check` orders, cancellations and refunds |

## Testing

1. **Unit tests:** `npm test` covers the single-product and `items[]` formats, unit prices,
   Male/Female conversion, the test format, missing data, and the never-resend rules.
2. **Dry run (default):** place a test order. The app shows it as `dry_run` with the exact request
   (open **Request** in the Details column). Nothing leaves Shopify.
3. **Mock API:** set `GLS_MODE=mock`. Orders are POSTed to a fake V2 endpoint inside this app, and
   AgeCode items get fulfilled and tagged as in production.
   - To simulate errors, put `+fail500` / `+fail502` (→ `needs_check`) or `+fail400` (→ `failed`)
     in the order email.
4. **Live test order:**
   1. Email Genetic LifeSpan first.
   2. Tag a draft order `gls-test`, then **Mark as paid**.
   3. Check that it shows `TEST-…` in the app and on their side.
5. Check in ShipStation that the fulfilled AgeCode items don't show as awaiting shipment.

## Day to day
- **Shopify admin › Apps › AgeCode Bridge:**
  - order log with Retry / Send / Mark as sent / Resend
  - "Queue order" by number (e.g. for orders paid before install)
  - **CSV export** for the daily wire reconciliation: one row per product with unit price, line
    total and GLS order number
- **On the Shopify order:**
  - tags `gls-sent` / `gls-check` / `gls-error` / `gls-dry-run`
  - metafield `gls.sync` with the GLS order number and items
  - a fulfillment whose message includes the GLS order number
- **Cancellations and refunds** of orders already sent trigger an alert only. The GLS API has no
  cancel endpoint, so contact Genetic LifeSpan.
- **Support:** Rommel at Genetic LifeSpan, rommel.aleman@geneticlifespan.com.

## Development

```bash
cp .env.example .env          # point DATABASE_URL at a local Postgres
npm install
npm run dev                   # shopify app dev (tunnel + local server)
npm test                      # unit tests
npm run graphql-codegen       # regenerate Admin API types (app/types, not committed)
npm run typecheck && npm run lint
```

Code map:
- `app/gls/payload.ts`: order → GLS V2 payload (pure, tested)
- `app/gls/client.server.ts`: GLS API client and its result rules
- `app/gls/processor.server.ts`: send, fulfill, tag, retry / needs_check
- `app/gls/worker.server.ts`: runs every minute inside the web service
- `app/gls/shopify-order.server.ts`: Admin GraphQL queries and mutations
- `app/routes/webhooks.orders.paid.tsx`: queues paid orders
- `app/routes/app._index.tsx`: admin screen
- `app/routes/mock.gls.api.channels.$channel.orders.tsx`: fake GLS V2 API (mock mode only)

Not included yet: a Shopify Function that blocks checkout when an AgeCode cart has no phone number.
Create it with `shopify app generate extension` → *Cart and checkout validation*. Until then, a
missing phone marks the order `failed` and sends an alert.
