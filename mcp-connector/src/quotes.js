// Turning what Claude sends into a quote file the web app opens, and back into a priced summary.
// No network here: everything is pure so it can be tested in Node.
import { PROC_COLS, defaultProcessRates, defaultMaterials, num, computePartWith } from './engine.generated.js';

export const QUOTE_PREFIX = 'JMC-QT-';
export const STATUSES = ['Open', 'Sent', 'Won', 'Lost', 'On-Hold'];
export const SHAPES = ['block', 'round', 'standard'];

/** A mistake in what was asked for (unknown material, missing dimension...). Shown to Claude verbatim. */
export class QuoteInputError extends Error {}

/** The Rate Master as the app would see it, from _settings.json (or defaults when there is none). */
export function rateMasterFrom(settings) {
  const s = settings || {};
  return {
    materials: Array.isArray(s.materials) && s.materials.length ? s.materials : defaultMaterials(),
    processRates: Object.assign({}, defaultProcessRates(), s.processRates || {}),
    stockAllowance: s.stockAllowance ?? 5,
    currency: s.currency || '₹',
    defaultMargin: s.defaultMargin ?? 15,
    lastQuoteSeq: s.lastQuoteSeq ?? 100,
  };
}

/** The frozen rate snapshot written into a quote file, same shape as the app's cloneRates(). */
export function rateSnapshot(master) {
  return {
    materials: JSON.parse(JSON.stringify(master.materials)),
    processRates: JSON.parse(JSON.stringify(master.processRates)),
    stockAllowance: num(master.stockAllowance),
    currency: master.currency || '₹',
  };
}

/** Today's date in India, as YYYY-MM-DD (the app uses the estimator's local date). */
export function todayIST(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

export function isValidQuoteNo(qn) {
  return typeof qn === 'string' && qn.trim() !== '' && !/[\\/:*?"<>|]/.test(qn) && qn.length <= 100;
}

export function parseQuoteSeq(name) {
  const m = String(name).match(/JMC-QT-(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Next JMC-QT-n, ahead of every saved quote and of the app's own counter. */
export function nextQuoteNo(fileNames, lastQuoteSeq) {
  let max = Math.max(100, num(lastQuoteSeq));
  for (const n of fileNames) {
    const s = parseQuoteSeq(n);
    if (s && s > max) max = s;
  }
  return QUOTE_PREFIX + (max + 1);
}

const squash = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Accept a process by key ("millTurn") or by its label ("Mill/Turn", "mill turn"). */
export function resolveProcessKey(name) {
  const k = squash(name);
  const hit = PROC_COLS.find((c) => squash(c.key) === k || squash(c.label) === k);
  return hit ? hit.key : null;
}

function resolveMaterial(name, materials) {
  const k = squash(name);
  return materials.find((m) => squash(m.id) === k || squash(m.name) === k) || null;
}

/** Convert Claude's part descriptions into the app's part records. Throws QuoteInputError. */
export function toAppParts(inputParts, master) {
  if (!Array.isArray(inputParts) || !inputParts.length) throw new QuoteInputError('A quote needs at least one part.');
  const materialNames = master.materials.map((m) => m.name).join(', ');
  const processNames = PROC_COLS.map((c) => c.label).join(', ');
  return inputParts.map((p, i) => {
    const where = `Part ${i + 1}${p.description ? ` ("${p.description}")` : ''}`;
    const shape = String(p.shape || 'block').toLowerCase();
    if (!SHAPES.includes(shape)) throw new QuoteInputError(`${where}: shape must be block, round or standard.`);
    const part = {
      id: i + 1, partNo: p.partNo ?? '', description: p.description ?? '', shape,
      materialId: master.materials[0]?.id || '', dia: '', t: '', w: '', l: '',
      qty: p.qty ?? 1, unitPriceStd: '', marginOverride: p.marginPercent ?? '', image: null,
    };
    PROC_COLS.forEach((c) => { part[c.key] = ''; });

    if (shape === 'standard') {
      if (p.unitPrice == null) throw new QuoteInputError(`${where}: a standard / bought-out part needs unitPrice.`);
      part.unitPriceStd = p.unitPrice;
      if (p.material) {
        const m = resolveMaterial(p.material, master.materials);
        if (m) part.materialId = m.id;
      }
    } else {
      const m = resolveMaterial(p.material ?? '', master.materials);
      if (!m) throw new QuoteInputError(`${where}: unknown material "${p.material ?? ''}". Rate Master has: ${materialNames}.`);
      part.materialId = m.id;
      if (shape === 'block') {
        for (const d of ['t', 'w', 'l']) {
          if (!(num(p[d]) > 0)) throw new QuoteInputError(`${where}: a block needs t, w and l in mm (missing ${d}).`);
          part[d] = p[d];
        }
      } else {
        if (!(num(p.dia) > 0) || !(num(p.l) > 0)) throw new QuoteInputError(`${where}: a round part needs dia and l in mm.`);
        part.dia = p.dia; part.l = p.l;
      }
    }

    for (const [name, amount] of Object.entries(p.processes || {})) {
      const key = resolveProcessKey(name);
      if (!key) throw new QuoteInputError(`${where}: unknown process "${name}". Processes are: ${processNames}.`);
      if (amount == null || amount === '') continue;
      if (!(num(amount) >= 0)) throw new QuoteInputError(`${where}: process "${name}" must be a number of rupees, 0 or more.`);
      part[key] = amount;
    }
    return part;
  });
}

export function toAppExtras(extras) {
  return (extras || []).map((e) => ({ description: String(e.description ?? ''), amount: num(e.amount) }));
}

/** Price a quote file exactly as the app does: line totals with its own rates and margin. */
export function priceQuote(q) {
  const rates = q.rates && Array.isArray(q.rates.materials) && q.rates.materials.length ? q.rates : null;
  if (!rates) throw new QuoteInputError('This quote has no stored rates.');
  const margin = num(q.margin);
  const procLabel = Object.fromEntries(PROC_COLS.map((c) => [c.key, c.label]));
  const parts = (q.parts || []).map((p, i) => {
    const c = computePartWith(p, rates, margin);
    const mat = rates.materials.find((m) => m.id === p.materialId);
    const processes = {};
    for (const [k, v] of Object.entries(c.procVals)) if (v) processes[procLabel[k]] = round2(v);
    return {
      sNo: i + 1, partNo: p.partNo || '', description: p.description || '', shape: p.shape,
      material: p.shape === 'standard' ? 'bought-out' : (mat ? mat.name : '(removed material)'),
      weightKg: round3(c.weight), rmCost: round2(c.rmCost), processes, sum: round2(c.sum),
      marginPercent: c.marginPct, margin: round2(c.margin), subTotalPerPc: round2(c.subTotal),
      qty: c.qty, lineTotal: round2(c.lineTotal),
    };
  });
  const partsTotalExact = (q.parts || []).reduce((s, p) => s + computePartWith(p, rates, margin).lineTotal, 0);
  const extrasTotal = (q.extraItems || []).reduce((s, e) => s + num(e.amount), 0);
  return {
    quoteNo: q.quoteNo, customer: q.customer || '', partName: q.partName || '', partNo: q.partNo || '',
    operation: q.operation || '', date: q.date || '', status: q.status || 'Open', validityDays: num(q.validity) || 15,
    marginPercent: margin, currency: rates.currency || '₹', parts,
    extraItems: (q.extraItems || []).map((e) => ({ description: e.description, amount: num(e.amount) })),
    partsTotal: round2(partsTotalExact), extrasTotal: round2(extrasTotal),
    grandTotal: round2(partsTotalExact + extrasTotal),
    ratesSavedAt: q.ratesSavedAt || q.savedAt || null,
  };
}

/** Build the JSON file the web app saves and loads (see collectQuoteData / quoteFilePayload). */
export function buildQuoteFile(input, master, quoteNo, now = new Date()) {
  const savedAt = now.toISOString();
  const file = {
    quoteNo,
    partNo: input.partNo ?? '',
    partName: input.partName ?? '',
    operation: input.operation ?? '',
    customer: input.customer ?? '',
    date: input.date || todayIST(now),
    margin: String(input.marginPercent ?? master.defaultMargin),
    validity: String(input.validityDays ?? 15),
    status: input.status || 'Open',
    parts: toAppParts(input.parts, master),
    extraItems: toAppExtras(input.extraItems),
    rates: rateSnapshot(master),
    ratesLinked: false,
    savedAt,
    ratesSavedAt: savedAt,
    savedBy: 'Claude connector',
  };
  if (!STATUSES.includes(file.status)) throw new QuoteInputError(`status must be one of ${STATUSES.join(', ')}.`);
  file.grandTotal = priceQuote(file).grandTotal;
  return file;
}

/** The Saved Quotes list entry, same shape as the app's indexEntryFor(). */
export function indexEntryFor(q) {
  return {
    quoteNo: q.quoteNo || '', customer: q.customer || '', partName: q.partName || '',
    status: q.status || 'Open', savedAt: q.savedAt || new Date().toISOString(),
    grandTotal: Math.round(num(q.grandTotal)),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
