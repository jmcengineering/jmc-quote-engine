// The web app's side of a Claude-prepared draft: loading it, cropping part pictures out of the
// attached drawing PDF from the page/box Claude recorded, and the Draft safeguards.
// Needs Playwright (skipped otherwise); pdf.js is served from node_modules, same version as the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuoteFile, rateMasterFrom } from '../src/quotes.js';

const here = dirname(fileURLToPath(import.meta.url));
function playwrightPath() {
  try {
    const p = join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright', 'index.mjs');
    return existsSync(p) ? p : null;
  } catch { return null; }
}

/* A small but real PDF: three A4-landscape pages; page 2 has a solid red block filling the
   area [0.5, 0.5, 0.8, 0.8] of the page (fractions, top-left origin), page 3 a blue one. */
function makeDrawingPdf() {
  const W = 842, H = 595;
  const rect = (rgb, [l, t, r, b]) => `${rgb} rg ${l * W} ${(1 - b) * H} ${(r - l) * W} ${(b - t) * H} re f\n`;
  const pages = [
    '0 0 0 rg BT /F1 24 Tf 60 500 Td (Cover sheet) Tj ET\n',
    '0 0 0 rg BT /F1 18 Tf 60 540 Td (Part 101 Base plate) Tj ET\n' + rect('1 0 0', [0.5, 0.5, 0.8, 0.8]),
    rect('0 0 1', [0.1, 0.1, 0.3, 0.4]),
  ];
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = 2 + pages.length * 2;
  const kids = [];
  pages.forEach((content) => {
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  assert.equal(add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`), pagesId);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => { const o = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return o; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('draft from Claude: banner, notes, pictures cropped from the attached PDF, export nudge', { skip: !playwrightPath() && 'Playwright not installed' }, async () => {
  const { chromium } = await import(playwrightPath());
  const pdfPath = join(mkdtempSync(join(tmpdir(), 'jmc-pdf-')), 'RFQ-Rane.pdf');
  writeFileSync(pdfPath, makeDrawingPdf());

  // A draft exactly as the connector writes it.
  const draft = buildQuoteFile({
    customer: 'Rane Group', sourceDocument: 'RFQ-Rane.pdf',
    parts: [
      { description: 'Base plate', material: 'MS', t: 20, w: 100, l: 150, drawing: { page: 2, box: [0.5, 0.5, 0.8, 0.8], view: 'isometric' }, note: 'Milling estimated from JMC-QT-131' },
      { description: 'Clamp', material: 'MS', t: 10, w: 40, l: 60, drawing: { page: 3, box: [0.1, 0.1, 0.3, 0.4] } },
      { description: 'Ghost', material: 'MS', t: 10, w: 40, l: 60, drawing: { page: 9, box: [0, 0, 0.5, 0.5] } },
      { description: 'Bush', shape: 'standard', unitPrice: 300 },
    ],
  }, rateMasterFrom(null), 'JMC-QT-150');
  assert.equal(draft.status, 'Draft');

  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    const pdfjs = join(here, '..', 'node_modules', 'pdfjs-dist', 'build');
    await p.route(/pdf\.worker\.min\.js$/, (r) => r.fulfill({ path: join(pdfjs, 'pdf.worker.min.js'), contentType: 'text/javascript' }));
    await p.route(/pdf\.js\/.*\/pdf\.min\.js$/, (r) => r.fulfill({ path: join(pdfjs, 'pdf.min.js'), contentType: 'text/javascript' }));
    await p.route(/^https?:\/\/(?!cdnjs)/, (r) => r.abort());
    await p.addInitScript(() => { window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return false; }; });
    await p.goto('file://' + join(here, '..', '..', 'index.html'));
    await p.evaluate((q) => {
      showApp(); document.getElementById('panel-quote').classList.add('active');
      renderMaterials(); renderProcessHeaders(); applyQuoteData(q);
    }, draft);

    const banner = p.locator('#draftBanner');
    assert.ok(await banner.isVisible());
    const text = await banner.innerText();
    assert.match(text, /Draft prepared by Claude from RFQ-Rane\.pdf/);
    assert.match(text, /0 of 3 part pictures not filled|3 of 3 part pictures not filled/);
    assert.match(text, /Claude's notes on 1 part/);
    assert.equal(await p.locator('#qStatus').inputValue(), 'Draft');

    await p.setInputFiles('#draftPdfInput', pdfPath);
    await p.waitForFunction(() => /Filled \d/.test(document.getElementById('draftPdfProgress')?.textContent || ''), null, { timeout: 30000 });
    const progress = await p.locator('#draftPdfProgress').innerText();
    assert.match(progress, /Filled 2 picture\(s\); this PDF has no page 9/);

    // The crops are the right areas: page 2's block is red, page 3's is blue.
    const colours = await p.evaluate(async () => {
      const centre = (url) => new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const x = c.getContext('2d'); x.drawImage(img, 0, 0);
          res({ w: img.width, h: img.height, rgb: [...x.getImageData(img.width >> 1, img.height >> 1, 1, 1).data.slice(0, 3)] });
        };
        img.src = url;
      });
      return Promise.all(state.parts.map((pt) => (pt.image ? centre(pt.image) : null)));
    });
    const [plate, clamp, ghost, bush] = colours;
    assert.ok(plate.rgb[0] > 200 && plate.rgb[1] < 60 && plate.rgb[2] < 60, 'base plate crop is the red block ' + JSON.stringify(plate));
    assert.ok(clamp.rgb[2] > 200 && clamp.rgb[0] < 60, 'clamp crop is the blue block ' + JSON.stringify(clamp));
    assert.ok(Math.max(plate.w, plate.h) <= 260, 'fitted like a pasted photo');
    assert.equal(ghost, null); assert.equal(bush, null);
    assert.equal(await p.locator('#partsBody tr:nth-child(1) .photo-box img').count(), 1, 'shown in the table');
    assert.match(await p.locator('#draftBanner').innerText(), /1 of 3 part pictures not filled/);

    // Note marker on the part, and the source PDF + pictures survive a save round-trip.
    assert.match(await p.locator('#partsBody tr:nth-child(1) td.desc-cell').getAttribute('title'), /Milling estimated/);
    const saved = await p.evaluate(() => JSON.parse(JSON.stringify(collectQuoteData())));
    assert.equal(saved.sourceDocument.name, 'RFQ-Rane.pdf');
    assert.ok(saved.parts[0].image.startsWith('data:image/jpeg'));
    assert.deepEqual(saved.parts[0].drawingRef.box, [0.5, 0.5, 0.8, 0.8]);

    // Exporting a Draft asks first (and Cancel stops it).
    await p.click('#exportPdfBtn');
    assert.match((await p.evaluate(() => window.__confirms)).join(), /still a Draft/);

    // Confirming it: status Open hides the Draft banner once all pictures are filled or none are pending.
    await p.selectOption('#qStatus', 'Open');
    assert.match(await p.locator('#draftBanner').innerText(), /1 part picture\(s\) can still be filled/);
    assert.deepEqual(errors, []);
  } finally { await b.close(); }
});
