#!/usr/bin/env node
// One-time setup for the JMC Quote Engine Claude connector. Run from this folder:
//
//     node setup.mjs
//
// It signs you in to Cloudflare (browser) and, if the Azure CLI is installed, to Microsoft
// (browser), then creates everything and deploys. Safe to run again: finished steps are skipped.
// Without the Azure CLI it tells you the few clicks to do in the Azure portal and asks you to
// paste two values.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, 'wrangler.jsonc');
const isWin = process.platform === 'win32';
// One prompt reader for the whole run, paused whenever a command (wrangler, az) has the
// terminal, so they never compete for keystrokes. Answers typed ahead are queued.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const typedAhead = [], waiting = [];
let inputClosed = false;
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : typedAhead.push(l)));
rl.on('close', () => { inputClosed = true; while (waiting.length) waiting.shift()(''); });
rl.pause();

// Microsoft Graph delegated permissions the connector needs (well-known permission IDs).
const GRAPH = '00000003-0000-0000-c000-000000000000';
const SCOPES = {
  'User.Read': 'e1fe6dd8-ba31-4d61-89e7-88639da4683d',
  'Files.ReadWrite': '5c28f0bf-8a70-41f1-8ab2-9032436ddb65',
  offline_access: '7427e0e9-2fba-42fe-b0c0-848c9e6a8182',
  openid: '37f7f235-527c-4136-accd-4a02d197296e',
  profile: '14dad69e-099b-42c9-810b-d002981feec1',
  email: '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0',
};

const step = (n, text) => console.log(`\n\x1b[1m${n}. ${text}\x1b[0m`);
const ok = (text) => console.log(`   \x1b[32m✓\x1b[0m ${text}`);
const warn = (text) => console.log(`   \x1b[33m!\x1b[0m ${text}`);
function die(text) { console.error(`\n\x1b[31m✗ ${text}\x1b[0m\n`); rl.close(); process.exit(1); }

/** Run a command, showing its output live and returning it. stdin stays interactive unless `input` is given. */
function run(cmd, args, { input, quiet = false, allowFail = false } = {}) {
  rl.pause();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: here, shell: isWin, stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'] });
    let out = '', stdout = '';
    const onData = (stream, isOut) => (d) => { out += d; if (isOut) stdout += d; if (!quiet) stream.write(d); };
    child.stdout.on('data', onData(process.stdout, true));
    child.stderr.on('data', onData(process.stderr, false));
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    child.on('close', (code) => {
      if (code !== 0 && !allowFail) die(`"${cmd} ${args.join(' ')}" failed (exit ${code}). Fix the problem above and run  node setup.mjs  again.`);
      resolve({ code, out, stdout }); // stdout alone for values; CLIs print warnings on stderr
    });
  });
}
const has = (cmd) => spawnSync(cmd, ['--version'], { shell: isWin, stdio: 'ignore' }).status === 0;

/* wrangler.jsonc is edited in place so its comments survive. */
const readConfig = () => readFileSync(CONFIG, 'utf8');
function getVar(key) { const m = readConfig().match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`)); return m ? m[1] : ''; }
function setVar(key, value) {
  const text = readConfig();
  const re = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`);
  if (!re.test(text)) die(`wrangler.jsonc has no "${key}" setting.`);
  writeFileSync(CONFIG, text.replace(re, `$1${value.replace(/\$/g, '$$$$')}$2`));
}
const isPlaceholder = (v) => !v || /REPLACE/i.test(v);

async function ask(question, fallback) {
  process.stdout.write(`   ${question}${fallback ? ` [${fallback}]` : ''}: `);
  rl.resume();
  const a = typedAhead.length ? typedAhead.shift() : inputClosed ? '' : await new Promise((r) => waiting.push(r));
  rl.pause();
  if (!process.stdin.isTTY) process.stdout.write(a + '\n');
  return a.trim() || fallback || '';
}

async function main() {
  console.log('\nJMC Quote Engine: Claude connector setup\n');
  if (Number(process.versions.node.split('.')[0]) < 20) die('Node.js 20 or newer is needed (https://nodejs.org).');

  step(1, 'Install');
  if (!existsSync(join(here, 'node_modules', 'wrangler'))) await run('npm', ['install']);
  ok('dependencies installed');

  step(2, 'Cloudflare sign-in');
  const who = await run('npx', ['wrangler', 'whoami'], { quiet: true, allowFail: true });
  if (/not authenticated|You are not/i.test(who.out) || who.code !== 0) {
    console.log('   A browser window opens: sign in to Cloudflare (create a free account if you have none) and click Allow.');
    await run('npx', ['wrangler', 'login']);
  }
  ok('signed in to Cloudflare');

  step(3, 'Token store (Cloudflare KV)');
  const kvId = (readConfig().match(/"binding"\s*:\s*"OAUTH_KV"\s*,\s*"id"\s*:\s*"([^"]*)"/) || [])[1];
  if (isPlaceholder(kvId)) {
    // stdin is not a terminal here, so wrangler won't stop to ask about editing the config.
    const r = await run('npx', ['wrangler', 'kv', 'namespace', 'create', 'OAUTH_KV'], { quiet: true, input: '' });
    const id = (r.out.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/) || [])[1];
    if (!id) die('Could not read the new KV namespace id from wrangler:\n' + r.out);
    writeFileSync(CONFIG, readConfig().replace(/("binding"\s*:\s*"OAUTH_KV"\s*,\s*"id"\s*:\s*")[^"]*(")/, `$1${id}$2`));
    ok(`created (${id})`);
  } else ok('already set up');

  step(4, 'Connector address');
  if (isPlaceholder(getVar('PUBLIC_URL'))) {
    console.log('   Deploying once to get the address (it is not usable until setup finishes)...');
    const r = await run('npx', ['wrangler', 'deploy']);
    const url = (r.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/) || [])[0];
    if (!url) die('Could not find the workers.dev address in the deploy output above. Put it in wrangler.jsonc as PUBLIC_URL and run setup again.');
    setVar('PUBLIC_URL', url);
  }
  const publicUrl = getVar('PUBLIC_URL').replace(/\/$/, '');
  ok(publicUrl);

  step(5, 'Who and where');
  setVar('ONEDRIVE_FOLDER', await ask('OneDrive folder the web app uses (Rate Master → OneDrive Storage)', getVar('ONEDRIVE_FOLDER') || 'JMC Quotations'));
  setVar('ALLOWED_DOMAINS', await ask('Email domains allowed to sign in', getVar('ALLOWED_DOMAINS') || 'jmcengg.com'));
  setVar('ALLOWED_EMAILS', await ask('Extra individual emails allowed (comma separated, blank for none)', getVar('ALLOWED_EMAILS')));
  ok('saved');

  step(6, 'Microsoft sign-in for the connector (Entra app registration)');
  const tenant = getVar('MS_TENANT_ID');
  let clientId = getVar('MS_CLIENT_ID');
  let secret = '';
  if (!isPlaceholder(clientId)) {
    ok(`already registered (${clientId})`);
    if ((await ask('Create a new client secret too? (y/N)', 'n')).toLowerCase().startsWith('y')) secret = await newSecretViaCli(clientId) || await ask('Paste the new client secret Value');
  } else if (has('az')) {
    console.log('   A browser window opens: sign in with a JMC Microsoft 365 admin account.');
    await run('az', ['login', '--tenant', tenant, '--allow-no-subscriptions']);
    const manifest = join(mkdtempSync(join(tmpdir(), 'jmc-')), 'perms.json');
    writeFileSync(manifest, JSON.stringify([{ resourceAppId: GRAPH, resourceAccess: Object.values(SCOPES).map((id) => ({ id, type: 'Scope' })) }]));
    const created = await run('az', ['ad', 'app', 'create', '--display-name', 'JMC Quote Engine - Claude connector',
      '--sign-in-audience', 'AzureADMyOrg', '--web-redirect-uris', `${publicUrl}/callback`,
      '--required-resource-accesses', `@${manifest}`, '--query', 'appId', '-o', 'tsv'], { quiet: true });
    clientId = created.stdout.trim().split(/\s+/).pop();
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) die('Could not read the new app registration id:\n' + created.out);
    ok(`registered app ${clientId}`);
    await run('az', ['ad', 'sp', 'create', '--id', clientId], { quiet: true, allowFail: true });
    secret = await newSecretViaCli(clientId);
    const consent = await run('az', ['ad', 'app', 'permission', 'admin-consent', '--id', clientId], { quiet: true, allowFail: true });
    if (consent.code === 0) ok('admin consent granted (staff won\'t each be asked)');
    else warn(`Couldn't grant admin consent automatically. In the Azure portal open App registrations → "JMC Quote Engine - Claude connector" → API permissions → Grant admin consent. (Until then each person is asked to consent on first sign-in.)`);
  } else {
    console.log(`
   The Azure CLI isn't installed, so do this in the Azure portal (about 3 minutes):
     1. https://portal.azure.com → Microsoft Entra ID → App registrations → New registration
        Name: JMC Quote Engine - Claude connector
        Supported account types: Accounts in this organizational directory only
        Redirect URI: platform "Web", value  ${publicUrl}/callback   → Register
     2. On its Overview page, copy "Application (client) ID".
     3. Certificates & secrets → New client secret (24 months) → copy the secret "Value".
     4. API permissions → Add a permission → Microsoft Graph → Delegated permissions →
        tick User.Read, Files.ReadWrite, offline_access, openid, profile, email → Add,
        then "Grant admin consent".
   (Or install the Azure CLI, https://aka.ms/installazurecli , and run this setup again.)
`);
    clientId = await ask('Application (client) ID');
    secret = await ask('Client secret Value');
  }
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) die('That does not look like an Application (client) ID.');
  setVar('MS_CLIENT_ID', clientId);

  step(7, 'Store the secret and deploy');
  if (secret) { await run('npx', ['wrangler', 'secret', 'put', 'MS_CLIENT_SECRET'], { input: secret + '\n' }); ok('client secret stored in Cloudflare (encrypted)'); }
  await run('npx', ['wrangler', 'deploy']);
  ok('deployed');

  step(8, 'Check');
  try {
    const prm = await (await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    if (prm.resource !== `${publicUrl}/mcp`) throw new Error('unexpected metadata ' + JSON.stringify(prm));
    const challenge = await fetch(`${publicUrl}/mcp`, { method: 'POST', body: '{}' });
    if (challenge.status !== 401) throw new Error('expected 401 from /mcp, got ' + challenge.status);
    ok('connector is live and asking for sign-in, as it should');
  } catch (err) {
    warn(`Couldn't verify the deployment (${err.message}). It can take a minute to go live; open ${publicUrl} in a browser to check.`);
  }

  console.log(`
\x1b[1mDone.\x1b[0m Now in Claude (claude.ai, web):

  1. Settings → Connectors → Add custom connector
       Name: JMC Quote Engine
       URL:  ${publicUrl}/mcp
     Leave Advanced settings empty → Add → Connect → Continue → sign in with your JMC account.
     (Team/Enterprise: an Owner adds it under Organization settings → Connectors first.)
  2. Settings → Capabilities → Skills → Upload skill → choose
       ${join(here, '..', 'claude-skills', 'jmc-quote-from-drawings.zip')}
  3. Upload a drawing PDF and say: "Quote these parts for <customer>".

Keep the client secret's expiry date in your calendar; renew with  node setup.mjs  (answer y to
"Create a new client secret").
`);
  rl.close();
}

async function newSecretViaCli(clientId) {
  if (!has('az')) return '';
  const r = await run('az', ['ad', 'app', 'credential', 'reset', '--id', clientId, '--display-name', 'claude-connector',
    '--years', '2', '--append', '--query', 'password', '-o', 'tsv'], { quiet: true });
  const s = r.stdout.trim().split(/\s+/).pop();
  if (!s) die('Could not read the new client secret from the Azure CLI.');
  ok('client secret created (valid 2 years)');
  return s;
}

main().catch((err) => die(err.stack || String(err)));
