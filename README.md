# AgeCode Bridge

A Shopify custom app for **Alpha BioMed Labs**. When a provider pays for an AgeCode test on
alphabiomedlabs.com, the app sends the order to **Genetic LifeSpan's channel API**. Genetic LifeSpan
then ships the kit and handles registration, consent and lab work.

```
Shopify checkout (paid) ──orders/paid webhook──▶ AgeCode Bridge (Render)
                                                   │ 1. load order, keep lines whose variant has gls.product_type
                                                   │ 2. POST each line to GLS  /api/channels/alpha-biomed/orders
                                                   │ 3. save GLS order #, tag order "gls-sent", set metafield gls.sync
                                                   │ 4. mark the AgeCode items fulfilled (no email) so ShipStation skips them
                                                   └ retries temporary failures, alerts on the rest
```

Built from Shopify's React Router app template (Node 22, Prisma + Postgres, Polaris web components).

## How it decides what to send

- An order line is an AgeCode test when its **variant** has the metafield `gls.product_type`. Each
  value must be one of the strings Genetic LifeSpan expects:

  | Variant | `gls.product_type` |
  |---|---|
  | AgeCode™ Premier | `AgeCode Premier` |
  | AgeCode™ Wellness Essentials / Male | `AgeCode Wellness Essentials Male` |
  | AgeCode™ Wellness Essentials / Female | `AgeCode Wellness Essentials Female` |
  | (future) Premier Follow-Up | `AgeCode Premier Follow-Up` |

- Each AgeCode line becomes **one API call**. Other products in the same order are ignored.
- The payload is built from the order:
  - `alpha_order_id`: the Shopify order name (`#1234`), plus `-2`, `-3` and so on when the order
    has several AgeCode lines.
  - `price_paid`: the line total after discounts. Set `GLS_PRICE_MODE=unit` to send it per unit.
  - Name, email, phone and shipping address come from the order. The phone falls back to the
    billing, order and then customer phone, and is formatted as E.164.
- **Never sent twice:** each line is stored with a unique key (order + line item). Lines GLS has
  already accepted are skipped on retries and on duplicate webhooks.

## Statuses

| Order status | Meaning |
|---|---|
| `pending` / `processing` | Waiting to be sent / being sent |
| `retry` | A temporary failure (GLS 5xx/429, network, Shopify API). Retried after 1, 5, 30, 120 and 360 min |
| `done` | Every AgeCode line was accepted by GLS (and fulfilled if `AUTO_FULFILL=true`) |
| `dry_run` | Payloads built and saved but not sent (`GLS_MODE=dry_run`) |
| `failed` | Needs a person: missing phone or address, GLS 4xx, or retries used up. The order is tagged `gls-error` and an alert is sent |
| `no_agecode` / `cancelled` | Nothing to send |

## Setup

### 1. Create the app in Shopify
1. Install Shopify CLI (`npm i -g @shopify/cli@latest`), then log in with `shopify auth login`.
2. In this folder, run `npm install`, then `npm run config:link`, and choose **Create a new app**
   ("AgeCode Bridge"). This fills in `client_id` in `shopify.app.toml`.
3. In the Dev Dashboard, set the app's **distribution** to **Custom distribution** for the Alpha
   BioMed store.
4. **Protected customer data:** the app reads customer name, email, phone and address. Under the
   app's API access, request access to protected customer data and those fields. Without this,
   orders arrive without customer details.

### 2. Deploy to Render
1. Push this repo to GitHub.
2. In Render, choose **New › Blueprint** and pick the repo. `render.yaml` creates the web service
   and a Postgres database.
3. Fill in the `sync: false` variables:
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`: Client ID and secret from the Dev Dashboard.
   - `SHOPIFY_APP_URL`: the service URL, e.g. `https://agecode-bridge.onrender.com`.
   - `GLS_API_KEY`: leave empty until Genetic LifeSpan delivers it.
   - Alerts (optional): `ALERT_WEBHOOK_URL` (Slack/Teams incoming webhook) and/or
     `ALERT_EMAIL_TO` + `RESEND_API_KEY`.
4. Check that `https://<service>/healthz` returns `ok`.

### 3. Push the app config and install
1. Put the Render URL in `shopify.app.toml` (`application_url` and `auth.redirect_urls`).
2. Run `npm run deploy`. This registers the scopes and webhooks (`orders/paid`,
   `orders/cancelled`, `refunds/create`) with Shopify.
3. Install the app on the store from the Dev Dashboard. It appears in Shopify admin as **AgeCode Bridge**.

## Environment variables

See [.env.example](.env.example) for the full list. The main ones:

| Variable | Default | |
|---|---|---|
| `GLS_MODE` | `dry_run` | `dry_run`: send nothing · `mock`: send to the built-in fake API · `live`: send to Genetic LifeSpan. `live` without `GLS_API_KEY` stays in dry run |
| `GLS_API_KEY` | | Secret from Genetic LifeSpan (1Password link). Keep it in Render only |
| `GLS_API_BASE` | `https://gls-channel-api.geneticlifespan.com` | |
| `GLS_CHANNEL_ID` | `alpha-biomed` | |
| `GLS_PRICE_MODE` | `line_total` | or `unit` |
| `AUTO_FULFILL` | `true` | Mark AgeCode items fulfilled (no customer email) after GLS accepts them |
| `ALERT_WEBHOOK_URL`, `ALERT_EMAIL_TO`, `RESEND_API_KEY` | | Failure, cancellation and refund alerts |

## Testing before the API key arrives

1. **Unit tests:** `npm test` covers payload mapping, phone formatting, prices, missing data, and
   the API client's success, dry-run and retry rules.
2. **Dry run (default):** place a test order. In the app, the order shows as `dry_run` with the
   exact payload that would be sent. Nothing leaves Shopify, and the order is tagged `gls-dry-run`.
3. **Mock API:** set `GLS_MODE=mock`. Orders are POSTed to `/mock/gls/api/channels/alpha-biomed/orders`
   inside this app, which validates them like the spec and answers `201` with a fake `#MOCK…` order
   number. AgeCode items then get fulfilled and tagged exactly as in production, so use test orders.
   - To simulate errors, put `+fail500` (retry), `+fail400` (failed) or `+fail502` (bad phone) in
     the order's email, e.g. `test+fail500@example.com`.
4. Check in ShipStation that the fulfilled AgeCode items don't show as awaiting shipment.

## Going live
1. Store the API key from Genetic LifeSpan in Render as `GLS_API_KEY`, and set `GLS_MODE=live`.
2. Confirm with Genetic LifeSpan (Rommel):
   - Is `price_paid` per unit or the line total?
   - Is `address2` accepted?
   - Which ship-to states are allowed?
   - Is a repeated `alpha_order_id` (`#1234`, `#1234-2`) fine?
   - Is there a sandbox?
3. Press **Send** on any `dry_run` orders that should go to GLS.
4. Place one real order agreed with Genetic LifeSpan and confirm it appears on their side tagged
   `alphabiomed_order`.

## Day to day
- **Shopify admin › Apps › AgeCode Bridge:** order log, Retry/Send buttons, "Queue order" by
  number (e.g. for orders paid before install), and a **CSV export** for the daily wire
  reconciliation.
- **On the Shopify order:** tags `gls-sent` / `gls-error` / `gls-dry-run`, metafield `gls.sync`
  (GLS order numbers), and a fulfillment with the GLS order number in its message.
- **Cancellations and refunds** of orders already sent trigger an alert only. The GLS API has no
  cancel endpoint, so contact Genetic LifeSpan.

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
- `app/gls/payload.ts`: order → GLS payload (pure, tested)
- `app/gls/client.server.ts`: GLS API client
- `app/gls/processor.server.ts`: send, fulfill, tag, retry
- `app/gls/worker.server.ts`: runs every minute inside the web service
- `app/gls/shopify-order.server.ts`: Admin GraphQL queries and mutations
- `app/routes/webhooks.orders.paid.tsx`: queues paid orders
- `app/routes/app._index.tsx`: admin screen
- `app/routes/mock.gls.api.channels.$channel.orders.tsx`: fake GLS API (mock mode only)

Not included yet: a Shopify Function that blocks checkout when an AgeCode cart has no phone number.
Create it after the app is linked, with `shopify app generate extension` → *Cart and checkout
validation*. Until then, a missing phone marks the order `failed` and sends an alert.
