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
};

before(async () => {
  ms = await startMockMicrosoft({ tenant: TENANT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  ms.state.files.set(`${FOLDER}/_settings.json`, JSON.stringify(SETTINGS));
  ms.state.files.set(`${FOLDER}/JMC-QT-140.json`, JSON.stringify({ quoteNo: 'JMC-QT-140', customer: 'Rane Group', parts: [], extraItems: [], status: 'Sent' }));
  ms.state.files.set(`${FOLDER}/EW-2900.json`, JSON.stringify({ quoteNo: 'EW-2900', customer: 'TVS', parts: [], extraItems: [] }));
  ms.state.files.set(`${FOLDER}/_index.json`, JSON.stringify({ version: 1, quotes: {
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

test('MCP: initialize and the six tools', async () => {
  const init = await mcp(session.tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'jmc-quote-engine');
  const list = await mcp(session.tokens.access_token, 'tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(),
    ['get_quote', 'get_rate_master', 'list_quotes', 'price_quote', 'save_quote', 'update_quote_status']);
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
  assert.match(st.text, /Open -> Won/);
  assert.equal(JSON.parse(ms.state.files.get(`${FOLDER}/_index.json`)).quotes[`${savedNo}.json`].status, 'Won');
  const won = await call(session.tokens.access_token, 'list_quotes', { status: 'Won' });
  assert.deepEqual(won.json.map((q) => q.quoteNo), [savedNo]);
  // Changing status never re-prices: grand total in the file is unchanged.
  const again = await call(session.tokens.access_token, 'get_quote', { quoteNo: savedNo });
  assert.equal(again.json.grandTotal, got.json.grandTotal);
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
