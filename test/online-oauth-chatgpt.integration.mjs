// Integration test against the live ChatGPT client metadata document.
// Excluded from the default unit run because it needs network access.
// Run: npm run test:integration
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isClientMetadataDocumentId } from '../lib/mcp/oauth-client.mjs';

const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
process.env.MCP_CIMD_ALLOWED_ORIGINS = 'https://chatgpt.com';

const { resolveOAuthClient } = await import('../lib/mcp-server/oauth-clients.ts');

assert.equal(isClientMetadataDocumentId(CHATGPT_CLIENT_ID), true, 'the live ChatGPT client_id must validate structurally');

const client = await resolveOAuthClient(CHATGPT_CLIENT_ID);
assert.equal(client.clientId, CHATGPT_CLIENT_ID);
assert.equal(client.source, 'cimd');
assert.ok(client.redirectUris.length > 0, 'ChatGPT must declare at least one redirect_uri');

console.log(`live ChatGPT CIMD: name=${client.clientName}, redirect_uris=${JSON.stringify(client.redirectUris)}`);

// The stored fixture is used by unit tests, so drift in the live document should
// be visible here rather than silently making the fixture stale.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/chatgpt-client-metadata.json', import.meta.url), 'utf8'));
if (JSON.stringify(client.redirectUris) !== JSON.stringify(fixture.redirect_uris)) {
  console.warn('Fixture drift: ChatGPT redirect_uris changed. Refresh test/fixtures/chatgpt-client-metadata.json.');
}
if (client.clientName !== fixture.client_name) {
  console.warn(`Fixture drift: client_name changed from "${fixture.client_name}" to "${client.clientName}".`);
}

console.log('ChatGPT CIMD integration passed.');
