# Datum Report Studio

A white-label dimensional inspection report generator. A customer enters their
own company details and logo once; every report they issue afterwards carries
that identity. Single-page app, no build step: `index.html` is the whole
application.

It was built from a critical read of a ZEISS CALYPSO printout
(`REED TUBE BULGE — S-11445`). That report is typical of what CMM software
prints today, and typical of what it leaves out. The gaps are listed at the
bottom of this file; the **Pre-issue audit** in the app exists to close them.

## Running it

Open `index.html` from any web server, or straight from `file://` — unlike the
quote engine there is no sign-in, so both work. Everything runs in the browser.

## What it does

**Company profile** — name, division, address, phone, email, website, GSTIN,
accreditation reference, footer line, header colour and a logo (scaled to
600 px and stored inside the report file). This is the tenant identity.

**Report details** — three groups, because a defensible report needs all three:

| Group | Carries |
|---|---|
| Part & order | description, part no, drawing no **and revision**, customer, PO, lot, serial, lot quantity, pieces inspected, material, process |
| Equipment & conditions | instrument, make/model, serial, software, calibration certificate and due date, probe qualification date, MPE&#8337;, ambient temperature, humidity, whether results are compensated to 20 °C |
| Document control | report number and revision, date/time, inspection type, inspector, approver, default *U*, decision rule, notes |

**Characteristics** — one row per balloon: balloon number, name, feature type,
ISO 14405-1 association modifier (GG / GX / GN / GI / LP / LS), nominal,
asymmetric ±tolerances, expanded uncertainty *U*, and one or more measured
values. Section headings group rows. Rows can be pasted straight out of a CMM,
a CSV or a spreadsheet.

**The maths** (`calc` in the script, all covered by tests):

| Quantity | Formula |
|---|---|
| UTL / LTL | `nominal + upper` / `nominal + lower` (asymmetric supported) |
| Deviation | `measured − nominal` |
| Out by | signed distance outside the nearer limit, `0` when inside |
| % tol | `deviation ÷ allowed deviation on that side × 100` |
| Verdict | ISO 14253-1 — see below |
| Cp / Cpk | `(UTL−LTL)/6σ` and `min((UTL−x̄)/3σ, (x̄−LTL)/3σ)`, sample σ (n−1) |
| Thermal error | `11.5e-6 × L × (t − 20)` — steel, against the ISO 1 reference temperature |

**The decision rule** is the part a CMM printout skips. Two are offered:

- *Simple acceptance* — compare the value with the limits. Uncertainty is not
  applied. This is what every CMM prints, and the report says so in writing.
- *Stringent acceptance* (ISO 14253-1) — accept only when the value lies inside
  the limits by at least *U*. Values inside the limits but within *U* of one are
  reported **CHECK**: conformance is not proven either way. That is an honest
  answer, and it is the one that stops a lab passing a part it cannot measure.

**Pre-issue audit** — the report is checked before it leaves the building.
Findings are *blocking* (not defensible until fixed), *review* (a customer or an
auditor will ask) or *note*. It catches, among others: a blank drawing revision,
unidentified or out-of-calibration equipment, a missing temperature record with
the thermal error worked out against the tightest tolerance on the sheet, a
shared login in the inspector field, duplicate and near-duplicate feature names,
one tolerance applied to every characteristic, a tolerance the instrument cannot
resolve at 4:1, size features with no association method, and characteristics
that were listed but never measured. Printing with blocking findings open stamps
the sheet **DRAFT**.

**Output** — an A4 sheet rendered live beside the editor; Print / PDF produces
exactly what the preview shows. Save file writes a `.json` workspace holding the
company profile, the report and every characteristic; opening it restores the
report exactly.

## Tests

```sh
./tests/run.sh
```

64 assertions over the metrology engine and the audit rules, in Node against a
stub DOM. No dependencies, same pattern as `../tests`.

## Making this an actual SaaS

What ships here is the complete product surface, running per browser:
`localStorage` for the working copy, a `.json` file for anything that has to
survive. That is a real, usable tool, and it is a demo a customer can be shown
today — but it is single-user. To sell it as a subscription, the following has
to sit behind it, and none of it changes the code above:

| Concern | What is needed |
|---|---|
| Tenancy | `organisation` row; every report, profile and rate keyed to it. The `company` object in `state` is already that record. |
| Sign-in | OAuth or email link, roles: inspector (writes), approver (releases), viewer. The audit already distinguishes inspector from approver. |
| Storage | Reports as rows, not files. The `.json` workspace format is the schema — it is stable and versioned (`{app, version, company, report, chars}`). |
| Numbering | Server-issued report numbers per tenant, so two inspectors cannot mint the same one. |
| Approval | Release is a server action: no PDF until an approver signs, and blocking audit findings hard-stop it rather than watermarking. |
| Audit trail | Append-only revisions. A re-issued report supersedes, never overwrites. |
| Equipment register | Instruments and calibration dates held centrally, so "out of calibration" is checked against the register, not against a typed date. |
| Customer portal | A signed link per report, which is what customers actually want in place of emailed PDFs. |
| Billing | Per seat, or per report issued. |

The split matters: the metrology, the audit rules and the sheet layout are all
in this file and are the hard part. The list above is ordinary web plumbing.

## What the source report was missing

Findings from the CALYPSO printout this was built against. Every one of them is
now a check in the audit panel.

1. Drawing revision blank — results stated against an unidentified revision.
2. No measuring equipment named: no machine, model or serial number.
3. No calibration certificate, no calibration due date, no probe qualification date.
4. No temperature record. At 30–35 °C ambient, a 16 mm steel diameter moves
   ~2 µm from the 20 °C reference — against a ±5 µm tolerance.
5. No measurement uncertainty and no decision rule, yet pass/fail is declared.
   Two rows (−0.0012 and −0.0026 mm) are called good while sitting well inside
   a typical CMM's uncertainty of the limit.
6. `No. measured values: 10`, but only 8 characteristics are printed. Two
   measured characteristics are missing from the record.
7. Inspector recorded as `Master` — a shared login, not a person. No approver,
   no signature, no disposition.
8. One blanket ±0.005 mm on every characteristic, across diameters and lengths
   alike — the signature of a default setting, not of a drawing.
9. `Length 01` and `Length 1`, `Length 02` and `Length 2` — four rows, two
   naming conventions, no way to tell which is which.
10. Section headings printed as `--` and `-`.
11. No balloon numbers: nothing maps a row to a dimension on the drawing.
12. Diameters reported with no roundness, cylindricity or runout — on a *bulged*
    tube, form is the characteristic that fails in assembly.
13. `Measurement Duration 00:00:00.0`, an unresolved `n.def.` and two empty
    template boxes printed on a customer-facing document.
14. Header address (Padi) and footer (`UMS - AMBATTUR`) name two different
    sites. Date printed `9/12/2026` — ambiguous outside the US.
15. No report number, no revision, no lot or PO, no quantity inspected.

The data itself tells a story the report never states. Both bulged diameters run
over (+0.020 and +0.028 mm) while all four lengths run under (−0.012 to
−0.018 mm), and the two unbulged bores pass. Radial expansion with axial
shortening is what volume conservation looks like in a tube bulge: the tool is
set over-nominal, and the process is repeatable. That is a setting correction,
not a scrap report — and it is the single most useful sentence nobody wrote.
