import type { NextApiRequest, NextApiResponse } from 'next';
import { AuthorizationRequestError, parseAuthorizationParameters, parseClientRequest } from '../../../lib/mcp/authorization-request.mjs';
import { renderAuthorizationErrorPage, renderConsentPage, renderMcpDisabledPage } from '../../../lib/mcp/consent-page.mjs';
import { randomToken } from '../../../lib/mcp/crypto.mjs';
import { redirectUriMatches } from '../../../lib/mcp/oauth-client.mjs';
import { NAVIGATION_SCOPES } from '../../../lib/mcp/protocol.mjs';
import { onlineMcpResource } from '../../../lib/mcp/resource.mjs';
import { isAuthUsable, readAuthState, recordOnlineMcpActivity } from '../../../lib/mcp-server/auth-state';
import { issueAuthorizationCode } from '../../../lib/mcp-server/authorization-codes';
import { createConsentTicket, deleteConsentTicket, readConsentTicket, CONSENT_TICKET_TTL_SECONDS } from '../../../lib/mcp-server/consent-tickets';
import { resolveSiteOrigin, setMetadataHeaders } from '../../../lib/mcp-server/http';
import { matchesKeyHash } from '../../../lib/mcp-server/keys';
import { resolveOAuthClient } from '../../../lib/mcp-server/oauth-clients';
import { isRedisConfigured } from '../../../lib/mcp-server/redis';
import { constantTimeEquals, sha256Hex } from '../../../lib/mcp-server/secure-compare';

export const config = {
  api: { bodyParser: { sizeLimit: '32kb' } },
};

const CSRF_COOKIE = 'rf_oauth_csrf';
const CSRF_TTL_SECONDS = CONSENT_TICKET_TTL_SECONDS;

// The consent page handles a secret (the online MCP key), so every response from
// this endpoint is treated as sensitive: no caching, no referrer leakage, no
// framing, and a policy that blocks all active content. There is no script-src
// because the page needs no JavaScript at all.
const SENSITIVE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function applySensitiveHeaders(res: NextApiResponse): void {
  for (const [name, value] of Object.entries(SENSITIVE_HEADERS)) res.setHeader(name, value);
}

function renderHtml(res: NextApiResponse, status: number, html: string): void {
  applySensitiveHeaders(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(html);
}

function readCookie(req: NextApiRequest, name: string): string {
  const prefix = `${name}=`;
  return (
    (req.headers.cookie || '')
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(prefix))
      ?.slice(prefix.length) || ''
  );
}

function csrfCookie(value: string, maxAge: number, secure: boolean): string {
  const attributes = [
    'HttpOnly',
    // Scoped to the consent endpoint so the cookie is not attached to any other
    // request the site makes.
    'Path=/oauth/authorize',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push('Secure');
  return `${CSRF_COOKIE}=${value}; ${attributes.join('; ')}`;
}

function buildRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  setMetadataHeaders(res);
  applySensitiveHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'invalid_request', error_description: 'Use GET or POST.' });
  }

  // A single canonical origin supplies iss, the resource ID, and the cookie
  // security flag. Never derived from the Host header in production.
  const siteOrigin = resolveSiteOrigin(req);
  if (!siteOrigin) {
    return renderHtml(
      res,
      503,
      renderAuthorizationErrorPage(
        '服务未正确配置',
        '这台部署缺少 ONLINE_SITE_ORIGIN，无法作为 OAuth 授权服务器。',
        '请联系站点维护者完成配置。',
      ),
    );
  }
  if (!isRedisConfigured()) {
    return renderHtml(
      res,
      503,
      renderAuthorizationErrorPage('服务暂不可用', '授权服务依赖的 Redis 尚未配置。', '请联系站点维护者完成配置。'),
    );
  }

  const resourceId = onlineMcpResource(siteOrigin);
  const secureCookie = siteOrigin.startsWith('https:');

  // The redirect target is only trusted once the client and its registered
  // redirect_uri have been verified. Until then, errors are rendered — never
  // redirected — so this endpoint cannot be used as an open redirect.
  let trustedRedirectUri = '';
  let trustedState = '';

  const fail = (error: unknown, renderStatus = 400): void => {
    const code = error instanceof AuthorizationRequestError ? error.code : 'server_error';
    const description = error instanceof Error ? error.message : 'Authorization failed.';

    if (!trustedRedirectUri) {
      renderHtml(res, renderStatus, renderAuthorizationErrorPage('无法完成授权', description));
      return;
    }
    // RFC 9207: an error redirect must identify the issuer too.
    res.redirect(
      302,
      buildRedirect(trustedRedirectUri, {
        error: code,
        error_description: description,
        state: trustedState,
        iss: siteOrigin,
      }),
    );
  };

  try {
    if (req.method === 'GET') {
      const params = new URL(req.url || '/', siteOrigin).searchParams;

      const base = parseClientRequest(params);
      const client = await resolveOAuthClient(base.clientId);
      if (!client) throw new AuthorizationRequestError('invalid_client', 'Unknown client.');
      if (!redirectUriMatches(client, base.redirectUri)) {
        throw new AuthorizationRequestError('invalid_request', 'redirect_uri does not match the registered client.');
      }

      trustedRedirectUri = base.redirectUri;
      trustedState = base.state;
      const parameters = parseAuthorizationParameters(params, { resourceId, scopes: NAVIGATION_SCOPES });

      const authState = await readAuthState();
      if (!isAuthUsable(authState)) return renderHtml(res, 503, renderMcpDisabledPage());

      const csrfToken = randomToken();
      const ticket = await createConsentTicket({
        clientId: client.clientId,
        clientName: client.clientName,
        redirectUri: base.redirectUri,
        state: base.state,
        codeChallenge: parameters.codeChallenge,
        scopes: parameters.scopes,
        resource: parameters.resource,
        csrfHash: sha256Hex(csrfToken),
      });

      res.setHeader('Set-Cookie', csrfCookie(csrfToken, CSRF_TTL_SECONDS, secureCookie));
      return renderHtml(
        res,
        200,
        renderConsentPage({
          ticket,
          csrfToken,
          clientName: client.clientName,
          clientOrigin: new URL(base.redirectUri).origin,
          scopes: parameters.scopes,
        }),
      );
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const ticketValue = String(body.ticket || '');
    const csrfToken = String(body.csrf_token || '');
    const mcpKey = String(body.mcp_key || '');

    const ticket = await readConsentTicket(ticketValue);
    if (!ticket) {
      throw new AuthorizationRequestError('invalid_request', 'This authorization session has expired or was already used.');
    }
    trustedRedirectUri = ticket.redirectUri;
    trustedState = ticket.state;

    // The cookie binding is what defeats CSRF: an attacker can craft a form with
    // their own ticket, but cannot make the victim's browser carry their cookie.
    const cookieToken = readCookie(req, CSRF_COOKIE);
    if (!cookieToken || !constantTimeEquals(cookieToken, csrfToken) || !constantTimeEquals(sha256Hex(csrfToken), ticket.csrfHash)) {
      throw new AuthorizationRequestError('invalid_request', 'The authorization request could not be verified. Restart the connection from your AI client.');
    }

    const authState = await readAuthState();
    if (!isAuthUsable(authState)) return renderHtml(res, 503, renderMcpDisabledPage());

    if (!mcpKey || !matchesKeyHash(mcpKey, authState.keyHash)) {
      // Re-render the form so a mistyped key can be corrected. The key itself is
      // never echoed back, logged, or placed in a URL.
      res.setHeader('Set-Cookie', csrfCookie(csrfToken, CSRF_TTL_SECONDS, secureCookie));
      return renderHtml(
        res,
        401,
        renderConsentPage({
          ticket: ticketValue,
          csrfToken,
          clientName: ticket.clientName,
          clientOrigin: new URL(ticket.redirectUri).origin,
          scopes: ticket.scopes,
          errorMessage: '线上 MCP 密钥不正确。请在导航后台复制最新密钥后重试。',
        }),
      );
    }

    const code = await issueAuthorizationCode({
      clientId: ticket.clientId,
      redirectUri: ticket.redirectUri,
      codeChallenge: ticket.codeChallenge,
      codeChallengeMethod: 'S256',
      scopes: ticket.scopes,
      resource: ticket.resource,
      credentialVersion: authState.credentialVersion,
      iat: Date.now(),
    });

    await deleteConsentTicket(ticketValue);
    void recordOnlineMcpActivity('lastAuthorizeAt');

    res.setHeader('Set-Cookie', csrfCookie('', 0, secureCookie));
    res.redirect(302, buildRedirect(ticket.redirectUri, { code, state: ticket.state, iss: siteOrigin }));
    return;
  } catch (error) {
    fail(error);
    return;
  }
}
