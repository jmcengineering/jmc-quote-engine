// The few HTML pages the connector shows during sign-in. Everything from the OAuth client
// (its name, redirect host) is attacker-controllable through registration: always escape.
const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root{--navy:#003393;--ink:#1b2128;--soft:#5b6470;--paper:#f3f1ea;--card:#fff;--line:#d9d4c7}
  @media (prefers-color-scheme: dark){:root{--ink:#e7e9ec;--soft:#a9b1bb;--paper:#14181d;--card:#1b2128;--line:#3d4750}}
  body{margin:0;font-family:Inter,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--paper);color:var(--ink);
    display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;max-width:460px;width:100%;padding:28px 26px}
  h1{font-size:20px;margin:0 0 6px} p{line-height:1.5;margin:10px 0} .soft{color:var(--soft);font-size:13.5px}
  .brand{font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:.08em;color:var(--navy);text-transform:uppercase;margin-bottom:14px}
  @media (prefers-color-scheme: dark){.brand{color:#8fa9e0}}
  ul{padding-left:20px;line-height:1.6} .warn{background:#fff3d6;color:#5a4413;border-radius:8px;padding:10px 12px;font-size:13.5px}
  .row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
  button,a.btn{font:inherit;font-weight:600;border-radius:8px;padding:11px 18px;cursor:pointer;border:1px solid var(--line);
    background:transparent;color:var(--ink);text-decoration:none;display:inline-block}
  button.primary{background:var(--navy);border-color:var(--navy);color:#fff}
</style></head><body><div class="card"><div class="brand">JMC Quote Engine</div>${body}</div></body></html>`;
}

export function consentPage(details, handle) {
  const loopback = details.redirectIsLoopback
    ? '<p class="warn"><b>This sends access to an app on your computer.</b> Continue only if you just started connecting from Claude Code yourself.</p>'
    : '';
  return page('Connect Claude to JMC Quote Engine', `
<h1>Allow ${escape(details.clientName)} to work with your quotes?</h1>
<p class="soft">Access will be sent to <b>${escape(details.redirectHost)}</b>.</p>
${loopback}
<p>It will be able to, as you:</p>
<ul>
  <li>read the Rate Master (material and process rates)</li>
  <li>read and list your saved quotes</li>
  <li>save new quotes and change a quote's status</li>
</ul>
<p class="soft">Next you sign in with your JMC Microsoft account. Quotes are kept in your own OneDrive, in the same folder the web app uses.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <div class="row">
    <button class="primary" name="decision" value="approve">Continue to Microsoft sign-in</button>
    <button name="decision" value="deny">Cancel</button>
  </div>
</form>`);
}

export function messagePage(title, message, { link, linkText } = {}, status = 400) {
  const body = `<h1>${escape(title)}</h1><p>${escape(message)}</p>${link ? `<div class="row"><a class="btn" href="${escape(link)}">${escape(linkText || 'Back')}</a></div>` : ''}`;
  return new Response(page(title, body), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
  });
}

export function homePage(env) {
  const mcp = `${env.PUBLIC_URL.replace(/\/$/, '')}/mcp`;
  return new Response(page('JMC Quote Engine connector', `
<h1>Claude connector</h1>
<p>Add this to Claude as a custom connector (Settings &rarr; Connectors &rarr; Add custom connector):</p>
<p><code>${escape(mcp)}</code></p>
<p class="soft">Sign-in is limited to JMC Engineering Microsoft accounts.</p>`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
