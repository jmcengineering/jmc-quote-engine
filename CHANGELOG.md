# Changelog

Development history for the JMC Quote Engine. This used to live in a
"What Changed & Why" tab inside the app itself, where customers and estimators
saw internal notes; it belongs in the repository instead.

## Earlier work — fixes against the original costing workbook

- **Fixed** — Material cost (RM Cost) now flows into Sum → Margin → Sub Total → Grand Total.
- **Fixed** — One weight formula, applied consistently, configurable in Rate Master.
- **Fixed** — Round-stock parts get a real cylindrical volume calc instead of a zeroed rectangular formula.
- **Fixed** — Bought-out/standard parts get their own direct-price costing path.
- **Fixed** — Profit margin is one visible, editable field per quote instead of silently varying 15–20% across sheets.
- **Fixed** — Heat Treatment (and any process you choose) can now price itself automatically from weight × ₹/kg via Process Rates, instead of being retyped per part.
- **Fixed** — Typing in any part row no longer rebuilds the whole table, so the cursor stays put and horizontal scroll position no longer resets.
- **Fixed** — First five columns (S.No → Material) stay frozen while scrolling through the process-cost columns.
- **Fixed** — PDF export is landscape, with a configurable column set (Rate Master → PDF Export Columns) and your real logo once uploaded.
- **Fixed** — Frozen-column header no longer overlaps Description/Shape — the sticky CSS was matching the wrong header row (the Dia/T/W/L sub-header has its own column count once S.No–Material's rowspan cells are excluded).
- **Fixed** — PDF now has light column gridlines, stretches to use the full landscape width instead of leaving the right side blank, and adds a signature block.
- **Fixed** — Grand Total in the PDF was showing a garbled character instead of ₹ — jsPDF's built-in font has no ₹ glyph. It now prints "Rs." in PDF output (still ₹ on-screen, where it renders fine).
- **Fixed** — Margin can now display as amount, percent, or both — your choice, in Rate Master → Costing Rules, applied everywhere (app + PDF).
- **Fixed** — Auto-calculated process costs (like HT) round up to the next ₹10 instead of landing on odd numbers — 41 becomes 50, not 40.
- **Fixed** — Auto-calculated fields are still editable per part now — type over the greyed "auto" placeholder to override just that line item; leave it blank to keep the automatic value.
- **Fixed** — Default brand color and logo now match your actual JMC Engineering logo (navy blue) instead of a generic amber guess.
- **Fixed** — Logo swapped to your white-on-navy version so it blends into the dark header bar instead of sitting in a visible white box.
- **Fixed** — Heat Treatment auto-pricing now uses each material's own HT rate (Materials table) instead of one flat rate for every grade — hardening OHNS genuinely doesn't cost the same as hardening MS.
- **Fixed** — "JMC ENGINEERING" title in the PDF header is now white — it was rendering in navy brand-color text on a navy header band, nearly invisible.
- **Fixed** — Margin column in the PDF table had the same broken-₹-glyph bug as the old Grand Total — fixed the same way, by dropping the currency symbol there to match every other numeric column in that table.
- **Added** — E-signature upload (Rate Master → Company Branding). Appears once, in the signature block on the last page — it follows wherever the quote content actually ends, it doesn't repeat on every page even if the parts table itself spans several.
- **Fixed** — Background-removed logos turning solid black on upload. The logo box was compressing everything to JPEG, which has no transparency channel — any see-through pixel got flattened to black on export. Both the logo and signature boxes now keep PNG transparency end to end.
- **Added** — Copy-paste for the logo and signature boxes too, same as the per-part photo fields: click the box, then Ctrl+V.
- **Added** — Real persistence: sign in with Microsoft and quotes save to a OneDrive folder you name (Rate Master → OneDrive Storage), with a Saved Quotes tab to browse and reload them. Rate Master settings sync there too, so they survive on the deployed site, not just inside Claude.
- **Fixed** — PDF header band now uses your actual brand color instead of a fixed dark graphite fill.
- **Fixed** — "QUOTATION" moved to top-right of the details block, level with the first detail line — standard letterhead layout instead of stacked on the left.
- **Added** — Quote No. auto-fills with a date-based suggestion (JMC-YYYYMMDD) on load — still fully editable, so your EW-#### job numbers work exactly as before.
- **Fixed** — S.No and Part No were the same number before (both showing "101, 102..."). Split into two columns: S.No is now a true running count (1, 2, 3...), and Part No is its own editable field defaulting to the old 101-style numbering.
- **Fixed** — Pasted photos were being stretched to exactly fill the table cell, distorting non-square images. Now sized to fit within the cell without distortion (like CSS object-fit: contain), centered in whatever space is left over.
- **Added** — Separate "Table / header color" control (Company Branding). The table headers previously used a fixed dark grey that no picker touched — that's now yours to set, applied to the on-screen tables and the PDF table header alike.
- **Added** — Three more process columns: Treatment, Profile Mill, and Other. The process sub-headers now build themselves from the column list, so adding more later won't break the layout.
- **Changed** — Quote No. now auto-fills as JMC-QT-101 and counts up (102, 103...), staying ahead of whatever's already saved in your OneDrive folder. Still fully editable.
- **Added** — Login gate: nothing loads until you sign in with Microsoft, restricted to @jmcengg.com plus a short extra-emails list you can edit at the top of the code.
- **Added** — Crash-recovery autosave: the quote you're editing saves to a separate recovery file every few seconds; if the browser closes unexpectedly, you're offered to restore it next time. It never overwrites your named quotes.
- **Added** — Saved Quotes now has search, per-quote Delete, and an Open/Sent/Won/Lost/On-Hold status tag.
- **Fixed** — The load bug: saved quotes reloaded with broken line items (images/dropdowns/calcs dead until you added a row) because loaded parts reused IDs that then collided with new rows. Every loaded part now gets a fresh unique ID.
- **Fixed** — PDF signature no longer overlaps the "For JMC ENGINEERING" line; it stacks cleanly and jumps to a fresh page if the quote ended too low.
- **Fixed** — Table header now stays frozen when you scroll down through 100+ rows, alongside the frozen left columns.
- **Changed** — Part No no longer auto-fills; type the real part code. S.No stays the running 1, 2, 3 count.
- **Fixed (audit)** — A double-quote character in any text field (an inch mark like `BUSH 25" LONG`) used to corrupt the whole row, because values were dropped into HTML attributes unescaped. All interpolated values are now escaped.
- **Added (audit)** — A "New Quote" button. Previously the only way to clear the form was reloading the page. It warns first if you have unsaved changes, and the browser now also warns before you close the tab with unsaved work.
- **Added (audit)** — Saving over an existing quote number now asks first and shows when that quote was last saved, instead of silently overwriting it. Quote numbers containing characters OneDrive rejects are caught up front.
- **Fixed (audit)** — Auto-save used to swallow every error, so an expired session meant your work quietly stopped being backed up. It now shows its status live (Saved / Saving / FAILING) and warns you outright after repeated failures.
- **Fixed (audit)** — Auto-save no longer re-uploads the entire quote (including every pasted photo) every few seconds. It skips upload entirely when nothing changed, runs on a longer interval, and refuses very large payloads rather than failing silently.
- **Fixed** — Table headers vanished with a light "Table / header color". Header text was a fixed near-white regardless of the colour picked, so a white, pale or yellow header rendered white-on-white — in the Parts table, the Rate Master tables and the PDF. Text now switches between light and dark automatically, whichever contrasts more with the chosen colour.
- **Fixed** — A gap between the two frozen header rows let part rows show through while scrolling down. The second row was pinned at a guessed 33px under a row that was really ~29px (and font-dependent); both rows are now a fixed 31px and the offset matches.
- **Fixed** — Saved Rate Master settings (material rates, process rates, branding) were lost between sessions. Sign-in called a `setStoragePill()` helper that was never defined, so start-up crashed before the saved `_settings.json` was read from OneDrive; the session ran on default rates, and the next edit uploaded those defaults over the saved ones. The helper now exists, and settings are never uploaded until the saved copy has been read.
- **Added** — A copy of the settings is kept in the browser (localStorage). If OneDrive can't be read, that copy is used, the header says so, and nothing in OneDrive is overwritten; whichever copy was edited more recently wins when they differ.
- **Fixed** — A custom OneDrive folder name was forgotten on every visit on the deployed site, so the app silently read and wrote a different folder. It is now remembered in the browser, and changing it re-reads settings and quotes from the new folder.
- **Fixed** — Excel export: bought-out (Std/BOP) parts recalculated to ₹0 because every row got the weight × rate formula. Only block/round stock gets it now; weight is exported at full precision so Excel's figure matches the app.
- **Fixed** — PDF: an extra line item with an amount but no description was left out of the Additional Charges table but still counted in the Grand Total. It is now printed as "Additional charge".
- **Fixed** — New quotes between midnight and 05:30 IST got yesterday's date (the date was taken in UTC).
- **Fixed** — A blank Qty is costed as 1 in the app but was exported as 0 to Excel and printed blank in the PDF; both now show 1.
- **Added** — Claude connector (`mcp-connector/`): a remote MCP server that lets Claude price, save, list and update quotes in the same OneDrive folder, from claude.ai, mobile, desktop or Claude Code. Each user signs in with their own JMC Microsoft account. Setup in `mcp-connector/README.md`.
- **Changed** — The costing engine in `index.html` is now one pure block (`computePartWith`, between `ENGINE-START` and `ENGINE-END`) that the connector copies at build time, so a quote priced from Claude matches the app exactly. The app's behaviour is unchanged.
- **Added** — The Claude connector can change the Rate Master (`update_rate_master`): material rates, density and HT rates, new or removed grades, process Auto/Manual and rates, stock allowance, default margin. It previews first and saves only when confirmed, keeps all non-rate settings, and uses OneDrive's version check so a simultaneous save isn't lost.
- **Fixed** — With more than one writer to the Rate Master, a web app tab left open could upload its old copy over a newer change made elsewhere. Before saving, the app now checks whether OneDrive's Rate Master changed since it loaded; if so it loads the newer rates and says its own last edit wasn't saved, instead of overwriting.
- **Added** — Quotes from drawing PDFs: the `jmc-quote-from-drawings` Claude skill reads an RFQ / drawing set of any length, prices every part, and saves a **Draft** in batches (`add_parts`), recording for each part the page and area of its best view and a note on what was estimated. In the app, **Attach drawing PDF** on the draft crops every part picture from the PDF in the browser (pdf.js), so pictures never pass through Claude.
- **Added** — `Draft` quote status. Drafts show Claude's notes in a banner and mark noted parts; exporting a Draft as a customer PDF asks first.
- **Added** — `mcp-connector/setup.mjs`: one command that signs in to Cloudflare and Microsoft in the browser, creates the KV store, Entra app registration, secret and permissions (via the Azure CLI when installed, or guided portal steps), deploys, and checks the connector is live.
