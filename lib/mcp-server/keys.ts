import { createHash, randomBytes, timingSafeEqual } from 'crypto';

// Online MCP keys are self-identifying: the prefix lets every consumer route a
// bearer token without probing multiple stores. Bytes chosen so the body is
// exactly 43 base64url characters, matching the plugin key length.
export const ONLINE_KEY_PREFIX = 'rfn_live_';
const ONLINE_KEY_BODY_LENGTH = 43;

export function generateOnlineKey(): string {
  return ONLINE_KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function isOnlineKey(value: string): boolean {
  return new RegExp(`^${ONLINE_KEY_PREFIX}[A-Za-z0-9_-]{${ONLINE_KEY_BODY_LENGTH}}$`).test(String(value || ''));
}

// Only this hash is persisted. The plaintext is shown to the admin once.
export function hashOnlineKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function keyLast4(key: string): string {
  return key.slice(-4);
}

export function matchesKeyHash(key: string, expectedHash: string): boolean {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashOnlineKey(key), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
