import { base64urlEncode, constantTimeStringEquals } from './crypto.mjs';

// RFC 7636 PKCE. Only S256 is supported; `plain` is never accepted, and the
// verifier is used exactly as submitted (no trimming, no normalisation).
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const EXPECTED_CHALLENGE_LENGTH = 43;

export function isWellFormedCodeVerifier(value) {
  return typeof value === 'string' && CODE_VERIFIER_PATTERN.test(value);
}

export function isWellFormedCodeChallenge(value) {
  return typeof value === 'string' && value.length === EXPECTED_CHALLENGE_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function deriveCodeChallenge(codeVerifier) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)),
  );
  return base64urlEncode(digest);
}

// Returns false for a malformed verifier or any mismatch. The comparison is
// constant time, and neither value is ever echoed back to the caller.
export async function verifyPkceS256(codeVerifier, codeChallenge) {
  if (!isWellFormedCodeVerifier(codeVerifier)) return false;
  if (!isWellFormedCodeChallenge(codeChallenge)) return false;
  return constantTimeStringEquals(await deriveCodeChallenge(codeVerifier), codeChallenge);
}
