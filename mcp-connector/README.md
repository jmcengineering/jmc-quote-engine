# JMC Quote Engine — Claude connector

Lets Claude price and save quotes in the JMC Quote Engine from claude.ai on the web, the
Claude mobile apps, Claude Desktop and Claude Code. It is a remote MCP server running on a
Cloudflare Worker (free plan is enough).

- Prices with **the same costing code as the web app**: `npm run build` copies it out of
  `../index.html` (the block between `ENGINE-START` and `ENGINE-END`), so the two can't drift.
- Reads the **Rate Master** from the app's `_settings.json`, and saves quotes into the **same
  OneDrive folder** the app uses, so they appear under **Saved Quotes**. Load one there and
  use **Export PDF** for the customer copy.
- Each person signs in with **their own JMC Microsoft account**; the connector works in their
  OneDrive with their permissions. Same allowlist as the app (`@jmcengg.com` plus listed emails).

## What Claude can do

| Tool | What it does | Changes anything? |
|---|---|---|
| `get_rate_master` | Materials (₹/kg, density, HT rate), processes (Auto/Manual), stock allowance, default margin | No |
| `list_quotes` | Saved quotes with customer, part name, status, total; search and status filter | No |
| `get_quote` | One saved quote, priced with the rates stored in it | No |
| `price_quote` | Full price breakdown for a proposed quote, **without saving** | No |
| `save_quote` | Save a quote (next `JMC-QT-###` number, or one you give). Stores the rates it used, like the app. Won't replace an existing quote unless told to | Yes |
| `update_quote_status` | Open / Sent / Won / Lost / On-Hold. Never re-prices | Yes |

It never writes the Rate Master, never deletes anything, and never touches the app's crash-recovery file.

Example requests:

> Quote Rane Group for a position gauge: base plate MS block 20 × 150 × 200, qty 1, milling ₹2,500, grinding ₹800;
> two OHNS locating pins Ø12 × 40, wire cut ₹300 each; 4 guide bushes bought out at ₹450. Add design costing ₹3,000.
> Show me the breakdown first.

> Which quotes for TVS are still Open? Mark JMC-QT-141 as Won.

## One-time setup

You need: a Cloudflare account (free), access to the Azure portal for the JMC tenant (or your
Microsoft 365 admin), and Node.js 20+ on the machine you deploy from.

### 1. Install and create the token store

```sh
cd mcp-connector
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` it prints into `wrangler.jsonc` (`kv_namespaces` → `id`).

### 2. Decide the connector's address

Either the Worker's own address, `https://jmc-quote-connector.<your-subdomain>.workers.dev`
(your workers.dev subdomain is shown in the Cloudflare dashboard under Workers & Pages), or a
custom domain such as `https://quotes-ai.jmcengg.com`. Put it in `wrangler.jsonc` as
`PUBLIC_URL`, with no trailing slash.

### 3. Register the connector with Microsoft Entra ID

Azure portal → **Microsoft Entra ID → App registrations → New registration**:

- **Name:** `JMC Quote Engine – Claude connector`
- **Supported account types:** Accounts in this organizational directory only
- **Redirect URI:** platform **Web**, value `PUBLIC_URL` + `/callback`
  (e.g. `https://jmc-quote-connector.example.workers.dev/callback`)

Then, in the new registration:

- **Overview:** copy the **Application (client) ID** into `wrangler.jsonc` as `MS_CLIENT_ID`.
  `MS_TENANT_ID` is already set to the JMC tenant.
- **Certificates & secrets → New client secret.** Copy the secret **Value** (shown once).
- **API permissions → Add → Microsoft Graph → Delegated:** `User.Read`, `Files.ReadWrite`,
  `offline_access`, `openid`, `profile`, `email`. Then **Grant admin consent** so staff
  aren't each asked to consent.

This is a separate registration from the web app's, so nothing about the web app's sign-in changes.

### 4. Deploy

```sh
npx wrangler secret put MS_CLIENT_SECRET     # paste the secret Value from step 3
npm run deploy
```

If staff use a OneDrive folder name other than `JMC Quotations` (Rate Master → OneDrive Storage
in the app), set the same name as `ONEDRIVE_FOLDER` in `wrangler.jsonc` before deploying.

Open `PUBLIC_URL` in a browser: you should see a page giving the connector URL.

### 5. Add it to Claude

- **Pro / Max:** claude.ai → **Settings → Connectors → Add custom connector**.
- **Team / Enterprise:** an Owner adds it under **Organization settings → Connectors**, then
  each member connects it from their own Settings → Connectors.

Name: `JMC Quote Engine`. URL: `PUBLIC_URL` + `/mcp`. Leave **Advanced settings** empty:
Claude registers itself. Click **Connect**, confirm on the JMC page, and sign in with your
JMC Microsoft account. Once connected on the web it is available in the Claude mobile and
desktop apps too. For Claude Code: `claude mcp add --transport http jmc-quotes PUBLIC_URL/mcp`.

## Keeping it running

- **After changing the costing logic in the web app**, run `npm run deploy` again so the
  connector picks up the same code. (Rate changes made in Rate Master need nothing: the
  connector reads them live from OneDrive.)
- **The Entra client secret expires** (you choose 6–24 months when creating it). Before it
  does, create a new one and run `npx wrangler secret put MS_CLIENT_SECRET`. If it lapses,
  connecting fails with a Microsoft sign-in error until it's replaced.
- Sign-ins last 30 days from last use; after that, or if someone's Microsoft session is
  revoked, Claude asks them to reconnect.
- To cut off everyone at once, delete the Worker or the Entra client secret.

## Security

- Only Claude can register as a client: registration is refused unless every redirect URI is
  Claude's (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/...`, or a
  `localhost` / `127.0.0.1` loopback for Claude Code).
- A consent page names the app and where access goes before any Microsoft sign-in, and is
  protected against framing and forgery (`@cloudflare/workers-oauth-provider` helpers).
- Microsoft tokens are stored only inside the OAuth grant, encrypted with a key derived from
  Claude's token; the KV store holds hashes, not usable tokens. Claude's access tokens expire
  before the Microsoft token they carry, and refreshing one refreshes the other.
- Sign-in is limited to the JMC tenant and the same allowlist as the app.

## Development

```sh
npm test      # extracts the engine, starts the Worker under wrangler dev with a fake Microsoft,
              # and runs the whole flow: discovery, registration, consent, sign-in with PKCE,
              # every tool, refresh, revoked session, non-JMC account, and (if Playwright is
              # installed) opens a connector-saved quote in the real web app to check the total.
npm run dev   # local Worker on http://127.0.0.1:8787 (needs the vars in a .dev.vars file)
```

Layout: `src/index.js` (OAuth wiring, sign-in pages, MCP endpoint), `src/tools.js` (tools),
`src/quotes.js` (quote file format and pricing, pure), `src/onedrive.js` (Graph calls),
`src/microsoft.js` (Entra sign-in), `src/pages.js` (HTML).
