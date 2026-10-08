// A stand-in for Microsoft Entra sign-in and the bits of Microsoft Graph / OneDrive the
// connector uses, so the whole OAuth + tool flow can run locally against `wrangler dev`.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function startMockMicrosoft({ tenant, clientId, clientSecret, pageSize = 2 }) {
  const st = {
    signInAs: 'estimator@jmcengg.com',
    files: new Map(),         // "Folder/name.json" -> string
    codes: new Map(),         // code -> { challenge, redirectUri, email }
    access: new Map(),        // access token -> email
    refresh: new Map(),       // refresh token -> email
    refreshCalls: 0,
    puts: [],
  };
  const issue = (email) => {
    const at = 'msat-' + randomUUID(), rt = 'msrt-' + randomUUID();
    st.access.set(at, email); st.refresh.set(rt, email);
    return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'Bearer' };
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = decodeURIComponent(u.pathname);
    const login = `/${tenant}/oauth2/v2.0`;

    if (path === `${login}/authorize`) {
      const p = u.searchParams;
      if (p.get('client_id') !== clientId || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return send(res, 400, { error: 'bad authorize request' });
      const code = 'mscode-' + randomUUID();
      st.codes.set(code, { challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), email: st.signInAs });
      res.writeHead(302, { Location: `${p.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(p.get('state'))}` });
      return res.end();
    }
    if (path === `${login}/token` && req.method === 'POST') {
      const p = new URLSearchParams(await readBody(req));
      if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return send(res, 401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') {
        const c = st.codes.get(p.get('code')); st.codes.delete(p.get('code'));
        if (!c || c.redirectUri !== p.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
        if (b64url(createHash('sha256').update(p.get('code_verifier') || '').digest()) !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        return send(res, 200, issue(c.email));
      }
      if (p.get('grant_type') === 'refresh_token') {
        st.refreshCalls++;
        const email = st.refresh.get(p.get('refresh_token'));
        if (!email) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        st.refresh.delete(p.get('refresh_token'));
        return send(res, 200, issue(email));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---- Graph: every call needs a live access token ----
    const email = st.access.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!email) return send(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
    if (path === '/v1.0/me') return send(res, 200, { id: 'oid-' + email, displayName: email.split('@')[0], mail: email, userPrincipalName: email });

    let m;
    if ((m = path.match(/^\/v1\.0\/me\/drive\/root:\/([^/]+)\/(.+):\/content$/))) {
      const key = `${m[1]}/${m[2]}`;
      if (req.method === 'GET') return st.files.has(key) ? send(res, 200, st.files.get(key)) : send(res, 404, { error: { code: 'itemNotFound' } });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (u.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail' && st.files.has(key)) return send(res, 409, { error: { code: 'nameAlreadyExists' } });
        st.files.set(key, body); st.puts.push(key);
        return send(res, 201, { name: m[2] });
      }
    }
    if ((m = path.match(/^\/v1\.0\/me\/drive\/root:\/([^/]+):\/children$/))) {
      const all = [...st.files.keys()].filter((k) => k.startsWith(m[1] + '/')).map((k) => ({ name: k.slice(m[1].length + 1), lastModifiedDateTime: new Date().toISOString() }));
      const skip = Number(u.searchParams.get('skip') || 0);
      const value = all.slice(skip, skip + pageSize);
      const next = skip + pageSize < all.length ? `http://127.0.0.1:${server.address().port}${u.pathname}?skip=${skip + pageSize}` : undefined;
      if (!all.length) return send(res, 404, { error: { code: 'itemNotFound' } });
      return send(res, 200, { value, ...(next ? { '@odata.nextLink': next } : {}) });
    }
    send(res, 404, { error: { code: 'notHandled', path } });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, state: st, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}
