import { randomToken, signCredential, verifyCredential } from '../mcp/crypto.mjs';
import { currentSigningKey, verificationKeys } from './oauth-signing';

export const ACCESS_TOKEN_TTL_SECONDS = 3_600;

// Tolerance for a server clock running slightly behind the issuer. It only
// bounds how far in the future an iat may be — it never extends exp.
export const ACCESS_TOKEN_FUTURE_SKEW_MS = 60_000;

export interface IssuedAccessToken {
  token: string;
  expiresIn: number;
}

export interface VerifiedAccessToken {
  clientId: string;
  scopes: string[];
  credentialVersion: number;
  expiresAt: number;
}

// Scope is stored as one canonical, sorted, space-delimited string so issuance
// and verification always agree on representation.
export function normalizeScope(scopes: string[]): string {
  return Array.from(new Set(scopes)).sort().join(' ');
}

export function scopeList(scope: string): string[] {
  return String(scope || '').split(/\s+/).filter(Boolean);
}

export async function issueAccessToken(input: {
  issuer: string;
  resource: string;
  clientId: string;
  scopes: string[];
  credentialVersion: number;
}): Promise<IssuedAccessToken> {
  const key = currentSigningKey();
  const issuedAt = Date.now();

  const token = await signCredential(key.secret, key.version, 'access_token', {
    iss: input.issuer,
    aud: input.resource,
    clientId: input.clientId,
    scope: normalizeScope(input.scopes),
    v: input.credentialVersion,
    jti: randomToken(),
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

// The resource server only needs these checks: signature, typ, iss, aud, exp and
// the caller-supplied credentialVersion.
export async function verifyAccessToken(
  token: string,
  expected: { issuer: string; resource: string },
): Promise<VerifiedAccessToken | null> {
  let keys;
  try {
    keys = verificationKeys();
  } catch {
    return null;
  }

  const envelope = await verifyCredential(keys, 'access_token', token);
  if (!envelope) return null;

  const data = envelope.d;
  if (!data || typeof data !== 'object') return null;
  if (data.iss !== expected.issuer) return null;
  if (data.aud !== expected.resource) return null;
  if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
  if (typeof data.iat !== 'number') return null;
  if (data.iat > Date.now() + ACCESS_TOKEN_FUTURE_SKEW_MS) return null;
  if (typeof data.v !== 'number') return null;

  return {
    clientId: String(data.clientId || ''),
    scopes: scopeList(data.scope),
    credentialVersion: data.v,
    expiresAt: data.exp,
  };
}
