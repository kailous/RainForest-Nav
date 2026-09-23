// Runtime-independent signing helpers for self-contained OAuth credentials.
// Web Crypto only, so the same code runs on Cloudflare Workers, Node/Vercel,
// and in tests.
//
// Two independent protections keep credential types from being swapped:
//   1. a distinct `typ` inside the signed envelope, asserted on verification;
//   2. a distinct signing context string mixed into the HMAC input.
// Each credential type also has its own token prefix, but prefixes alone are
// never treated as the security boundary.
//
// Note: crypto.subtle.timingSafeEqual is Cloudflare-only, so signature
// comparison uses a fixed-length XOR accumulation instead.

// Only artifacts that are actually signed belong here. Authorization codes are
// opaque high-entropy values held in Redis, never signed, so they deliberately
// have no entry — a code can therefore never verify as any signed credential.
export const SIGNING_CONTEXTS = {
  client: 'rainforest:mcp:client:v1',
  access_token: 'rainforest:mcp:access:v1',
  refresh_token: 'rainforest:mcp:refresh:v1',
};

export const CREDENTIAL_PREFIXES = {
  client: 'rfn_client_',
  access_token: 'rfn_at_',
  refresh_token: 'rfn_rt_',
};

export function base64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomToken(prefix = '') {
  return `${prefix}${base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// Fixed-iteration comparison with no early exit, so mismatches cannot be timed.
export function constantTimeStringEquals(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function hmac(secret, value) {
  const key = await importHmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function contextFor(type) {
  const context = SIGNING_CONTEXTS[type];
  if (!context) throw new Error(`unsupported credential type: ${type}`);
  return context;
}

export async function signCredential(secret, keyVersion, type, data) {
  const context = contextFor(type);
  const prefix = CREDENTIAL_PREFIXES[type];
  const envelope = { typ: type, v: keyVersion, d: data, iat: Date.now() };
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(envelope)));
  const signature = await hmac(secret, `${context}.${body}`);
  return `${prefix}${body}.${base64urlEncode(signature)}`;
}

// keys: [{ version, secret }] — the current key plus any retained legacy keys.
// Returns the decoded envelope, or null for a malformed, mistyped, unknown-key,
// or incorrectly signed token.
export async function verifyCredential(keys, type, token) {
  const prefix = CREDENTIAL_PREFIXES[type];
  if (!prefix) throw new Error(`unsupported credential type: ${type}`);

  const value = String(token || '');
  if (!value.startsWith(prefix)) return null;

  const [body, signature] = value.slice(prefix.length).split('.');
  if (!body || !signature) return null;

  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.typ !== type) return null;

  const key = (keys || []).find(candidate => candidate && candidate.version === envelope.v);
  if (!key) return null;

  let provided;
  try {
    provided = base64urlDecode(signature);
  } catch {
    return null;
  }

  const expected = await hmac(key.secret, `${contextFor(type)}.${body}`);
  if (provided.length !== expected.length) return null;

  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected[index] ^ provided[index];
  return diff === 0 ? envelope : null;
}

// Shape-only check used for routing: confirms the prefix without verifying.
export function credentialTypeOf(token) {
  const value = String(token || '');
  for (const [type, prefix] of Object.entries(CREDENTIAL_PREFIXES)) {
    if (value.startsWith(prefix)) return type;
  }
  return null;
}
