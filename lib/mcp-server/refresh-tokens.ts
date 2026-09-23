import { randomToken, signCredential, verifyCredential } from '../mcp/crypto.mjs';
import { normalizeScope, scopeList } from './access-tokens';
import { currentSigningKey, verificationKeys } from './oauth-signing';
import { redis } from './redis';

// Refresh tokens are HMAC-signed (so they are verifiable without a lookup) and
// additionally bound to a family record in Redis, which is what makes rotation
// and replay detection possible.
export const REFRESH_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
export const REFRESH_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60_000;

export type RefreshRotationOutcome = 'rotated' | 'invalid' | 'replayed' | 'scope_mismatch';

export interface RefreshRotationResult {
  outcome: RefreshRotationOutcome;
  token?: string;
  clientId?: string;
  scopes?: string[];
}

interface FamilyRecord {
  clientId: string;
  resource: string;
  scope: string;
  credentialVersion: number;
  createdAt: number;
  absoluteExpiresAt: number;
}

const familyKey = (familyId: string) => `online:mcp:rt-family:${familyId}`;
const jtiKey = (familyId: string) => `online:mcp:rt-jti:${familyId}`;

// Compare, rotate and revoke must be one atomic state transition, so the whole
// sequence runs inside Redis. Doing the comparison in JavaScript after a
// SET ... XX GET would leave replay detection and family revocation in separate
// commands, which concurrent refreshes can interleave.
//
// KEYS[1] current jti   KEYS[2] family record
// ARGV[1] presented jti ARGV[2] next jti
// ARGV[3] jti ttl ms    ARGV[4] absolute remaining ms (family ttl cap)
// The marker comment lets the test double recognise this exact script.
const ROTATE_SCRIPT = `-- rf-rotate-refresh-v1
local current = redis.call('GET', KEYS[1])
if not current then
  return 'missing'
end
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[1])
  return 'missing'
end
if current ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return 'replay'
end
local ttl = tonumber(ARGV[3])
if not ttl or ttl <= 0 then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return 'expired'
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
local cap = tonumber(ARGV[4])
local familyTtl = redis.call('PTTL', KEYS[2])
if familyTtl < 0 or familyTtl > cap then
  redis.call('PEXPIRE', KEYS[2], cap)
end
return 'rotated'`;

export async function issueRefreshToken(input: {
  clientId: string;
  resource: string;
  scopes: string[];
  credentialVersion: number;
}): Promise<{ token: string; familyId: string }> {
  const familyId = randomToken();
  const jti = randomToken();
  const issuedAt = Date.now();
  const absoluteExpiresAt = issuedAt + REFRESH_ABSOLUTE_TTL_MS;

  const family: FamilyRecord = {
    clientId: input.clientId,
    resource: input.resource,
    scope: normalizeScope(input.scopes),
    credentialVersion: input.credentialVersion,
    createdAt: issuedAt,
    absoluteExpiresAt,
  };

  await redis.set(familyKey(familyId), JSON.stringify(family), {
    exSeconds: Math.floor(REFRESH_ABSOLUTE_TTL_MS / 1000),
  });
  await redis.set(jtiKey(familyId), jti, { exSeconds: Math.floor(REFRESH_IDLE_TTL_MS / 1000) });

  const key = currentSigningKey();
  const token = await signCredential(key.secret, key.version, 'refresh_token', {
    familyId,
    jti,
    clientId: input.clientId,
    resource: input.resource,
    scope: family.scope,
    v: input.credentialVersion,
    iat: issuedAt,
    exp: absoluteExpiresAt,
  });

  return { token, familyId };
}

// Rotates a refresh token. The jti swap is a single atomic SET ... XX GET, so
// two concurrent refreshes cannot both succeed: the loser observes a jti it did
// not present and is treated as a replay.
export async function rotateRefreshToken(input: {
  token: string;
  clientId: string;
  resource: string;
  credentialVersion: number;
  requestedScope?: string;
}): Promise<RefreshRotationResult> {
  let keys;
  try {
    keys = verificationKeys();
  } catch {
    return { outcome: 'invalid' };
  }

  const envelope = await verifyCredential(keys, 'refresh_token', input.token);
  if (!envelope) return { outcome: 'invalid' };

  const data = envelope.d;
  if (!data || typeof data !== 'object') return { outcome: 'invalid' };
  if (typeof data.exp !== 'number' || data.exp <= Date.now()) return { outcome: 'invalid' };
  if (typeof data.v !== 'number' || data.v !== input.credentialVersion) return { outcome: 'invalid' };
  if (data.clientId !== input.clientId) return { outcome: 'invalid' };
  if (data.resource !== input.resource) return { outcome: 'invalid' };

  // A refresh must never widen the granted scope. Checked before the atomic
  // swap so a rejected scope request does not burn the token.
  if (input.requestedScope != null && input.requestedScope !== String(data.scope || '')) {
    return { outcome: 'scope_mismatch' };
  }

  const familyId = String(data.familyId || '');
  const presentedJti = String(data.jti || '');
  if (!familyId || !presentedJti) return { outcome: 'invalid' };

  const familyRaw = await redis.get(familyKey(familyId));
  if (!familyRaw) return { outcome: 'invalid' };

  let family: FamilyRecord;
  try {
    family = JSON.parse(familyRaw) as FamilyRecord;
  } catch {
    return { outcome: 'invalid' };
  }

  if (family.clientId !== input.clientId) return { outcome: 'invalid' };
  if (family.resource !== input.resource) return { outcome: 'invalid' };
  if (family.credentialVersion !== input.credentialVersion) return { outcome: 'invalid' };
  if (family.absoluteExpiresAt <= Date.now()) return { outcome: 'invalid' };

  const absoluteRemainingMs = family.absoluteExpiresAt - Date.now();
  if (absoluteRemainingMs <= 0) {
    await Promise.all([redis.del(jtiKey(familyId)), redis.del(familyKey(familyId))]);
    return { outcome: 'invalid' };
  }

  const nextJti = randomToken();
  // The sliding window can never extend past the family's absolute lifetime.
  const nextTtlMs = Math.min(REFRESH_IDLE_TTL_MS, absoluteRemainingMs);

  let outcome: string | null;
  try {
    outcome = await redis.eval(ROTATE_SCRIPT, [jtiKey(familyId), familyKey(familyId)], [
      presentedJti,
      nextJti,
      nextTtlMs,
      absoluteRemainingMs,
    ]);
  } catch {
    return { outcome: 'invalid' };
  }

  if (outcome === 'replay') return { outcome: 'replayed' };
  if (outcome !== 'rotated') return { outcome: 'invalid' };

  const key = currentSigningKey();
  const issuedAt = Date.now();
  const token = await signCredential(key.secret, key.version, 'refresh_token', {
    familyId,
    jti: nextJti,
    clientId: family.clientId,
    resource: family.resource,
    scope: family.scope,
    v: family.credentialVersion,
    iat: issuedAt,
    exp: family.absoluteExpiresAt,
  });

  return { outcome: 'rotated', token, clientId: family.clientId, scopes: scopeList(family.scope) };
}
