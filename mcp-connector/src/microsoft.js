// Signing the user in with Microsoft (Entra ID), so the connector can reach their OneDrive.
// The Worker is a confidential client: authorization code + PKCE + client secret.
export const MS_SCOPES = 'openid profile email offline_access User.Read Files.ReadWrite';

export class MicrosoftAuthError extends Error {
  constructor(message, { revoked = false } = {}) { super(message); this.revoked = revoked; }
}

function loginBase(env) {
  return `${(env.MS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, '')}/${env.MS_TENANT_ID}/oauth2/v2.0`;
}
export function callbackUrl(env) { return `${env.PUBLIC_URL.replace(/\/$/, '')}/callback`; }

export function authorizeUrl(env, { state, codeChallenge }) {
  const u = new URL(`${loginBase(env)}/authorize`);
  u.search = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: callbackUrl(env),
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

async function tokenRequest(env, params) {
  const res = await fetch(`${loginBase(env)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: MS_SCOPES, ...params,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant: the refresh token was revoked, expired, or the password changed.
    throw new MicrosoftAuthError(json.error_description || json.error || `Microsoft sign-in failed (${res.status})`,
      { revoked: json.error === 'invalid_grant' });
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
}

export function exchangeCode(env, code, codeVerifier) {
  return tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: callbackUrl(env), code_verifier: codeVerifier });
}

export function refreshMicrosoftToken(env, refreshToken) {
  return tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

export async function getMe(env, accessToken) {
  const base = (env.GRAPH_BASE || 'https://graph.microsoft.com').replace(/\/$/, '');
  const res = await fetch(`${base}/v1.0/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new MicrosoftAuthError(`Could not read your Microsoft profile (${res.status}).`);
  const me = await res.json();
  return { id: me.id, name: me.displayName || '', email: String(me.mail || me.userPrincipalName || '').toLowerCase() };
}

/** Same rule as the web app's isAuthorizedEmail(): an allowed domain, or an allowed address. */
export function isAuthorizedEmail(env, email) {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  const list = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list(env.ALLOWED_EMAILS).includes(e)) return true;
  return list(env.ALLOWED_DOMAINS).includes(e.split('@')[1] || '');
}

export async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
