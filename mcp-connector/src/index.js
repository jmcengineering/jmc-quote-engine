// JMC Quote Engine connector for Claude: a remote MCP server on Cloudflare Workers.
//
// Two OAuth relationships:
//   Claude  <-> this Worker   OAuth 2.1 + Dynamic Client Registration, run by
//                             @cloudflare/workers-oauth-provider (Claude registers itself).
//   Worker  <-> Microsoft     Entra ID sign-in, so tools act on the user's own OneDrive.
// The user's Microsoft tokens live only inside the grant's props, which the library stores
// encrypted with a key derived from Claude's token.
import { OAuthProvider, OAuthError, AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './tools.js';
import { authorizeUrl, exchangeCode, refreshMicrosoftToken, getMe, isAuthorizedEmail, s256, MicrosoftAuthError } from './microsoft.js';
import { consentPage, messagePage, homePage } from './pages.js';

const SCOPE = 'quotes';

/* Only Claude may register as a client: claude.ai / claude.com for web, Desktop and mobile,
   and a loopback address on any port for Claude Code. Anything else is refused, so the
   connector can't be used to phish a JMC sign-in into some other app. */
export function isAllowedRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === 'https:' && (u.host === 'claude.ai' || u.host === 'claude.com') && u.pathname === '/api/mcp/auth_callback') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname === '/callback') return true;
  return false;
}

/* MCP endpoint. Stateless: a fresh server and transport per request, JSON responses. */
const mcpHandler = {
  async fetch(request, env, ctx) {
    const user = ctx.props;
    // Our access tokens are issued to expire before the Microsoft token they carry, so this
    // is only a safety net (clock skew): a 401 makes Claude refresh, which renews both.
    if (!user || !user.msAccessToken || Date.now() > user.msExpiresAt - 30_000) {
      return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Microsoft session expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      });
    }
    const server = createServer(env, user);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

/* Everything that isn't the MCP endpoint: landing page, consent, Microsoft callback. */
const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (url.pathname === '/' && request.method === 'GET') return homePage(env);

      // 1. Claude sends the user here. Show what is being connected, before any sign-in.
      if (url.pathname === '/authorize' && request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        consent.headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }

      // 2. Approved: hand over to Microsoft sign-in (PKCE; the verifier stays server-side).
      if (url.pathname === '/authorize' && request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle') || '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
        headers.set('Location', authorizeUrl(env, { state, codeChallenge: await s256(verifier) }));
        return new Response(null, { status: 302, headers });
      }

      // 3. Back from Microsoft: check who signed in, then finish Claude's authorization.
      if (url.pathname === '/callback' && request.method === 'GET') {
        const { request: original, data, headers } = await oauth.finishUpstream(request);
        if (url.searchParams.get('error')) {
          headers.set('Location', authorizationErrorRedirect(original, 'access_denied', 'Microsoft sign-in was cancelled'));
          return new Response(null, { status: 302, headers });
        }
        const ms = await exchangeCode(env, url.searchParams.get('code') || '', data.verifier);
        const me = await getMe(env, ms.accessToken);
        if (!isAuthorizedEmail(env, me.email)) {
          return messagePage('Not an authorized account',
            `"${me.email}" is not allowed to use the JMC Quote Engine. Sign in with your @jmcengg.com account, or ask info@jmcengg.com for access.`,
            { link: authorizationErrorRedirect(original, 'access_denied', 'Account not authorized'), linkText: 'Return to Claude' }, 403);
        }
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: me.id,
          metadata: { email: me.email, name: me.name },
          scope: [SCOPE],
          props: { email: me.email, name: me.name, msAccessToken: ms.accessToken, msRefreshToken: ms.refreshToken, msExpiresAt: ms.expiresAt },
        });
        headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
      if (err instanceof AuthorizationError || err instanceof CimdFetchError) {
        return messagePage('Sign-in could not continue',
          err instanceof AuthorizationError ? `${err.description} Start connecting again from Claude.` : 'This app could not be verified.');
      }
      if (err instanceof MicrosoftAuthError) {
        return messagePage('Microsoft sign-in failed', `${err.message} Start connecting again from Claude.`, {}, 502);
      }
      throw err;
    }
  },
};

/* Keep Claude's token lifetime inside the Microsoft token's, and renew Microsoft's on refresh. */
async function tokenExchangeCallback({ grantType, props, env }) {
  const ttlFor = (expiresAt) => Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 300);
  if (grantType === 'authorization_code') return { accessTokenTTL: ttlFor(props.msExpiresAt) };
  if (grantType !== 'refresh_token') return;
  try {
    const ms = await refreshMicrosoftToken(env, props.msRefreshToken);
    return {
      newProps: { ...props, msAccessToken: ms.accessToken, msRefreshToken: ms.refreshToken || props.msRefreshToken, msExpiresAt: ms.expiresAt },
      accessTokenTTL: ttlFor(ms.expiresAt),
    };
  } catch (err) {
    if (err instanceof MicrosoftAuthError && err.revoked) {
      throw new OAuthError('invalid_grant', { description: 'Microsoft access was revoked or expired; reconnect the connector.' });
    }
    throw new OAuthError('temporarily_unavailable', { description: 'Microsoft sign-in is unavailable; try again shortly.', statusCode: 503 });
  }
}

// The provider's options depend on PUBLIC_URL, so build it on first request and reuse it.
let provider, providerFor;
function getProvider(env) {
  const base = env.PUBLIC_URL.replace(/\/$/, '');
  if (provider && providerFor === base) return provider;
  provider = new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: [SCOPE, 'offline_access'],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_name: 'JMC Quote Engine',
    },
    accessTokenTTL: 3000,
    refreshTokenTTL: 30 * 24 * 3600,       // a new grant lasts 30 days...
    refreshTokenIdleTTL: 30 * 24 * 3600,   // ...and another 30 from each use, like Microsoft's own
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      if (!uris.length || !uris.every(isAllowedRedirect)) {
        return { code: 'invalid_redirect_uri', description: 'This connector only accepts Claude as a client.', status: 400 };
      }
    },
    tokenExchangeCallback,
  });
  providerFor = base;
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  },
};
