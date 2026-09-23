import { CREDENTIAL_PREFIXES } from '../mcp/crypto.mjs';
import { ALLOWED_SCOPES, READ_SCOPE, WRITE_SCOPE } from '../mcp/protocol.mjs';
import { verifyAccessToken } from './access-tokens';
import { isAuthUsable, readAuthState } from './auth-state';
import { isOnlineKey, matchesKeyHash } from './keys';

// The online MCP endpoint accepts exactly two credential types, distinguished by
// prefix. There is deliberately no fallback chain: an unknown credential type is
// rejected without being tried against any store.
export const ALL_ONLINE_MCP_SCOPES = [READ_SCOPE, WRITE_SCOPE];

export interface McpAuthContext {
  authType: 'static_key' | 'oauth';
  clientId: string;
  scopes: string[];
  credentialVersion: number;
}

export interface McpAuthSuccess extends McpAuthContext {
  ok: true;
}

export interface McpAuthFailure {
  ok: false;
  status: 401 | 403 | 503;
  code: string;
  description: string;
  challenge?: string;
}

export type McpAuthResult = McpAuthSuccess | McpAuthFailure;

// Explicit guard: narrowing on the `ok` literal is not reliable in this project's
// compiler configuration, so callers use this instead.
export function isMcpAuthFailure(result: McpAuthResult): result is McpAuthFailure {
  return result.ok === false;
}

export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/api/mcp`;
}

export function unauthorizedChallenge(issuer: string, includeInvalidToken = false): string {
  const error = includeInvalidToken ? ', error="invalid_token"' : '';
  return `Bearer resource_metadata="${resourceMetadataUrl(issuer)}"${error}`;
}

export function insufficientScopeChallenge(issuer: string, requiredScopes: string[]): string {
  return `Bearer error="insufficient_scope", scope="${requiredScopes.join(' ')}", resource_metadata="${resourceMetadataUrl(issuer)}"`;
}

// A single, unambiguous Bearer credential. Node joins repeated Authorization
// headers with a comma, so any comma makes the header ambiguous and is refused.
function parseBearer(header: string | undefined): { present: boolean; credential: string } {
  const raw = String(header ?? '');
  if (!raw.trim()) return { present: false, credential: '' };
  if (raw.includes(',')) return { present: true, credential: '' };

  const match = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  if (!match) return { present: true, credential: '' };
  return { present: true, credential: match[1] };
}

export function missingScopes(granted: string[], required: string[]): string[] {
  return required.filter(scope => !granted.includes(scope));
}

export async function authenticateMcpRequest(
  authorization: string | undefined,
  context: { issuer: string; resource: string },
): Promise<McpAuthResult> {
  // Redis holds enabled / credentialVersion / keyHash and is a hard dependency:
  // no fallback to environment keys, Blob, or the admin password.
  let state;
  try {
    state = await readAuthState();
  } catch {
    return {
      ok: false,
      status: 503,
      code: 'service_unavailable',
      description: 'Online MCP authentication state is unavailable.',
    };
  }

  if (!isAuthUsable(state)) {
    // Deliberately no WWW-Authenticate: re-authorizing cannot fix a disabled
    // service, and a challenge would send clients into a retry loop.
    return { ok: false, status: 503, code: 'service_disabled', description: 'Online MCP is disabled.' };
  }

  const { present, credential } = parseBearer(authorization);
  if (!present) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      description: 'Authorization is required.',
      challenge: unauthorizedChallenge(context.issuer),
    };
  }

  const rejectToken = (description: string): McpAuthFailure => ({
    ok: false,
    status: 401,
    code: 'invalid_token',
    description,
    challenge: unauthorizedChallenge(context.issuer, true),
  });

  if (isOnlineKey(credential)) {
    if (!matchesKeyHash(credential, state.keyHash)) {
      return rejectToken('The access key is not valid.');
    }
    // The static key is the administrator credential: full read and write.
    return {
      ok: true,
      authType: 'static_key',
      clientId: 'static-key',
      scopes: [...ALL_ONLINE_MCP_SCOPES],
      credentialVersion: state.credentialVersion,
    };
  }

  if (credential.startsWith(CREDENTIAL_PREFIXES.access_token)) {
    const verified = await verifyAccessToken(credential, { issuer: context.issuer, resource: context.resource });
    if (!verified) return rejectToken('The access token is invalid or expired.');
    if (verified.credentialVersion !== state.credentialVersion) {
      return rejectToken('The access token was invalidated by a credential change.');
    }

    const scopes = verified.scopes.filter(scope => ALLOWED_SCOPES.has(scope));
    if (!scopes.length) return rejectToken('The access token carries no usable scope.');

    return {
      ok: true,
      authType: 'oauth',
      clientId: verified.clientId,
      scopes,
      credentialVersion: verified.credentialVersion,
    };
  }

  // Anything else — the admin password, a legacy API key, a plugin key, a
  // refresh token, an authorization code, a client id — is simply not a
  // credential this endpoint accepts.
  return rejectToken('The provided credential type is not accepted by this endpoint.');
}
