const CURRENT_KEY_ENV = 'MCP_OAUTH_SIGNING_KEY';
const CURRENT_VERSION_ENV = 'MCP_OAUTH_SIGNING_KEY_VERSION';
const PREVIOUS_KEY_ENV = 'MCP_OAUTH_SIGNING_KEY_PREVIOUS';
const PREVIOUS_VERSION_ENV = 'MCP_OAUTH_SIGNING_KEY_PREVIOUS_VERSION';
const MIN_SECRET_LENGTH = 32;

export interface SigningKey {
  version: number;
  secret: string;
}

// Signs self-contained OAuth artifacts (DCR client IDs, authorization codes,
// access and refresh tokens) so none of them require server-side storage.
//
// This secret is long-lived and completely independent from the online MCP key
// (rfn_live_*): rotating the MCP key must never invalidate registered DCR
// clients. When the signing secret does need rotating, keep the old value in
// MCP_OAUTH_SIGNING_KEY_PREVIOUS so already-issued client IDs keep verifying.
function parseVersion(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function usableSecret(raw: string | undefined): string | null {
  const value = raw || '';
  return value.length >= MIN_SECRET_LENGTH ? value : null;
}

export function isSigningConfigured(): boolean {
  return usableSecret(process.env[CURRENT_KEY_ENV]) !== null;
}

export function currentSigningKey(): SigningKey {
  const secret = usableSecret(process.env[CURRENT_KEY_ENV]);
  if (!secret) {
    throw new Error(`${CURRENT_KEY_ENV} must be set to a secret of at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return { version: parseVersion(process.env[CURRENT_VERSION_ENV], 1), secret };
}

// Newest first. Includes the previous key, if any, so credentials issued before
// a rotation still verify during the transition window.
export function verificationKeys(): SigningKey[] {
  const current = currentSigningKey();
  const keys: SigningKey[] = [current];

  const previousSecret = usableSecret(process.env[PREVIOUS_KEY_ENV]);
  if (previousSecret) {
    const previousVersion = parseVersion(process.env[PREVIOUS_VERSION_ENV], current.version - 1);
    if (previousVersion !== current.version) {
      keys.push({ version: previousVersion, secret: previousSecret });
    }
  }
  return keys;
}
