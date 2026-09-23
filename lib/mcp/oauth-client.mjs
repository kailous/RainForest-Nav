// Client identification for the online authorization server.
//
// Two mechanisms, distinguished by the shape of client_id rather than by
// probing stores:
//   - Client ID Metadata Documents (CIMD): client_id is an HTTPS URL that
//     dereferences to a JSON document. Primary mechanism in the current MCP
//     specification.
//   - Dynamic Client Registration (DCR): client_id is an opaque signed
//     rfn_client_* token. Compatibility fallback.
//
// Runtime-independent: Web APIs only.
import { validatePublicHttpUrl } from './web-assets.mjs';

export const DCR_CLIENT_PREFIX = 'rfn_client_';

export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_DOCUMENT_BYTES = 64_000;
export const MAX_CLIENT_ID_LENGTH = 2_048;

// The only token endpoint authentication method this server offers. CIMD clients
// are public and use PKCE, so a client is acceptable when this value is part of
// its advertised capability set — not when it advertises nothing else.
export const SERVER_TOKEN_ENDPOINT_AUTH_METHODS = ['none'];

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isDynamicClientId(value) {
  const text = String(value || '');
  return text.startsWith(DCR_CLIENT_PREFIX) && text.slice(DCR_CLIENT_PREFIX.length).includes('.');
}

// The URL parser silently normalises literal "." and ".." segments, so the raw
// input has to be inspected. Percent-encoded forms are decoded before checking,
// since a server may decode them after we have passed the URL along.
function hasDotSegment(rawText) {
  const withoutScheme = String(rawText).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const pathStart = withoutScheme.indexOf('/');
  if (pathStart === -1) return false;
  const rawPath = withoutScheme.slice(pathStart).split(/[?#]/, 1)[0];

  return rawPath.split('/').some(segment => {
    if (segment === '.' || segment === '..') return true;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {}
    return decoded === '.' || decoded === '..';
  });
}

// Structural validation of a CIMD client_id.
//
// This is defence in depth only. String-level checks cannot stop a hostname from
// resolving to an internal address (DNS rebinding), so the actual security
// boundary for this deployment is the origin allowlist enforced by
// lib/mcp-server/oauth-clients.ts before any fetch happens.
export function isClientMetadataDocumentId(value) {
  const text = String(value || '');
  if (!text || text.length > MAX_CLIENT_ID_LENGTH) return false;

  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.hash) return false;
  // A query would let the same client present many distinct client_ids, so it is
  // refused outright to keep the identifier stable.
  if (url.search) return false;
  if (!url.pathname || url.pathname === '/') return false;
  if (hasDotSegment(text)) return false;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Any IP literal is refused: genuine CIMD documents are served from named
  // hosts, and refusing all literals removes the whole private-range question.
  if (hostname.includes(':')) return false;
  if (IPV4_LITERAL.test(hostname)) return false;

  try {
    validatePublicHttpUrl(text);
  } catch {
    return false;
  }
  return true;
}

export function clientMetadataOrigin(clientId) {
  try {
    return new URL(String(clientId)).origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(value) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        try {
          return new URL(item).origin;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  )];
}

export function isAcceptableRedirectUri(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export function normalizeRedirectUris(value) {
  if (!Array.isArray(value)) throw new Error('redirect_uris must be an array');
  const unique = [...new Set(value)];
  if (!unique.length) throw new Error('redirect_uris must not be empty');
  if (unique.length > MAX_REDIRECT_URIS) {
    throw new Error(`redirect_uris must contain at most ${MAX_REDIRECT_URIS} entries`);
  }
  for (const uri of unique) {
    if (typeof uri !== 'string' || !isAcceptableRedirectUri(uri)) {
      throw new Error(`unsupported redirect_uri: ${uri}`);
    }
  }
  return unique;
}

// The plural field is the capability list. `token_endpoint_auth_method` is only
// consulted when the plural form is absent, because clients in transition
// advertise both and the singular value may name a method the client supports
// but this server does not offer.
export function resolveTokenEndpointAuthMethods(document) {
  const plural = Array.isArray(document?.token_endpoint_auth_methods_supported)
    ? document.token_endpoint_auth_methods_supported.filter(method => typeof method === 'string')
    : [];
  if (plural.length) return plural;

  if (typeof document?.token_endpoint_auth_method === 'string' && document.token_endpoint_auth_method) {
    return [document.token_endpoint_auth_method];
  }

  // CIMD forbids client secrets, so an unspecified method means a public client.
  return [...SERVER_TOKEN_ENDPOINT_AUTH_METHODS];
}

export function parseClientMetadataDocument(document, expectedClientId) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('client metadata document must be a JSON object');
  }
  if (document.client_id !== expectedClientId) {
    throw new Error('client metadata document client_id does not match the requested client_id');
  }

  const offered = resolveTokenEndpointAuthMethods(document);
  if (!offered.some(method => SERVER_TOKEN_ENDPOINT_AUTH_METHODS.includes(method))) {
    throw new Error(
      `client does not support any token endpoint authentication method this server offers (${SERVER_TOKEN_ENDPOINT_AUTH_METHODS.join(', ')})`,
    );
  }

  const fallbackName = new URL(expectedClientId).hostname;
  return {
    clientId: expectedClientId,
    clientName: String(document.client_name || fallbackName).slice(0, 120),
    redirectUris: normalizeRedirectUris(document.redirect_uris),
    source: 'cimd',
  };
}

// redirect_uri must be an exact string match — no normalization, no case
// folding, no prefix or substring comparison.
export function redirectUriMatches(client, redirectUri) {
  return Array.isArray(client?.redirectUris) && client.redirectUris.includes(String(redirectUri || ''));
}
