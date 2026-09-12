# JMC Quote Engine

Quotation and costing tool for JMC Engineering (Padi, Chennai) — jigs, fixtures,
press tools and plastic moulds. Single-page app, no build step: `index.html` is
the whole application.

## Running it

Open `index.html` from a web server over HTTPS. It will not work correctly from
`file://` because Microsoft sign-in requires a real origin.

Sign-in is restricted to `@jmcengg.com` plus an explicit allowlist near the top
of the script (`ALLOWED_DOMAINS` / `EXTRA_ALLOWED_EMAILS`).

## How a price is built

| Step | Formula |
|---|---|
| Block weight | `(T + a) × (W + a) × (L + a) × density ÷ 1,000,000` |
| Round weight | `π × ((DIA + a) ÷ 2)² × (L + a) × density ÷ 1,000,000` |
| Std / bought-out | no weight; direct unit price |
| RM cost | `weight × material ₹/kg` |
| Auto process cost | `weight × process ₹/kg`, rounded up to the next ₹10 |
| Sum | `RM cost + all process costs` |
| Sub Total /pc | `Sum + (Sum × margin %)` |
| Line Total | `Sub Total × Qty` |

`a` is the stock allowance per dimension, set in Rate Master → Costing Rules.
Heat Treatment in Auto mode uses each material's own HT rate.

## Rate snapshots

A quote is priced against a **rate context**, not against whatever the Rate
Master holds today:

- A new quote follows the Rate Master live.
- Saving writes a copy of those rates into the quote file.
- Re-opening a saved quote uses **its own stored rates**, so changing a material
  rate for a new job never retro-prices work you already quoted.
- "Use current rate master" re-prices an open quote deliberately.

Quotes saved before this existed carry no rates; they open at current rates with
a warning banner.

## Storage

Everything lives in one OneDrive folder (named in Rate Master → OneDrive Storage),
in the signed-in user's own drive:

| File | Purpose |
|---|---|
| `<QuoteNo>.json` | one saved quote, including its rate snapshot |
| `_settings.json` | rate master, branding, PDF column choices |
| `_index.json` | customer / status / total for the Saved Quotes list |
| `_autosave_working.json` | crash-recovery copy of the quote being edited |

OneDrive accepts a single file up to 4 MB, which a photo-heavy quote can reach.

## Tests

```sh
./tests/run.sh
```

Runs the costing engine in Node against a stub DOM — weight formulas, margin,
rate snapshots, input clamping, change detection. No dependencies.

## Before deploying

Run `./tools/add-sri.sh` from a machine with internet access to pin the CDN
libraries with Subresource Integrity hashes, then confirm the app still loads.
See `SECURITY.md`.
