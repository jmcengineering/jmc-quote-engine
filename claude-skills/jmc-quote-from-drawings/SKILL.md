---
name: jmc-quote-from-drawings
description: Turn a PDF of part drawings (RFQ, drawing set, detail sheets, BOM; any length, e.g. 100 pages) into a priced JMC Engineering quote saved as a Draft in the JMC Quote Engine, with each part's best picture (isometric if drawn) located for the app to crop. Use whenever the user uploads drawings or an RFQ and asks for a quote, a rate, pricing, costing or "quote these parts". Needs the JMC Quote Engine connector.
---

# Quote from drawings (JMC Engineering)

You are preparing a **draft** quote for an estimator at JMC Engineering (Padi, Chennai: jigs,
fixtures, press tools, plastic moulds). They will verify every rate in the JMC Quote Engine web
app before anything goes to the customer, so be accurate, say what you estimated, and never
present a guess as a fact.

## 0. Check the tools

You need the **JMC Quote Engine** connector (tools `get_rate_master`, `list_quotes`,
`get_quote`, `price_quote`, `save_quote`, `add_parts`). If it isn't connected, tell the user to
connect it in Settings → Connectors and stop.

## 1. Set up (one short question, only if needed)

- Customer name: usually in the title block or cover letter. Ask only if it's nowhere in the PDF.
- Margin: use the Rate Master default unless the user said otherwise.
- Extras (Design Costing, Assemble & Transport): ask once whether to include them and how much.
  Don't add them silently.

Then call `get_rate_master` (materials, ₹/kg, HT rates, which processes are Auto) and
`list_quotes` for this customer and recent quotes. Open two or three similar ones with
`get_quote`: they are your best evidence for process costs.

If there are no comparable quotes to learn from, ask the user once for their shop rates
(₹ per hour for milling/turning, grinding, jig boring, VMC, wire cut, CMM, bench work) and cost
processes as estimated hours × rate.

## 2. Read the PDF page by page

Classify each page: **part drawing**, **assembly/GA**, **BOM / parts list**, or **other**
(cover, notes, revision sheet). Quote the parts; use the GA and BOM for quantities and to catch
parts that have no detail sheet.

For each part, get from its own detail drawing:

| Field | How |
|---|---|
| `partNo`, `description` | Title block (drawing no. / part name) |
| `material` | Title block or BOM. Use the Rate Master grade name. If the grade isn't in the Rate Master, use the nearest equivalent and say so in `note`; if the user wants it priced properly, offer `update_rate_master` (preview first). Never invent a ₹/kg. |
| `qty` | Per-assembly quantity × number of tools/assemblies being quoted |
| `shape` | `round` for turned parts (Ø is the governing size: pins, bushes, pillars, shafts); `block` for prismatic parts; `standard` for bought-out items |
| Size (mm) | **Finished overall envelope**: block `t` (smallest), `w`, `l`; round `dia`, `l`. Do **not** add stock allowance: the engine adds it |
| Heat treatment | If the drawing calls up hardness (HRC) or "harden and temper", leave HT out of `processes` (it prices itself from weight). If there is **no** hardness callout, set `processes: { "HT": 0 }` so an unhardened part isn't charged for HT |
| Other processes | ₹ per piece for each process the part needs (Mill/Turn, Grind, Jig B/G, CMM, VMC, Wire Cut, Profile Mill, Fin. Grind, Bench, Treatment, Other), estimated from similar past quotes, scaled for size, tolerance and features |

Bought-out / standard items (bolts, dowels, springs, guide pillars and bushes, MISUMI and similar
catalogue parts): `shape: "standard"` with `unitPrice` from a past quote if you have one;
otherwise `unitPrice: 0` and the note `price needed`.

### The picture

For every part give `drawing: { page, box, view }`:

- `page`: the PDF page number (1-based, as in the file).
- Pick the **isometric / 3D view** if the sheet has one; otherwise the view that shows the most
  of the part (usually the front or plan view). Avoid the title block and dimension clutter.
- `box`: `[left, top, right, bottom]` as **fractions of the whole page as you see it** (top-left is
  `[0, 0]`, bottom-right `[1, 1]`), with a small margin (about 2–3% of the page) around the view.
  If you can run code, render the page and check the crop before you use it.
- `view`: `"isometric"`, `"front view"`, etc.

The web app crops these pictures from the PDF itself when the user attaches it, so never try to
send image data.

### The note

Every part gets a one-line `note` for the estimator: what you estimated, from what, and how
sure you are. For example: `Milling ₹1,800 + grind ₹600 scaled from JMC-QT-131 plate (similar
size); HRC 54-58 so HT kept. Medium confidence.` Flag anything uncertain: unreadable
dimensions, assumed material, assumed quantity, missing price.

## 3. Save as you go

- Work through the PDF in chunks of about 10–20 pages so nothing is lost on a long document.
- First batch: `save_quote` with up to ~20 parts, `customer`, header fields you found
  (`partName`, `operation` such as "PIERCING TOOL"), and `sourceDocument` set to the PDF's file
  name. Leave `status` out: it saves as **Draft**. Leave `quoteNo` out unless the user gave one.
- Later batches: `add_parts` with the same `quoteNo`.
- Never overwrite an existing quote, and never change a draft's status unless the user asks.

## 4. Report back

Give the user:

1. The quote number, number of parts, parts total, extras and grand total.
2. A compact table: S.No, part, material, size, qty, line total, confidence (high/medium/low).
3. **Check these first**: low-confidence parts, missing prices, assumed materials or quantities.
4. Next steps: *open the JMC Quote Engine → Saved Quotes → Load <quote no.> → Attach drawing PDF
   (the same file) to fill in the part pictures → check each part and rate → set Status to Open
   or Sent → Save → Export PDF and send it.*
