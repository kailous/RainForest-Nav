// Unit tests for the online OAuth discovery metadata builders.
import assert from 'node:assert/strict';
import {
  PLUGIN_MCP_RESOURCE,
  PLUGIN_SERVICE_ORIGIN,
  ONLINE_MCP_PATH,
  authorizationServerMetadata,
  onlineMcpResource,
  protectedResourceMetadata,
} from '../lib/mcp/resource.mjs';

const SITE = 'https://nav.rainforest.org.cn';
const SCOPES = ['navigation:read', 'navigation:write'];

// --- Resource IDs are distinct from origins, and never share a value.
assert.equal(PLUGIN_SERVICE_ORIGIN, 'https://mcp.nav.rainforest.org.cn');
assert.equal(PLUGIN_MCP_RESOURCE, 'https://mcp.nav.rainforest.org.cn/mcp');
assert.notEqual(PLUGIN_MCP_RESOURCE, PLUGIN_SERVICE_ORIGIN, 'plugin resource must not equal its origin');
assert.equal(onlineMcpResource(SITE), `${SITE}${ONLINE_MCP_PATH}`);
assert.notEqual(onlineMcpResource(SITE), SITE, 'online resource must not equal the site origin');
assert.notEqual(onlineMcpResource(SITE), PLUGIN_MCP_RESOURCE, 'the two deployments must not share a resource');

// --- Trailing slashes must not produce a different resource identifier.
assert.equal(onlineMcpResource(`${SITE}/`), onlineMcpResource(SITE));
assert.equal(onlineMcpResource(`${SITE}///`), onlineMcpResource(SITE));

// --- Protected resource metadata.
const protectedMeta = protectedResourceMetadata(SITE);
assert.equal(protectedMeta.resource, onlineMcpResource(SITE));
assert.deepEqual(protectedMeta.authorization_servers, [SITE], 'the online site is its own authorization server');
assert.deepEqual(protectedMeta.scopes_supported, SCOPES);
assert.deepEqual(protectedMeta.bearer_methods_supported, ['header']);
assert.equal(
  protectedMeta.authorization_servers.includes(PLUGIN_SERVICE_ORIGIN),
  false,
  'the plugin Worker must never appear as the online authorization server',
);

// --- Authorization server metadata.
const asMeta = authorizationServerMetadata(SITE);
assert.equal(asMeta.issuer, SITE);
assert.equal(asMeta.authorization_endpoint, `${SITE}/oauth/authorize`);
assert.equal(asMeta.token_endpoint, `${SITE}/oauth/token`);
assert.equal(asMeta.registration_endpoint, `${SITE}/oauth/register`);
assert.equal(asMeta.client_id_metadata_document_supported, true, 'CIMD must be advertised as the primary mechanism');
// RFC 9207 is advertised only because the authorization endpoint emits iss on
// both success and error redirects.
assert.equal(
  asMeta.authorization_response_iss_parameter_supported,
  true,
  'iss response support must be advertised now that the authorization endpoint implements it',
);
assert.deepEqual(asMeta.token_endpoint_auth_methods_supported, ['none'], 'CIMD public clients must not require a secret');
assert.deepEqual(asMeta.code_challenge_methods_supported, ['S256'], 'PKCE S256 is the only supported method');
assert.deepEqual(asMeta.response_types_supported, ['code']);
assert.deepEqual(asMeta.grant_types_supported, ['authorization_code', 'refresh_token']);
assert.deepEqual(asMeta.scopes_supported, SCOPES);

// Every endpoint the metadata advertises must live on the site origin.
for (const [field, value] of Object.entries(asMeta)) {
  if (typeof value === 'string' && value.startsWith('http')) {
    assert.ok(value.startsWith(SITE), `${field} must stay on the site origin, got ${value}`);
  }
}

// --- Endpoint paths must not be advertised on the plugin Worker.
assert.equal(String(asMeta.token_endpoint).includes(PLUGIN_SERVICE_ORIGIN), false);

console.log('Online OAuth discovery metadata passed.');
