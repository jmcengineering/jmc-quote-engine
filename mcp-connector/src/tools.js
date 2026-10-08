// The tools Claude sees. Each call reads or writes the signed-in user's OneDrive folder,
// the same one the web app uses, so a quote saved here opens in the app's Saved Quotes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PROC_COLS } from './engine.generated.js';
import { OneDrive, GraphError, SETTINGS_FILE } from './onedrive.js';
import {
  STATUSES, QuoteInputError, rateMasterFrom, buildQuoteFile, priceQuote, indexEntryFor,
  nextQuoteNo, isValidQuoteNo,
} from './quotes.js';

const PROCESS_LIST = PROC_COLS.map((c) => `${c.key} (${c.label})`).join(', ');

const partSchema = z.object({
  description: z.string().describe('What the part is, e.g. "Base plate" or "Guide pillar"'),
  partNo: z.string().optional().describe('Customer or drawing part number, if known'),
  shape: z.enum(['block', 'round', 'standard']).default('block')
    .describe('block = rectangular stock (needs t, w, l); round = bar stock (needs dia, l); standard = bought-out / standard part priced directly (needs unitPrice)'),
  material: z.string().optional()
    .describe('Material grade name from the Rate Master (call get_rate_master), e.g. "MS", "OHNS", "HCHCR". Required for block and round.'),
  t: z.number().positive().optional().describe('Block thickness, mm (finished size; stock allowance is added automatically)'),
  w: z.number().positive().optional().describe('Block width, mm'),
  l: z.number().positive().optional().describe('Length, mm (block or round)'),
  dia: z.number().positive().optional().describe('Round bar diameter, mm'),
  qty: z.number().min(0).default(1).describe('Quantity of this part'),
  unitPrice: z.number().min(0).optional().describe('Standard / bought-out parts only: price per piece in rupees'),
  processes: z.record(z.string(), z.number().min(0)).optional()
    .describe(`Machining / process costs in rupees PER PIECE, keyed by process. Processes: ${PROCESS_LIST}. ` +
      'Processes set to Auto in the Rate Master (Heat Treatment by default) price themselves from weight; give a value only to override. Manual processes left out cost 0.'),
  marginPercent: z.number().optional().describe('Margin % for this part only, overriding the quote margin'),
});

const quoteShape = {
  customer: z.string().describe('Customer name, e.g. "Rane Group"'),
  partName: z.string().optional().describe('Name of the component or tool being quoted (quote header "Part Name")'),
  partNo: z.string().optional().describe('Header part number of the component (quote header "Part No.")'),
  operation: z.string().optional().describe('Operation / tool type, e.g. "POSITION GAUGE", "PIERCING TOOL"'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Quote date YYYY-MM-DD; defaults to today (India time)'),
  marginPercent: z.number().optional().describe('Quote margin %, applied to every part without its own; defaults to the Rate Master default'),
  validityDays: z.number().int().positive().optional().describe('Validity in days; defaults to 15'),
  status: z.enum(STATUSES).optional().describe('Defaults to Open'),
  parts: z.array(partSchema).min(1).describe('Line items'),
  extraItems: z.array(z.object({
    description: z.string(), amount: z.number().min(0).describe('Rupees'),
  })).optional().describe('Lump-sum extras added once to the quote, e.g. Design Costing, Assemble & Transport. ' +
    'The web app starts new quotes with Design Costing 3000 and Assemble & Transport 5000; include them only if the user wants them.'),
};

function ok(text, data) {
  return { content: [{ type: 'text', text: data === undefined ? text : `${text}\n\n${JSON.stringify(data, null, 2)}` }] };
}
function fail(text) { return { isError: true, content: [{ type: 'text', text }] }; }

/** Run a tool body, turning expected failures into tool errors Claude can act on. */
async function guarded(fn) {
  try { return await fn(); }
  catch (err) {
    if (err instanceof QuoteInputError) return fail(err.message);
    if (err instanceof GraphError) {
      return fail(err.status === 401 || err.status === 403
        ? 'OneDrive refused access. Disconnect and reconnect the JMC Quote Engine connector in Claude to sign in again.'
        : err.message);
    }
    throw err;
  }
}

/**
 * A fresh MCP server per request (stateless). `ctx` carries the signed-in user and their
 * Microsoft access token, decrypted by the OAuth library from this grant's props.
 */
export function createServer(env, user) {
  const server = new McpServer(
    { name: 'jmc-quote-engine', version: '1.0.0' },
    {
      instructions:
        'JMC Engineering quotation tool (jigs, fixtures, press tools, plastic moulds). Prices use the company Rate Master ' +
        'and the same costing engine as the JMC Quote Engine web app. Workflow: get_rate_master for materials and processes, ' +
        'price_quote to show the user a breakdown, and save_quote only once they are happy with it. Saved quotes appear in ' +
        'the web app under Saved Quotes, where the user exports the customer PDF. Amounts are Indian rupees.',
    },
  );
  const drive = new OneDrive({ token: user.msAccessToken, folder: env.ONEDRIVE_FOLDER || 'JMC Quotations', graphBase: env.GRAPH_BASE });
  const loadMaster = async () => rateMasterFrom(await drive.readJson(SETTINGS_FILE));

  server.registerTool('get_rate_master', {
    title: 'Get rate master',
    description: 'The current Rate Master: material grades with rupees/kg, density and heat-treatment rate; process list with Auto/Manual mode; stock allowance; default margin. Use the material names and process keys from here in price_quote / save_quote.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => guarded(async () => {
    const m = await loadMaster();
    return ok('Rate Master (from the web app settings in OneDrive):', {
      currency: m.currency,
      stockAllowanceMm: m.stockAllowance,
      defaultMarginPercent: m.defaultMargin,
      materials: m.materials.map((x) => ({ name: x.name, ratePerKg: x.rate, densityGPerCm3: x.density, heatTreatmentRatePerKg: x.htRate || 0, notes: x.notes || '' })),
      processes: PROC_COLS.map((c) => {
        const pr = m.processRates[c.key] || { mode: 'manual', rate: 0 };
        return { key: c.key, label: c.label, mode: pr.mode,
          ...(pr.mode === 'auto' ? { autoRatePerKg: c.key === 'ht' ? 'per material (heatTreatmentRatePerKg)' : pr.rate } : {}) };
      }),
      onedriveFolder: env.ONEDRIVE_FOLDER || 'JMC Quotations',
    });
  }));

  server.registerTool('list_quotes', {
    title: 'List saved quotes',
    description: 'Saved quotes in the OneDrive folder, newest first, with customer, part name, status and grand total. Filter by text (quote no., customer or part name) and/or status.',
    inputSchema: {
      search: z.string().optional().describe('Text to match in quote no., customer or part name'),
      status: z.enum(STATUSES).optional(),
      limit: z.number().int().min(1).max(200).default(25),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ search, status, limit }) => guarded(async () => {
    const [files, index] = await Promise.all([drive.listQuoteFiles(), drive.readIndex()]);
    const q = (search || '').toLowerCase().trim();
    let rows = files.map((f) => {
      const meta = index[f.name] || {};
      return { quoteNo: f.name.replace(/\.json$/, ''), customer: meta.customer || '', partName: meta.partName || '',
        status: meta.status || '', grandTotal: meta.grandTotal ?? null, savedAt: meta.savedAt || f.lastModified };
    });
    if (q) rows = rows.filter((r) => [r.quoteNo, r.customer, r.partName].some((v) => v.toLowerCase().includes(q)));
    if (status) rows = rows.filter((r) => r.status === status);
    rows.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    return ok(`${rows.length} matching quote(s)${rows.length > limit ? `, showing the newest ${limit}` : ''}:`, rows.slice(0, limit));
  }));

  server.registerTool('get_quote', {
    title: 'Get a saved quote',
    description: 'One saved quote, priced with the rates stored in it (as the web app shows it): header, every part with weight, RM cost, process costs, margin, line total, extras and grand total.',
    inputSchema: { quoteNo: z.string().describe('e.g. "JMC-QT-137"') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ quoteNo }) => guarded(async () => {
    if (!isValidQuoteNo(quoteNo)) return fail('That is not a valid quote number.');
    const q = await drive.readJson(`${quoteNo}.json`);
    if (!q) return fail(`No saved quote "${quoteNo}" in OneDrive. Use list_quotes to find it.`);
    if (!q.rates || !q.rates.materials?.length) {
      q.rates = (({ materials, processRates, stockAllowance, currency }) => ({ materials, processRates, stockAllowance, currency }))(await loadMaster());
      return ok(`${quoteNo} was saved before quotes stored their rates, so this is priced at TODAY's Rate Master and may differ from what was originally quoted:`, priceQuote(q));
    }
    return ok(`${quoteNo}:`, priceQuote(q));
  }));

  server.registerTool('price_quote', {
    title: 'Price a quote (no save)',
    description: 'Work out the full price of a quote with the current Rate Master WITHOUT saving anything. Use this to show the user the breakdown and agree it before calling save_quote with the same input.',
    inputSchema: quoteShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => guarded(async () => {
    const master = await loadMaster();
    const file = buildQuoteFile(input, master, '(not saved)');
    return ok('Priced with the current Rate Master. Nothing has been saved.', priceQuote(file));
  }));

  server.registerTool('save_quote', {
    title: 'Save a quote to OneDrive',
    description: 'Price a quote with the current Rate Master and save it to OneDrive, where it appears in the web app under Saved Quotes (Load, then Export PDF). The rates used are stored with the quote, as the app does. Leave quoteNo out to get the next JMC-QT number. Saving over an existing quote number needs overwrite=true and replaces that quote entirely.',
    inputSchema: {
      ...quoteShape,
      quoteNo: z.string().optional().describe('Leave out for the next automatic JMC-QT-### number, or give one (e.g. an EW-#### job number)'),
      overwrite: z.boolean().default(false).describe('Must be true to replace an existing quote with the same number. Confirm with the user first.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, (input) => guarded(async () => {
    const master = await loadMaster();
    if (input.quoteNo != null && !isValidQuoteNo(input.quoteNo)) {
      return fail('Quote No. can\'t be empty or contain any of these characters: \\ / : * ? " < > |');
    }
    let file, quoteNo = input.quoteNo?.trim();
    if (quoteNo) {
      file = buildQuoteFile(input, master, quoteNo);
      try {
        await drive.writeJson(`${quoteNo}.json`, file, { mustNotExist: !input.overwrite });
      } catch (err) {
        if (err instanceof GraphError && err.status === 409) {
          return fail(`Quote ${quoteNo} already exists. Ask the user whether to replace it (call again with overwrite=true) or use a different number.`);
        }
        throw err;
      }
    } else {
      // Pick the next number; if another save takes it first, OneDrive refuses (409): try the next.
      const taken = (await drive.listQuoteFiles()).map((f) => f.name);
      for (let attempt = 0; ; attempt++) {
        quoteNo = nextQuoteNo(taken, master.lastQuoteSeq);
        file = buildQuoteFile(input, master, quoteNo);
        try { await drive.writeJson(`${quoteNo}.json`, file, { mustNotExist: true }); break; }
        catch (err) {
          if (!(err instanceof GraphError && err.status === 409) || attempt >= 4) throw err;
          taken.push(`${quoteNo}.json`);
        }
      }
    }
    let indexNote = '';
    try { await drive.updateIndex((quotes) => { quotes[`${quoteNo}.json`] = indexEntryFor(file); }); }
    catch { indexNote = ' (The Saved Quotes index could not be updated; use "Rebuild index" in the app if it is missing from the list.)'; }
    return ok(`Saved ${quoteNo} to OneDrive folder "${drive.folder}". Open the JMC Quote Engine, go to Saved Quotes, Load it, and use Export PDF for the customer copy.${indexNote}`,
      priceQuote(file));
  }));

  server.registerTool('update_quote_status', {
    title: 'Update a quote\'s status',
    description: 'Mark a saved quote Open, Sent, Won, Lost or On-Hold. Prices and stored rates are not changed.',
    inputSchema: { quoteNo: z.string(), status: z.enum(STATUSES) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ quoteNo, status }) => guarded(async () => {
    if (!isValidQuoteNo(quoteNo)) return fail('That is not a valid quote number.');
    const q = await drive.readJson(`${quoteNo}.json`);
    if (!q) return fail(`No saved quote "${quoteNo}" in OneDrive.`);
    const before = q.status || 'Open';
    q.status = status;
    q.savedAt = new Date().toISOString();
    await drive.writeJson(`${quoteNo}.json`, q);
    try { await drive.updateIndex((quotes) => { quotes[`${quoteNo}.json`] = indexEntryFor(q); }); } catch { /* list catches up on Rebuild index */ }
    return ok(`${quoteNo}: status ${before} -> ${status}.`);
  }));

  return server;
}
