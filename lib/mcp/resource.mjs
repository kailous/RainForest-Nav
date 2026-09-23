// Canonical resource identifiers for both MCP deployments.
//
// Resource IDs and origins are deliberately separate values: an origin is where
// a service is hosted, a resource ID is the audience an OAuth token is bound to.
// Conflating them is what allowed tokens to be reused across deployments.
//
// Plugin deployment (Cloudflare Worker, relays to the browser extension):
//   origin      https://mcp.nav.rainforest.org.cn
//   resource    https://mcp.nav.rainforest.org.cn/mcp
// Online deployment (Next.js on Vercel, reads Vercel Blob directly):
//   origin      https://nav.rainforest.org.cn
//   resource    https://nav.rainforest.org.cn/api/mcp
import { NAVIGATION_SCOPES } from './protocol.mjs';

export const PLUGIN_SERVICE_ORIGIN = 'https://mcp.nav.rainforest.org.cn';
export const PLUGIN_MCP_PATH = '/mcp';
export const PLUGIN_MCP_RESOURCE = `${PLUGIN_SERVICE_ORIGIN}${PLUGIN_MCP_PATH}`;

export const DEFAULT_ONLINE_SITE_ORIGIN = 'https://nav.rainforest.org.cn';
export const ONLINE_MCP_PATH = '/api/mcp';
export const ONLINE_AUTHORIZE_PATH = '/oauth/authorize';

export function normalizeOrigin(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('origin is required');
  return trimmed;
}

export function onlineMcpResource(siteOrigin) {
  return `${normalizeOrigin(siteOrigin)}${ONLINE_MCP_PATH}`;
}

// RFC 9728 protected resource metadata. authorization_servers points back at the
// site itself: the online deployment is its own authorization server and never
// delegates to the plugin Worker.
export function protectedResourceMetadata(siteOrigin) {
  const origin = normalizeOrigin(siteOrigin);
  return {
    resource: onlineMcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: NAVIGATION_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'RainForest Navigator online navigation',
    resource_documentation: origin,
  };
}

// RFC 8414 authorization server metadata. CIMD is the primary client
// registration mechanism (current MCP specification); registration_endpoint is
// advertised only as the compatibility fallback for clients that still require
// Dynamic Client Registration.
//
// authorization_response_iss_parameter_supported is advertised because the
// authorization endpoint implements RFC 9207: every authorization response,
// including error redirects, carries iss.
export function authorizationServerMetadata(siteOrigin) {
  const origin = normalizeOrigin(siteOrigin);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${ONLINE_AUTHORIZE_PATH}`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: NAVIGATION_SCOPES,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
