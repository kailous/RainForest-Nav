import {
  MAX_CLIENT_DOCUMENT_BYTES,
  clientMetadataOrigin,
  isClientMetadataDocumentId,
  isDynamicClientId,
  normalizeRedirectUris,
  parseAllowedOrigins,
  parseClientMetadataDocument,
} from '../mcp/oauth-client.mjs';
import { signCredential, verifyCredential } from '../mcp/crypto.mjs';
import { currentSigningKey, verificationKeys } from './oauth-signing';

const DCR_CLIENT_TTL_MS = 365 * 24 * 60 * 60_000;
const DOCUMENT_CACHE_TTL_MS = 60_000;
const DOCUMENT_CACHE_MAX_ENTRIES = 50;
const CIMD_ALLOWLIST_ENV = 'MCP_CIMD_ALLOWED_ORIGINS';

type FetchLike = typeof fetch;

export interface ResolvedOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  source: 'cimd' | 'dcr';
}

// Caches *validated* metadata for a bounded time — never "this URL is trusted
// forever". Failures, non-2xx responses and invalid schemas are never cached.
const documentCache = new Map<string, { client: ResolvedOAuthClient; expiresAt: number }>();

// The allowlist is the real SSRF boundary: a hostname can resolve to an internal
// address, so only explicitly trusted client origins are ever fetched.
export function allowedCimdOrigins(): string[] {
  return parseAllowedOrigins(process.env[CIMD_ALLOWLIST_ENV]);
}

export function isCimdOriginAllowed(clientId: string): boolean {
  const allowed = allowedCimdOrigins();
  if (!allowed.length) return false;
  const origin = clientMetadataOrigin(clientId);
  return Boolean(origin && allowed.includes(origin));
}

export async function resolveOAuthClient(
  clientId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ResolvedOAuthClient | null> {
  if (isDynamicClientId(clientId)) return readRegisteredClient(clientId);

  if (isClientMetadataDocumentId(clientId)) {
    if (!isCimdOriginAllowed(clientId)) {
      throw new Error(`client metadata document origin is not allowed: ${clientMetadataOrigin(clientId) || clientId}`);
    }
    return resolveMetadataDocumentClient(clientId, options.fetchImpl || fetch);
  }

  return null;
}

export async function registerDynamicClient(input: {
  clientName?: unknown;
  redirectUris?: unknown;
}): Promise<ResolvedOAuthClient> {
  const redirectUris = normalizeRedirectUris(input.redirectUris) as string[];
  const clientName = String(input.clientName || 'MCP client').slice(0, 120);
  const key = currentSigningKey();
  const clientId = await signCredential(key.secret, key.version, 'client', {
    n: clientName,
    r: redirectUris,
  });
  return { clientId, clientName, redirectUris, source: 'dcr' };
}

async function readRegisteredClient(clientId: string): Promise<ResolvedOAuthClient | null> {
  let keys;
  try {
    keys = verificationKeys();
  } catch {
    return null;
  }

  const envelope = await verifyCredential(keys, 'client', clientId);
  if (!envelope) return null;
  if (!Number.isFinite(envelope.iat) || Date.now() - envelope.iat > DCR_CLIENT_TTL_MS) return null;

  const data = envelope.d;
  if (!data || typeof data !== 'object' || !Number.isFinite(envelope.iat)) return null;

  try {
    return {
      clientId,
      clientName: String(data.n || 'MCP client').slice(0, 120),
      redirectUris: normalizeRedirectUris(data.r) as string[],
      source: 'dcr',
    };
  } catch {
    return null;
  }
}

async function resolveMetadataDocumentClient(
  clientId: string,
  fetchImpl: FetchLike,
): Promise<ResolvedOAuthClient> {
  const cached = documentCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;
  if (cached) documentCache.delete(clientId);

  // redirect: 'manual' pins the lookup to the exact client_id URL and refuses to
  // follow a redirect response. It is not by itself an SSRF control — the origin
  // allowlist above is what keeps this fetch away from internal hosts.
  const response = await fetchImpl(clientId, {
    redirect: 'manual',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`client metadata document request failed with HTTP ${response.status}`);
  }

  const text = await readBoundedText(response, MAX_CLIENT_DOCUMENT_BYTES);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('client metadata document is not valid JSON');
  }

  const client = parseClientMetadataDocument(document, clientId) as ResolvedOAuthClient;
  cacheDocument(clientId, client);
  return client;
}

function cacheDocument(clientId: string, client: ResolvedOAuthClient): void {
  const now = Date.now();

  const entries: { key: string; expiresAt: number }[] = [];
  documentCache.forEach((entry, key) => entries.push({ key, expiresAt: entry.expiresAt }));

  entries.filter(entry => entry.expiresAt <= now).forEach(entry => documentCache.delete(entry.key));
  if (documentCache.size < DOCUMENT_CACHE_MAX_ENTRIES) {
    documentCache.set(clientId, { client, expiresAt: now + DOCUMENT_CACHE_TTL_MS });
    return;
  }

  const oldest = entries
    .filter(entry => entry.expiresAt > now)
    .sort((left, right) => left.expiresAt - right.expiresAt)[0];
  if (oldest) documentCache.delete(oldest.key);
  documentCache.set(clientId, { client, expiresAt: now + DOCUMENT_CACHE_TTL_MS });
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('client metadata document is too large');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('client metadata document is too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}
