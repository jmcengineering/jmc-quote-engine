// End to end: the real Worker under `wrangler dev`, a fake Microsoft, and a client that does
// exactly what Claude does: discovery, dynamic registration, consent, sign-in, PKCE token
// exchange, MCP tool calls, refresh. Run with:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockMicrosoft } from './mock-microsoft.js';
import { computePartWith, defaultProcessRates } from '../src/engine.generated.js';

const here = dirname(fileURLToPath(import.meta.url));
const TENANT = 'test-tenant', CLIENT_ID = 'test-client', CLIENT_SECRET = 'test-secret', FOLDER = 'JMC Quotations';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const PORT = 18787 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let ms, wrangler, persistDir;

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Seed OneDrive the way the web app leaves it: settings with a custom MS rate, two saved quotes.
const SETTINGS = {
  materials: [
    { id: 'MS', name: 'MS', rate: 95, density: 7.85, htRate: 60 },
    { id: 'OHNS', name: 'OHNS', rate: 150, density: 7.85, htRate: 90 },
  ],
  processRates: defaultProcessRates(), stockAllowance: 5, defaultMargin: 18, currency: '₹', lastQuoteSeq: 120,
  companyLogo: 'data:image/png;base64,LOGO', brandColor: '#003393', pdfColumns: { photo: false },
  settingsSavedAt: '2026-10-01T09:00:00.000Z',
};

before(async () => {
  ms = await startMockMicrosoft({ tenant: TENANT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  ms.state.setFile(`${FOLDER}/_settings.json`, JSON.stringify(SETTINGS));
  ms.state.setFile(`${FOLDER}/JMC-QT-140.json`, JSON.stringify({ quoteNo: 'JMC-QT-140', customer: 'Rane Group', parts: [], extraItems: [], status: 'Sent' }));
  ms.state.setFile(`${FOLDER}/EW-2900.json`, JSON.stringify({ quoteNo: 'EW-2900', customer: 'TVS', parts: [], extraItems: [] }));
  ms.state.setFile(`${FOLDER}/_index.json`, JSON.stringify({ version: 1, quotes: {
    'JMC-QT-140.json': { quoteNo: 'JMC-QT-140', customer: 'Rane Group', status: 'Sent', grandTotal: 12000, savedAt: '2026-09-01T00:00:00Z' } } }));

  persistDir = mkdtempSync(join(tmpdir(), 'jmc-connector-'));
  const vars = { PUBLIC_URL: BASE, MS_TENANT_ID: TENANT, MS_CLIENT_ID: CLIENT_ID, MS_CLIENT_SECRET: CLIENT_SECRET,
    MS_LOGIN_BASE: ms.url, GRAPH_BASE: ms.url, ONEDRIVE_FOLDER: FOLDER };
  wrangler = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', persistDir,
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'], detached: true }); // own process group, so teardown reaches workerd
  let log = '';
  wrangler.stdout.on('data', (d) => (log += d)); wrangler.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + log);
});
after(() => { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { /* already gone */ } ms?.close(); if (persistDir) rmSync(persistDir, { recursive: true, force: true }); });

/* A browser-ish cookie jar for one host. */
class Jar {
  constructor() { this.c = new Map(); }
  take(res) { for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); this.c.set(kv.slice(0, i), kv.slice(i + 1)); } }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
}

/** Do what Claude does to connect; returns tokens. */
async function connect({ email = 'estimator@jmcengg.com' } = {}) {
  ms.state.signInAs = email;
  const challengeRes = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challengeRes.headers.get('www-authenticate') || '')?.[1];
  const prm = await (await fetch(prmUrl)).json();
  const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  const client = await (await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_CB], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const jar = new Jar();
  const authUrl = new URL(asm.authorization_endpoint);
  authUrl.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CB, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-123', scope: 'quotes offline_access', resource: prm.resource }).toString();
  const consent = await fetch(authUrl, { redirect: 'manual' }); jar.take(consent);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const approve = await fetch(`${BASE}/authorize`, { method: 'POST', redirect: 'manual', headers: { Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision: 'approve' }) });
  jar.take(approve);
  const msLogin = await fetch(approve.headers.get('location'), { redirect: 'manual' });
  const cb = await fetch(msLogin.headers.get('location'), { redirect: 'manual', headers: { Cookie: jar.header() } });
  const result = { prm, asm, client, consentHtml: html, approveLocation: approve.headers.get('location'), callbackStatus: cb.status, callbackBody: cb.status === 302 ? '' : await cb.text() };
  if (cb.status !== 302) return result;
  const back = new URL(cb.headers.get('location'));
  result.redirectedTo = back;
  if (!back.searchParams.get('code')) return result;
  const tok = await fetch(asm.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: CLAUDE_CB,
      client_id: client.client_id, code_verifier: verifier, resource: prm.resource }) });
  result.tokens = await tok.json();
  return result;
}

let rpcId = 0;
async function mcp(token, method, params) {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  if (res.status !== 200) return { httpStatus: res.status, text: await res.text() };
  return res.json();
}
const call = async (token, name, args = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  assert.ok(r.result, `tools/call ${name} failed: ${JSON.stringify(r)}`);
  const text = r.result.content[0].text;
  const json = text.includes('\n\n') ? JSON.parse(text.slice(text.indexOf('\n\n') + 2)) : null;
  return { isError: !!r.result.isError, text, json };
};

const QUOTE = {
  customer: 'Rane Group', partName: 'TILT BRACKET', operation: 'POSITION GAUGE', marginPercent: 15, date: '2026-10-08',
  parts: [
    { description: 'Base plate', shape: 'block', material: 'ms', t: 20, w: 50, l: 80, qty: 2, processes: { 'Mill/Turn': 1200, grind: 400 } },
    { description: 'Guide pillar', shape: 'standard', unitPrice: 450 },
    { description: 'Locating pin', shape: 'round', material: 'OHNS', dia: 12, l: 40, processes: { 'Wire Cut': 300 }, marginPercent: 20 },
  ],
  extraItems: [{ description: 'Design Costing', amount: 3000 }],
};

let session;

test('discovery: 401 challenge, resource metadata and DCR metadata', async () => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="/);
  session = await connect();
  assert.equal(session.prm.resource, `${BASE}/mcp`, 'resource must equal the MCP URL exactly');
  assert.ok(session.asm.registration_endpoint, 'DCR advertised');
  assert.deepEqual(session.asm.code_challenge_methods_supported, ['S256']);
});

test('only Claude can register as a client', async () => {
  const reg = (uris) => fetch(session.asm.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'x', redirect_uris: uris, token_endpoint_auth_method: 'none' }) });
  assert.equal((await reg(['https://evil.example/callback'])).status, 400);
  assert.equal((await reg(['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'])).status, 400);
  assert.equal((await reg(['https://claude.com/api/mcp/auth_callback'])).status, 201);
  assert.equal((await reg(['http://localhost:3118/callback'])).status, 201, 'Claude Code loopback');
});

test('sign-in: consent page, Microsoft with PKCE, code back to Claude, tokens', async () => {
  assert.match(session.consentHtml, /Allow Claude to work with your quotes/);
  assert.match(session.consentHtml, /claude\.ai/);
  const msUrl = new URL(session.approveLocation);
  assert.equal(msUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(msUrl.searchParams.get('redirect_uri'), `${BASE}/callback`);
  assert.equal(session.redirectedTo.origin + session.redirectedTo.pathname, CLAUDE_CB);
  assert.equal(session.redirectedTo.searchParams.get('state'), 'st-123');
  assert.ok(session.tokens.access_token && session.tokens.refresh_token, JSON.stringify(session.tokens));
  assert.ok(session.tokens.expires_in <= 3600 - 300, 'access token expires before the Microsoft token');
});

test('a non-JMC Microsoft account is refused', async () => {
  const r = await connect({ email: 'someone@gmail.com' });
  assert.equal(r.callbackStatus, 403);
  assert.match(r.callbackBody, /not allowed to use the JMC Quote Engine/);
  assert.equal(r.tokens, undefined);
});

test('MCP: initialize and the eight tools', async () => {
  const init = await mcp(session.tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'jmc-quote-engine');
  const list = await mcp(session.tokens.access_token, 'tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(),
    ['add_parts', 'get_quote', 'get_rate_master', 'list_quotes', 'price_quote', 'save_quote', 'update_quote_status', 'update_rate_master']);
  const save = list.result.tools.find((t) => t.name === 'save_quote');
  assert.equal(save.annotations.destructiveHint, true);
});

test('get_rate_master reflects the saved Rate Master, not defaults', async () => {
  const r = await call(session.tokens.access_token, 'get_rate_master');
  assert.equal(r.json.materials.find((m) => m.name === 'MS').ratePerKg, 95);
  assert.equal(r.json.defaultMarginPercent, 18);
});

test('price_quote prices with the app engine and saves nothing', async () => {
  const putsBefore = ms.state.puts.length;
  const r = await call(session.tokens.access_token, 'price_quote', QUOTE);
  assert.equal(r.isError, false, r.text);
  // Recompute independently with the same engine and Rate Master.
  const R = { materials: SETTINGS.materials, processRates: SETTINGS.processRates, stockAllowance: 5 };
  const base = { marginOverride: '', qty: 1 };
  const exp = [
    computePartWith({ ...base, shape: 'block', materialId: 'MS', t: 20, w: 50, l: 80, qty: 2, millTurn: 1200, grind: 400 }, R, 15),
    computePartWith({ ...base, shape: 'standard', materialId: 'MS', unitPriceStd: 450 }, R, 15),
    computePartWith({ ...base, shape: 'round', materialId: 'OHNS', dia: 12, l: 40, wireCut: 300, marginOverride: 20 }, R, 15),
  ];
  const expected = exp.reduce((s, c) => s + c.lineTotal, 0) + 3000;
  assert.ok(Math.abs(r.json.grandTotal - expected) < 0.01, `${r.json.grandTotal} vs ${expected}`);
  assert.ok(r.json.parts[0].processes.HT > 0, 'auto heat treatment priced');
  assert.equal(r.json.parts[2].marginPercent, 20);
  assert.equal(ms.state.puts.length, putsBefore, 'nothing written');
});

test('bad input comes back as a tool error Claude can fix', async () => {
  const r = await call(session.tokens.access_token, 'price_quote', { ...QUOTE, parts: [{ description: 'x', material: 'Unobtainium', t: 1, w: 1, l: 1 }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /unknown material "Unobtainium".*MS, OHNS/);
  const r2 = await call(session.tokens.access_token, 'price_quote', { ...QUOTE, parts: [{ description: 'x', material: 'MS', processes: { laser: 5 }, t: 1, w: 1, l: 1 }] });
  assert.match(r2.text, /unknown process "laser"/);
});

let savedNo;
test('save_quote: next number past every saved quote, file + index written', async () => {
  const r = await call(session.tokens.access_token, 'save_quote', QUOTE);
  assert.equal(r.isError, false, r.text);
  savedNo = r.json.quoteNo;
  assert.equal(savedNo, 'JMC-QT-141', 'max(140 in folder, 120 in settings) + 1, across listing pages');
  const file = JSON.parse(ms.state.files.get(`${FOLDER}/${savedNo}.json`));
  assert.equal(file.ratesLinked, false);
  assert.equal(file.rates.materials.find((m) => m.id === 'MS').rate, 95, 'rates snapshot stored');
  assert.equal(file.parts.length, 3);
  const index = JSON.parse(ms.state.files.get(`${FOLDER}/_index.json`)).quotes;
  assert.equal(index[`${savedNo}.json`].customer, 'Rane Group');
  assert.ok(index['JMC-QT-140.json'], 'existing index entries kept');
  assert.ok(!ms.state.puts.includes(`${FOLDER}/_settings.json`), 'never writes the Rate Master');
});

test('save_quote refuses to overwrite unless asked', async () => {
  const r = await call(session.tokens.access_token, 'save_quote', { ...QUOTE, quoteNo: 'EW-2900' });
  assert.equal(r.isError, true);
  assert.match(r.text, /already exists/);
  assert.equal(JSON.parse(ms.state.files.get(`${FOLDER}/EW-2900.json`)).customer, 'TVS', 'untouched');
  const ok = await call(session.tokens.access_token, 'save_quote', { ...QUOTE, quoteNo: 'EW-2900', overwrite: true });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(JSON.parse(ms.state.files.get(`${FOLDER}/EW-2900.json`)).customer, 'Rane Group');
  const bad = await call(session.tokens.access_token, 'save_quote', { ...QUOTE, quoteNo: 'A/B' });
  assert.equal(bad.isError, true);
});

test('list_quotes, get_quote, update_quote_status', async () => {
  const list = await call(session.tokens.access_token, 'list_quotes', { search: 'rane' });
  assert.ok(list.json.some((q) => q.quoteNo === savedNo));
  const got = await call(session.tokens.access_token, 'get_quote', { quoteNo: savedNo });
  assert.equal(got.json.parts.length, 3);
  const st = await call(session.tokens.access_token, 'update_quote_status', { quoteNo: savedNo, status: 'Won' });
  assert.match(st.text, /Draft -> Won/, 'quotes saved from Claude start as Draft');
  assert.equal(JSON.parse(ms.state.files.get(`${FOLDER}/_index.json`)).quotes[`${savedNo}.json`].status, 'Won');
  const won = await call(session.tokens.access_token, 'list_quotes', { status: 'Won' });
  assert.deepEqual(won.json.map((q) => q.quoteNo), [savedNo]);
  // Changing status never re-prices: grand total in the file is unchanged.
  const again = await call(session.tokens.access_token, 'get_quote', { quoteNo: savedNo });
  assert.equal(again.json.grandTotal, got.json.grandTotal);
});

test('add_parts: batches append to a draft, priced with its stored rates; refused once confirmed', async () => {
  const t = session.tokens.access_token;
  const first = await call(t, 'save_quote', { customer: 'Sundram', sourceDocument: 'RFQ-Sundram.pdf',
    parts: [{ description: 'Plate A', material: 'MS', t: 20, w: 50, l: 80, drawing: { page: 1, box: [0.1, 0.1, 0.6, 0.6], view: 'isometric' }, note: 'est.' }] });
  assert.equal(first.isError, false, first.text);
  const qn = first.json.quoteNo;
  assert.equal(first.json.status, 'Draft');
  assert.equal(first.json.sourceDocument.name, 'RFQ-Sundram.pdf');
  assert.deepEqual(first.json.parts[0].drawing, { page: 1, box: [0.1, 0.1, 0.6, 0.6], view: 'isometric' });
  const more = await call(t, 'add_parts', { quoteNo: qn, parts: [
    { description: 'Plate B', material: 'MS', t: 20, w: 50, l: 80, drawing: { page: 2, box: [0, 0, 1, 1] } },
    { description: 'Pin', material: 'OHNS', shape: 'round', dia: 10, l: 30 }] });
  assert.equal(more.isError, false, more.text);
  assert.equal(more.json.partsNow, 3);
  const file = JSON.parse(ms.state.files.get(`${FOLDER}/${qn}.json`));
  assert.deepEqual(file.parts.map((p) => p.id), [1, 2, 3]);
  const got = await call(t, 'get_quote', { quoteNo: qn });
  assert.equal(got.json.parts[0].lineTotal, got.json.parts[1].lineTotal, 'same part, same rates, same price across batches');
  assert.equal(JSON.parse(ms.state.files.get(`${FOLDER}/_index.json`)).quotes[`${qn}.json`].grandTotal, Math.round(got.json.grandTotal));
  const bad = await call(t, 'add_parts', { quoteNo: qn, parts: [{ description: 'x', material: 'MS', t: 1, w: 1, l: 1, drawing: { page: 1, box: [0.6, 0.1, 0.2, 0.5] } }] });
  assert.match(bad.text, /right > left/);
  await call(t, 'update_quote_status', { quoteNo: qn, status: 'Sent' });
  const late = await call(t, 'add_parts', { quoteNo: qn, parts: [{ description: 'x', material: 'MS', t: 1, w: 1, l: 1 }] });
  assert.equal(late.isError, true);
  assert.match(late.text, /is Sent, not Draft/);
});

const settingsNow = () => JSON.parse(ms.state.files.get(`${FOLDER}/_settings.json`));

test('update_rate_master: preview by default, nothing written', async () => {
  const puts = ms.state.puts.length;
  const r = await call(session.tokens.access_token, 'update_rate_master', { materials: [{ name: 'MS', ratePerKg: 110 }] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /PREVIEW/);
  assert.match(r.text, /MS rate: ₹95\/kg -> ₹110\/kg/);
  assert.equal(ms.state.puts.length, puts);
  assert.equal(settingsNow().materials[0].rate, 95);
});

test('update_rate_master: apply changes rates, keeps every other setting, saved quotes keep their price', async () => {
  const quoteTotalBefore = (await call(session.tokens.access_token, 'get_quote', { quoteNo: savedNo })).json.grandTotal;
  const before = settingsNow();
  const r = await call(session.tokens.access_token, 'update_rate_master', {
    materials: [{ name: 'ms', ratePerKg: 110 }, { name: 'EN8', ratePerKg: 120, heatTreatmentRatePerKg: 70 }],
    processes: [{ process: 'Wire Cut', mode: 'auto', autoRatePerKg: 40 }],
    defaultMarginPercent: 20, apply: true,
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Saved to the Rate Master/);
  const after = settingsNow();
  assert.equal(after.materials.find((m) => m.name === 'MS').rate, 110);
  assert.equal(after.materials.find((m) => m.name === 'EN8').htRate, 70);
  assert.deepEqual(after.processRates.wireCut, { mode: 'auto', rate: 40 });
  assert.equal(after.defaultMargin, 20);
  for (const k of ['companyLogo', 'brandColor', 'pdfColumns', 'lastQuoteSeq', 'stockAllowance']) assert.deepEqual(after[k], before[k], k + ' preserved');
  assert.ok(Date.parse(after.settingsSavedAt) > Date.parse(before.settingsSavedAt), 'stamped newer so the app takes it');
  assert.ok(!('oneDriveFolder' in after));
  // New quotes use the new rates; the saved quote keeps its stored ones.
  const rm = (await call(session.tokens.access_token, 'get_rate_master')).json;
  assert.equal(rm.materials.find((m) => m.name === 'MS').ratePerKg, 110);
  assert.equal((await call(session.tokens.access_token, 'get_quote', { quoteNo: savedNo })).json.grandTotal, quoteTotalBefore);
  const again = await call(session.tokens.access_token, 'update_rate_master', { materials: [{ name: 'MS', ratePerKg: 110 }], apply: true });
  assert.match(again.text, /Nothing to change/);
});

test('update_rate_master: a save that lands in between is kept, not overwritten', async () => {
  // Someone saves the Rate Master (e.g. the web app) right after the connector reads it.
  ms.state.onMeta = (key) => {
    const s = JSON.parse(ms.state.files.get(key));
    s.stockAllowance = 6; s.settingsSavedAt = new Date().toISOString();
    ms.state.setFile(key, JSON.stringify(s));
  };
  const r = await call(session.tokens.access_token, 'update_rate_master', { materials: [{ name: 'OHNS', ratePerKg: 160 }], apply: true });
  assert.equal(r.isError, false, r.text);
  const after = settingsNow();
  assert.equal(after.stockAllowance, 6, 'their change survived');
  assert.equal(after.materials.find((m) => m.name === 'OHNS').rate, 160, 'ours applied on top');
});

test('update_rate_master: refuses bad changes', async () => {
  const t = session.tokens.access_token;
  assert.match((await call(t, 'update_rate_master', { processes: [{ process: 'HT', autoRatePerKg: 5 }], apply: true })).text, /per material/);
  assert.match((await call(t, 'update_rate_master', { materials: [{ name: 'Brass' }], apply: true })).text, /new material: give its ratePerKg/);
  assert.match((await call(t, 'update_rate_master', { removeMaterials: ['Unobtainium'], apply: true })).text, /no such material/);
  assert.match((await call(t, 'update_rate_master', { processes: [{ process: 'laser', mode: 'auto' }] })).text, /Unknown process/);
});

test('a web app tab left open does not overwrite a Rate Master change made from Claude', { skip: !playwrightPath() && 'Playwright not installed' }, async () => {
  const { chromium } = await import(playwrightPath());
  let remote = JSON.stringify({ ...settingsNow(), materials: settingsNow().materials.map((m) => (m.id === 'MS' ? { ...m, rate: 100 } : m)), settingsSavedAt: '2026-10-02T00:00:00.000Z' });
  const appPuts = [];
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext();
    await ctx.addInitScript(() => {
      const acct = { username: 'estimator@jmcengg.com' };
      window.msal = { PublicClientApplication: function () { return { getAllAccounts: () => [acct], acquireTokenSilent: async () => ({ accessToken: 't' }) }; } };
      window.__alerts = []; window.alert = (m) => window.__alerts.push(m); window.confirm = () => false;
    });
    await ctx.route(/^https?:\/\//, async (r) => {
      const req = r.request(); const u = new URL(req.url());
      if (u.host !== 'graph.microsoft.com') return r.abort();
      const path = decodeURIComponent(u.pathname);
      if (path.endsWith('/_settings.json:/content')) {
        if (req.method() === 'PUT') { appPuts.push(req.postData()); remote = req.postData(); return r.fulfill({ status: 200, body: '{}', contentType: 'application/json' }); }
        return r.fulfill({ status: 200, body: remote, contentType: 'application/json' });
      }
      if (path.endsWith(':/content')) return r.fulfill({ status: 404, body: '{}' });
      if (path.endsWith(':/children')) return r.fulfill({ status: 200, body: '{"value":[]}', contentType: 'application/json' });
      return r.fulfill({ status: req.method() === 'DELETE' ? 204 : 200, body: '{}', contentType: 'application/json' });
    });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto('file://' + join(here, '..', '..', 'index.html'));
    await p.waitForFunction(() => document.querySelectorAll('#materialsTable tbody tr').length > 0);
    await p.waitForTimeout(500);
    const msRate = () => p.evaluate(() => state.materials.find((m) => m.id === 'MS').rate);
    assert.equal(await msRate(), 100, 'tab loaded the Rate Master as it was');

    // Claude changes MS to 125 while the tab stays open.
    const r = await call(session.tokens.access_token, 'update_rate_master', { materials: [{ name: 'MS', ratePerKg: 125 }], apply: true });
    assert.equal(r.isError, false, r.text);
    remote = ms.state.files.get(`${FOLDER}/_settings.json`);

    // Now someone edits a different rate in that old tab.
    const editSecondRate = (v) => p.evaluate((v) => { const i = document.querySelectorAll('#materialsTable input[data-f="rate"]')[1]; i.value = v; i.dispatchEvent(new Event('input')); }, v);
    await editSecondRate(175);
    await p.waitForTimeout(2500);
    assert.equal(appPuts.length, 0, 'the stale tab did not upload over Claude\'s change');
    assert.equal(JSON.parse(remote).materials.find((m) => m.id === 'MS').rate, 125);
    assert.equal(await msRate(), 125, 'the tab picked up Claude\'s rate');
    const alerts = await p.evaluate(() => window.__alerts);
    assert.ok(alerts.some((a) => /changed elsewhere/.test(a)), JSON.stringify(alerts));

    // With the tab now current, the next edit saves normally and keeps Claude's MS rate.
    await editSecondRate(180);
    await p.waitForTimeout(2500);
    assert.equal(appPuts.length, 1);
    const saved = JSON.parse(remote);
    assert.equal(saved.materials.find((m) => m.id === 'MS').rate, 125);
    assert.equal(saved.materials[1].rate, 180);
    assert.deepEqual(errors, []);
  } finally { await b.close(); }
});

test('refresh renews the Microsoft token too; a revoked one forces reconnect', async () => {
  const calls = ms.state.refreshCalls;
  const r = await fetch(session.asm.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token, client_id: session.client.client_id }) });
  const t = await r.json();
  assert.equal(r.status, 200, JSON.stringify(t));
  assert.equal(ms.state.refreshCalls, calls + 1);
  assert.notEqual(t.refresh_token, session.tokens.refresh_token, 'refresh token rotated');
  const ok = await call(t.access_token, 'get_rate_master');
  assert.equal(ok.isError, false);
  // Microsoft revokes the user's session (password reset, admin action): refresh must say invalid_grant.
  ms.state.refresh.clear();
  const dead = await fetch(session.asm.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: session.client.client_id }) });
  assert.equal(dead.status, 400);
  assert.equal((await dead.json()).error, 'invalid_grant');
});

test('the web app opens a quote saved by the connector, at the same total', { skip: !playwrightPath() && 'Playwright not installed' }, async () => {
  const { chromium } = await import(playwrightPath());
  const file = JSON.parse(ms.state.files.get(`${FOLDER}/${savedNo}.json`));
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route(/^https?:\/\//, (r) => r.abort());
    await p.goto('file://' + join(here, '..', '..', 'index.html'));
    const res = await p.evaluate((q) => {
      showApp(); document.getElementById('panel-quote').classList.add('active');
      renderMaterials(); renderProcessHeaders();
      applyQuoteData(q);
      return { total: quoteGrandTotal(), rows: document.querySelectorAll('#partsBody tr').length, linked: state.quoteRatesLinked,
        customer: document.getElementById('qCustomer').value, status: document.getElementById('qStatus').value };
    }, file);
    assert.deepEqual(errors, []);
    assert.equal(res.rows, 3);
    assert.equal(res.linked, false, 'opens on its stored rates');
    assert.equal(res.customer, 'Rane Group');
    assert.equal(res.status, 'Won');
    assert.ok(Math.abs(res.total - file.grandTotal) < 0.01, `app ${res.total} vs connector ${file.grandTotal}`);
  } finally { await b.close(); }
});

function playwrightPath() {
  try {
    const p = join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright', 'index.mjs');
    return existsSync(p) ? p : null;
  } catch { return null; }
}
