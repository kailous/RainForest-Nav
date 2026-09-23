import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyPkceS256 } from '../../../lib/mcp/pkce.mjs';
import { onlineMcpResource } from '../../../lib/mcp/resource.mjs';
import { normalizeScope, scopeList, issueAccessToken } from '../../../lib/mcp-server/access-tokens';
import { isAuthUsable, readAuthState } from '../../../lib/mcp-server/auth-state';
import { consumeAuthorizationCode } from '../../../lib/mcp-server/authorization-codes';
import { resolveSiteOrigin, setOAuthHeaders } from '../../../lib/mcp-server/http';
import { issueRefreshToken, rotateRefreshToken } from '../../../lib/mcp-server/refresh-tokens';

// The raw body is read manually so that repeated parameters can be rejected
// instead of silently collapsing to the first or last value.
export const config = {
  api: { bodyParser: false },
};

const MAX_BODY_BYTES = 16_384;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const CLIENT_AUTH_PARAMETERS = ['client_secret', 'client_assertion', 'client_assertion_type'];

class TokenError extends Error {
  code: string;
  status: number;

  constructor(code: string, description: string, status = 400) {
    super(description);
    this.name = 'TokenError';
    this.code = code;
    this.status = status;
  }
}

async function readRawBody(req: NextApiRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new TokenError('invalid_request', 'The request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Every parameter that may appear at most once is enforced here. Duplicates are
// refused rather than resolved, which removes parameter-pollution ambiguity.
function single(
  params: URLSearchParams,
  name: string,
  options: { required?: boolean; duplicateCode?: string } = {},
): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new TokenError(options.duplicateCode || 'invalid_request', `Parameter ${name} must not be repeated.`);
  }

  const value = values[0];
  if (value === undefined || value === '') {
    if (options.required !== false) {
      throw new TokenError('invalid_request', `Parameter ${name} is required.`);
    }
    return null;
  }
  return value;
}

// Only public clients are supported. Mixing in any other client authentication
// mechanism is rejected outright instead of being silently ignored.
function assertPublicClient(req: NextApiRequest, params: URLSearchParams): void {
  if (req.headers.authorization) {
    throw new TokenError(
      'invalid_client',
      'This server only supports public clients (token_endpoint_auth_method=none).',
      401,
    );
  }
  for (const parameter of CLIENT_AUTH_PARAMETERS) {
    if (params.has(parameter)) {
      throw new TokenError(
        'invalid_client',
        'This server only supports public clients (token_endpoint_auth_method=none).',
      );
    }
  }
}

function sendTokenResponse(res: NextApiResponse, payload: Record<string, unknown>): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json(payload);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  setOAuthHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ error: 'invalid_request', error_description: 'Use POST for the token endpoint.' });
    return;
  }

  // Token endpoint failures are always JSON, never a redirect.
  const fail = (error: unknown): void => {
    const tokenError = error instanceof TokenError
      ? error
      : new TokenError('server_error', 'The token request could not be completed.', 500);
    res.status(tokenError.status).json({ error: tokenError.code, error_description: tokenError.message });
  };

  try {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== FORM_CONTENT_TYPE) {
      throw new TokenError('invalid_request', `Content-Type must be ${FORM_CONTENT_TYPE}.`);
    }

    const siteOrigin = resolveSiteOrigin(req);
    if (!siteOrigin) {
      throw new TokenError('temporarily_unavailable', 'This deployment is not configured as an OAuth issuer.', 503);
    }
    const resourceId = onlineMcpResource(siteOrigin);

    const params = new URLSearchParams(await readRawBody(req));
    const grantType = single(params, 'grant_type')!;
    assertPublicClient(req, params);

    if (grantType === 'authorization_code') {
      const code = single(params, 'code')!;
      const clientId = single(params, 'client_id')!;
      const redirectUri = single(params, 'redirect_uri')!;
      const codeVerifier = single(params, 'code_verifier')!;
      // resource is required and bound exactly; it is never defaulted.
      const resource = single(params, 'resource', { required: false, duplicateCode: 'invalid_target' });
      if (!resource) {
        throw new TokenError('invalid_target', 'Parameter resource is required and must identify this MCP endpoint.');
      }

      // Consumed before any validation: a code is single-use even when the
      // exchange fails, which closes the concurrent double-redemption window.
      const record = await consumeAuthorizationCode(code);
      if (!record) throw new TokenError('invalid_grant', 'The authorization code is invalid or has expired.');

      if (record.clientId !== clientId) throw new TokenError('invalid_grant', 'The authorization code was issued to a different client.');
      if (record.redirectUri !== redirectUri) throw new TokenError('invalid_grant', 'redirect_uri does not match the authorization request.');
      if (record.codeChallengeMethod !== 'S256') throw new TokenError('invalid_grant', 'The authorization code does not use PKCE S256.');
      if (resource !== resourceId || record.resource !== resourceId) {
        throw new TokenError('invalid_target', 'The requested resource is not supported by this authorization server.');
      }

      const authState = await readAuthState();
      if (!isAuthUsable(authState)) {
        throw new TokenError('temporarily_unavailable', 'MCP service is disabled.', 503);
      }
      if (record.credentialVersion !== authState.credentialVersion) {
        throw new TokenError('invalid_grant', 'The authorization code was invalidated by a credential change.');
      }

      if (!(await verifyPkceS256(codeVerifier, record.codeChallenge))) {
        throw new TokenError('invalid_grant', 'PKCE verification failed.');
      }

      const access = await issueAccessToken({
        issuer: siteOrigin,
        resource: resourceId,
        clientId,
        scopes: record.scopes,
        credentialVersion: authState.credentialVersion,
      });
      const refresh = await issueRefreshToken({
        clientId,
        resource: resourceId,
        scopes: record.scopes,
        credentialVersion: authState.credentialVersion,
      });

      return sendTokenResponse(res, {
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: access.expiresIn,
        refresh_token: refresh.token,
        scope: normalizeScope(record.scopes),
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = single(params, 'refresh_token')!;
      const clientId = single(params, 'client_id')!;
      const resource = single(params, 'resource', { required: false, duplicateCode: 'invalid_target' });
      if (!resource) {
        throw new TokenError('invalid_target', 'Parameter resource is required and must identify this MCP endpoint.');
      }
      if (resource !== resourceId) {
        throw new TokenError('invalid_target', 'The requested resource is not supported by this authorization server.');
      }
      const requestedScope = single(params, 'scope', { required: false });

      const authState = await readAuthState();
      if (!isAuthUsable(authState)) {
        throw new TokenError('temporarily_unavailable', 'MCP service is disabled.', 503);
      }

      const rotation = await rotateRefreshToken({
        token: refreshToken,
        clientId,
        resource,
        credentialVersion: authState.credentialVersion,
        requestedScope: requestedScope === null ? undefined : normalizeScope(scopeList(requestedScope)),
      });

      if (rotation.outcome === 'scope_mismatch') {
        throw new TokenError('invalid_scope', 'A refresh request must not change the granted scope.');
      }
      if (rotation.outcome !== 'rotated' || !rotation.token) {
        throw new TokenError('invalid_grant', 'The refresh token is invalid, expired, or has already been used.');
      }

      const access = await issueAccessToken({
        issuer: siteOrigin,
        resource: resourceId,
        clientId,
        scopes: rotation.scopes || [],
        credentialVersion: authState.credentialVersion,
      });

      return sendTokenResponse(res, {
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: access.expiresIn,
        refresh_token: rotation.token,
        scope: normalizeScope(rotation.scopes || []),
      });
    }

    throw new TokenError('unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
  } catch (error) {
    return fail(error);
  }
}
