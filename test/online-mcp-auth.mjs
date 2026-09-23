// Online MCP authentication matrix.
import assert from 'node:assert/strict';
import { useFakeUpstash } from './fake-upstash.mjs';

const server = await useFakeUpstash();
server.reset();
process.env.MCP_OAUTH_SIGNING_KEY = 'mcp-auth-test-signing-secret-long-enough';

const { signCredential } = await import('../lib/mcp/crypto.mjs');
const { requiredScopesForRequest } = await import('../lib/mcp/online-tools.mjs');
const { READ_SCOPE, WRITE_SCOPE } = await import('../lib/mcp/protocol.mjs');
const auth = await import('../lib/mcp-server/auth-state.ts');
const { issueAccessToken } = await import('../lib/mcp-server/access-tokens.ts');
const { authenticateMcpRequest, isMcpAuthFailure, missingScopes } = await import('../lib/mcp-server/mcp-auth.ts');
const { currentSigningKey } = await import('../lib/mcp-server/oauth-signing.ts');

const ISSUER = 'https://nav.rainforest.org.cn';
const RESOURCE = 'https://nav.rainforest.org.cn/api/mcp';
const CONTEXT = { issuer: ISSUER, resource: RESOURCE };

const created = await auth.createOnlineKey();
const mcpKey = created.key;
const state = await auth.setMcpEnabled(true);
const credentialVersion = state.credentialVersion;

const authenticate = authorization => authenticateMcpRequest(authorization, CONTEXT);

async function expectFailure(result, status, code) {
  assert.equal(isMcpAuthFailure(result), true, `expected a failure, got ${JSON.stringify(result)}`);
  assert.equal(result.status, status, `expected HTTP ${status}, got ${result.status} (${result.description})`);
  assert.equal(result.code, code, `expected code ${code}, got ${result.code}`);
  return result;
}

// --- Missing credentials.
{
  const result = await authenticate(undefined);
  await expectFailure(result, 401, 'unauthorized');
  assert.match(result.challenge, /^Bearer resource_metadata="/);
  assert.equal(result.challenge.includes('error='), false, 'a missing credential must not claim an invalid token');
  assert.match(result.challenge, /\.well-known\/oauth-protected-resource\/api\/mcp/, 'the canonical metadata URL must be used');
}

// --- Malformed and unsupported credential types are all rejected.
for (const [label, value] of [
  ['Basic auth', `Basic ${Buffer.from('admin:secret').toString('base64')}`],
  ['non-Bearer scheme', 'Token abc'],
  ['empty Bearer', 'Bearer'],
  ['ambiguous multiple credentials', 'Bearer one, Bearer two'],
  ['admin password', 'Bearer super-secret-admin-password'],
  ['legacy API key', 'Bearer legacy-api-key-value'],
  ['plugin 43-char key', `Bearer ${'B'.repeat(43)}`],
  ['plugin OAuth access token', `Bearer rfo_${'a'.repeat(43)}`],
  ['plugin refresh token', `Bearer rfr_${'a'.repeat(43)}`],
  ['refresh token prefix', `Bearer rfn_rt_${'a'.repeat(43)}`],
  ['authorization code prefix', `Bearer rfn_ac_${'a'.repeat(43)}`],
  ['client id prefix', `Bearer rfn_client_${'a'.repeat(43)}`],
  ['empty string', 'Bearer '],
]) {
  const result = await authenticate(value);
  const failure = await expectFailure(result, 401, 'invalid_token');
  assert.match(failure.challenge, /error="invalid_token"/, `${label} must report invalid_token`);
}

// --- Static key.
{
  const result = await authenticate(`Bearer ${mcpKey}`);
  assert.equal(isMcpAuthFailure(result), false);
  assert.equal(result.authType, 'static_key');
  assert.deepEqual(result.scopes.slice().sort(), [READ_SCOPE, WRITE_SCOPE].sort());
  assert.equal(result.credentialVersion, credentialVersion);

  const wrong = await authenticate(`Bearer rfn_live_${'A'.repeat(43)}`);
  await expectFailure(wrong, 401, 'invalid_token');
}

// --- OAuth access token.
{
  const readOnly = await issueAccessToken({
    issuer: ISSUER,
    resource: RESOURCE,
    clientId: 'client-read',
    scopes: [READ_SCOPE],
    credentialVersion,
  });

  const result = await authenticate(`Bearer ${readOnly.token}`);
  assert.equal(isMcpAuthFailure(result), false);
  assert.equal(result.authType, 'oauth');
  assert.equal(result.clientId, 'client-read');
  assert.deepEqual(result.scopes, [READ_SCOPE]);

  // Scope model: a read-only token must not satisfy a write operation.
  assert.deepEqual(missingScopes(result.scopes, requiredScopesForRequest('tools/call', { name: 'online_list_navigation_entries' })), []);
  assert.deepEqual(missingScopes(result.scopes, requiredScopesForRequest('tools/call', { name: 'online_delete_navigation_entry' })), [WRITE_SCOPE]);
  assert.deepEqual(missingScopes(result.scopes, requiredScopesForRequest('initialize', {})), []);
  assert.deepEqual(missingScopes(result.scopes, requiredScopesForRequest('tools/call', { name: 'not_a_real_tool' })), [], 'an unknown tool must not be escalated to write');

  // A tampered signature must fail.
  const tampered = `${readOnly.token.slice(0, -3)}abc`;
  await expectFailure(await authenticate(`Bearer ${tampered}`), 401, 'invalid_token');

  // Wrong audience / issuer must fail.
  const wrongAudience = await issueAccessToken({
    issuer: ISSUER,
    resource: 'https://mcp.nav.rainforest.org.cn/mcp',
    clientId: 'client-read',
    scopes: [READ_SCOPE],
    credentialVersion,
  });
  await expectFailure(await authenticate(`Bearer ${wrongAudience.token}`), 401, 'invalid_token');

  const wrongIssuer = await issueAccessToken({
    issuer: 'https://evil.example',
    resource: RESOURCE,
    clientId: 'client-read',
    scopes: [READ_SCOPE],
    credentialVersion,
  });
  await expectFailure(await authenticate(`Bearer ${wrongIssuer.token}`), 401, 'invalid_token');
}

// --- Hand-crafted tokens for time, type and version checks.
{
  const key = currentSigningKey();
  const base = { iss: ISSUER, aud: RESOURCE, clientId: 'client-x', scope: READ_SCOPE, v: credentialVersion, jti: 'j1' };

  const expired = await signCredential(key.secret, key.version, 'access_token', {
    ...base, iat: Date.now() - 7_200_000, exp: Date.now() - 3_600_000,
  });
  await expectFailure(await authenticate(`Bearer ${expired}`), 401, 'invalid_token');

  const future = await signCredential(key.secret, key.version, 'access_token', {
    ...base, iat: Date.now() + 600_000, exp: Date.now() + 4_200_000,
  });
  await expectFailure(await authenticate(`Bearer ${future}`), 401, 'invalid_token');

  const smallSkew = await signCredential(key.secret, key.version, 'access_token', {
    ...base, iat: Date.now() + 30_000, exp: Date.now() + 3_600_000,
  });
  assert.equal(isMcpAuthFailure(await authenticate(`Bearer ${smallSkew}`)), false, 'a small clock skew must be tolerated');

  // A refresh token is signed with the same key but a different type, and must
  // not be usable as an access token even if its prefix is swapped.
  const refreshTyped = await signCredential(key.secret, key.version, 'refresh_token', {
    ...base, exp: Date.now() + 3_600_000,
  });
  await expectFailure(await authenticate(`Bearer ${refreshTyped}`), 401, 'invalid_token');

  const relabelledTyp = `rfn_at_${refreshTyped.slice('rfn_rt_'.length)}`;
  await expectFailure(await authenticate(`Bearer ${relabelledTyp}`), 401, 'invalid_token');

  const staleVersion = await signCredential(key.secret, key.version, 'access_token', {
    ...base, v: credentialVersion + 5, exp: Date.now() + 3_600_000,
  });
  await expectFailure(await authenticate(`Bearer ${staleVersion}`), 401, 'invalid_token');
}

// --- Disabling the service blocks every credential, without a challenge.
{
  const disabled = await auth.setMcpEnabled(false);
  assert.equal(disabled.enabled, false);

  for (const credential of [mcpKey, 'rfn_at_whatever']) {
    const result = await authenticate(`Bearer ${credential}`);
    await expectFailure(result, 503, 'service_disabled');
    assert.equal(result.challenge, undefined, 'a disabled service must not send WWW-Authenticate');
  }

  const reEnabled = await auth.setMcpEnabled(true);
  // Old tokens were minted under the previous version and stay dead.
  const staleAfterReEnable = await issueAccessToken({
    issuer: ISSUER, resource: RESOURCE, clientId: 'c', scopes: [READ_SCOPE], credentialVersion: credentialVersion - 1,
  });
  await expectFailure(await authenticate(`Bearer ${staleAfterReEnable.token}`), 401, 'invalid_token');
  assert.equal(isMcpAuthFailure(await authenticate(`Bearer ${mcpKey}`)), false, 'the static key survives a disable/enable cycle');
  assert.ok(reEnabled.credentialVersion > credentialVersion);
}

// --- Redis becomes unavailable: fail closed, never fall back.
{
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:1';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'unreachable';

  const result = await authenticate(`Bearer ${mcpKey}`);
  await expectFailure(result, 503, 'service_unavailable');
  assert.equal(result.challenge, undefined, 'an unavailable service must not trigger re-authorization');

  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = token;
}

console.log('Online MCP authentication matrix passed.');
