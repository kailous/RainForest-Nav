// Unit tests for client identification: CIMD primary, DCR compatibility
// fallback. Includes the real ChatGPT client metadata document as a fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DCR_CLIENT_PREFIX,
  SERVER_TOKEN_ENDPOINT_AUTH_METHODS,
  clientMetadataOrigin,
  isAcceptableRedirectUri,
  isClientMetadataDocumentId,
  isDynamicClientId,
  normalizeRedirectUris,
  parseAllowedOrigins,
  parseClientMetadataDocument,
  redirectUriMatches,
  resolveTokenEndpointAuthMethods,
} from '../lib/mcp/oauth-client.mjs';
import {
  CREDENTIAL_PREFIXES,
  SIGNING_CONTEXTS,
  base64urlDecode,
  base64urlEncode,
  randomToken,
  signCredential,
  verifyCredential,
} from '../lib/mcp/crypto.mjs';

const SECRET = 'test-signing-secret-with-enough-length';
const KEYS = [{ version: 1, secret: SECRET }];

// --- client_id classification is by shape, never by probing a store.
assert.equal(isDynamicClientId(`${DCR_CLIENT_PREFIX}abc.def`), true);
assert.equal(isDynamicClientId('https://chatgpt.com/oauth/client.json'), false);
assert.equal(isDynamicClientId(`rfn_live_${'a'.repeat(43)}`), false, 'an MCP key must not look like a client id');

assert.equal(isClientMetadataDocumentId('https://chatgpt.com/oauth/client.json'), true);
assert.equal(isClientMetadataDocumentId('rfn_client_abc.def'), false, 'a DCR id must not look like a document');
assert.equal(isClientMetadataDocumentId('http://chatgpt.com/oauth/client.json'), false, 'CIMD requires https');

// --- CIMD client_id structural rules.
assert.equal(isClientMetadataDocumentId('https://chatgpt.com/'), false, 'a bare origin is not a document id');
assert.equal(isClientMetadataDocumentId('https://chatgpt.com'), false, 'a bare host is not a document id');
assert.equal(isClientMetadataDocumentId('https://user:pass@chatgpt.com/client.json'), false, 'userinfo is refused');
assert.equal(isClientMetadataDocumentId('https://chatgpt.com/client.json#frag'), false, 'fragments are refused');
assert.equal(isClientMetadataDocumentId('https://chatgpt.com/client.json?v=2'), false, 'a query would destabilise the id');
assert.equal(isClientMetadataDocumentId('https://chatgpt.com/a/../client.json'), false, 'dot segments are refused');
assert.equal(isClientMetadataDocumentId('https://chatgpt.com/./client.json'), false);
assert.equal(isClientMetadataDocumentId(`https://chatgpt.com/${'a'.repeat(2_100)}.json`), false, 'over-long ids are refused');
assert.equal(isClientMetadataDocumentId(''), false);

// --- SSRF surface: internal targets must never be accepted as a client_id.
for (const internal of [
  'https://localhost/client.json',
  'https://127.0.0.1/client.json',
  'https://10.0.0.1/client.json',
  'https://172.16.5.4/client.json',
  'https://192.168.1.10/client.json',
  'https://169.254.169.254/latest/meta-data',
  'https://100.64.0.1/client.json',
  'https://[::1]/client.json',
  'https://[fc00::1]/client.json',
  'https://[fd12:3456::1]/client.json',
  'https://[fe80::1]/client.json',
  'https://[::ffff:10.0.0.1]/client.json',
  'https://metadata.internal/client.json',
  'https://service.local/client.json',
  'https://thing.lan/client.json',
]) {
  assert.equal(isClientMetadataDocumentId(internal), false, `${internal} must be rejected as a client_id`);
}

// --- Origin allowlist parsing.
assert.deepEqual(parseAllowedOrigins('https://chatgpt.com, https://chat.openai.com'), [
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
assert.deepEqual(parseAllowedOrigins('https://chatgpt.com/oauth/client.json'), ['https://chatgpt.com'], 'paths collapse to an origin');
assert.deepEqual(parseAllowedOrigins('https://chatgpt.com,https://chatgpt.com'), ['https://chatgpt.com'], 'duplicates collapse');
assert.deepEqual(parseAllowedOrigins('not a url,https://a.example'), ['https://a.example']);
assert.deepEqual(parseAllowedOrigins(''), []);
assert.deepEqual(parseAllowedOrigins(undefined), []);
assert.equal(clientMetadataOrigin('https://chatgpt.com/oauth/client.json'), 'https://chatgpt.com');
assert.equal(clientMetadataOrigin('garbage'), null);

// --- redirect_uri policy: https anywhere, http only on loopback.
assert.equal(isAcceptableRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect'), true);
assert.equal(isAcceptableRedirectUri('http://127.0.0.1:1455/callback'), true);
assert.equal(isAcceptableRedirectUri('http://localhost:3000/callback'), true);
assert.equal(isAcceptableRedirectUri('http://evil.example.com/callback'), false, 'plain http off-loopback is refused');
assert.equal(isAcceptableRedirectUri('https://client.example.com/cb#fragment'), false, 'fragments are refused');
assert.equal(isAcceptableRedirectUri('not a url'), false);

assert.deepEqual(normalizeRedirectUris(['https://a.example/cb', 'https://a.example/cb']), ['https://a.example/cb']);
assert.throws(() => normalizeRedirectUris([]), /must not be empty/);
assert.throws(() => normalizeRedirectUris('https://a.example/cb'), /must be an array/);
assert.throws(
  () => normalizeRedirectUris(['https://a.example/0', ...Array.from({ length: 10 }, (_, i) => `https://a.example/cb${i}`)]),
  /at most 10/,
);

// --- token_endpoint_auth_method capability intersection.
{
  // Plural capability list wins, and an additional unsupported method is fine.
  assert.deepEqual(resolveTokenEndpointAuthMethods({ token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] }), [
    'none',
    'private_key_jwt',
  ]);
  // Plural present without "none" leaves no intersection.
  assert.deepEqual(resolveTokenEndpointAuthMethods({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }), [
    'private_key_jwt',
  ]);
  // Legacy singular is consulted only when the plural form is absent.
  assert.deepEqual(resolveTokenEndpointAuthMethods({ token_endpoint_auth_method: 'none' }), ['none']);
  // Both present: plural is the capability set, singular is compatibility info.
  assert.deepEqual(
    resolveTokenEndpointAuthMethods({
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none'],
    }),
    ['none'],
  );
  // Neither present: CIMD forbids secrets, so assume a public client.
  assert.deepEqual(resolveTokenEndpointAuthMethods({}), SERVER_TOKEN_ENDPOINT_AUTH_METHODS);
}

const clientId = 'https://chatgpt.com/oauth/client.json';
const document = {
  client_id: clientId,
  client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
};

// 1. plural ["none","private_key_jwt"] PASS (the real ChatGPT shape)
assert.equal(
  parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] }, clientId).clientId,
  clientId,
);
// 2. plural ["private_key_jwt"] FAIL
assert.throws(
  () => parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: ['private_key_jwt'] }, clientId),
  /does not support any token endpoint authentication method/,
);
// 3. legacy singular "none" PASS
assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_method: 'none' }, clientId).clientId, clientId);
// 4. plural + legacy both present: plural decides
assert.equal(
  parseClientMetadataDocument(
    { ...document, token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] },
    clientId,
  ).clientId,
  clientId,
);
// 5. no intersection FAIL
assert.throws(
  () => parseClientMetadataDocument({ ...document, token_endpoint_auth_method: 'client_secret_basic' }, clientId),
  /does not support any token endpoint authentication method/,
);

assert.throws(
  () => parseClientMetadataDocument({ ...document, client_id: 'https://evil.example/c.json' }, clientId),
  /does not match/,
);
assert.throws(() => parseClientMetadataDocument({ ...document, redirect_uris: [] }, clientId), /must not be empty/);
assert.throws(() => parseClientMetadataDocument('not an object', clientId), /JSON object/);
assert.equal(parseClientMetadataDocument({ ...document, client_name: '' }, clientId).clientName, 'chatgpt.com');

// --- Real ChatGPT document must be accepted end to end.
{
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/chatgpt-client-metadata.json', import.meta.url), 'utf8'));
  assert.equal(fixture.token_endpoint_auth_method, 'private_key_jwt', 'fixture should capture the legacy singular value');
  assert.deepEqual(fixture.token_endpoint_auth_methods_supported, ['none', 'private_key_jwt']);
  assert.equal(isClientMetadataDocumentId(fixture.client_id), true);

  const parsed = parseClientMetadataDocument(fixture, fixture.client_id);
  assert.equal(parsed.clientName, 'ChatGPT');
  assert.equal(parsed.source, 'cimd');
  assert.deepEqual(parsed.redirectUris, ['https://chatgpt.com/connector_platform_oauth_redirect']);
  assert.equal(redirectUriMatches(parsed, 'https://chatgpt.com/connector_platform_oauth_redirect'), true);
}

// --- redirect_uri matching is exact, with no normalization.
const parsedClient = parseClientMetadataDocument(document, clientId);
assert.equal(redirectUriMatches(parsedClient, 'https://chatgpt.com/connector_platform_oauth_redirect'), true);
assert.equal(redirectUriMatches(parsedClient, 'https://chatgpt.com/connector_platform_oauth_redirect/'), false, 'a trailing slash must not match');
assert.equal(redirectUriMatches(parsedClient, 'https://CHATGPT.com/connector_platform_oauth_redirect'), false, 'case must not fold');
assert.equal(redirectUriMatches(parsedClient, 'https://chatgpt.com/connector_platform_oauth_redirect?x=1'), false);
assert.equal(redirectUriMatches(parsedClient, 'https://chatgpt.com/connector_platform_oauth_redirect%2F'), false, 'encoding must not match');
assert.equal(redirectUriMatches(parsedClient, 'https://chatgpt.com/'), false);
assert.equal(redirectUriMatches(parsedClient, ''), false);
assert.equal(redirectUriMatches(null, 'https://chatgpt.com/x'), false);

// --- Signing primitives and credential domain separation.
assert.deepEqual(base64urlDecode(base64urlEncode(new Uint8Array([0, 1, 254, 255]))), new Uint8Array([0, 1, 254, 255]));
assert.equal(randomToken('p_').startsWith('p_'), true);
assert.notEqual(randomToken(), randomToken());

const signedClient = await signCredential(SECRET, 1, 'client', { n: 'ChatGPT', r: ['https://chatgpt.com/cb'] });
assert.equal(signedClient.startsWith(CREDENTIAL_PREFIXES.client), true);
const envelope = await verifyCredential(KEYS, 'client', signedClient);
assert.equal(envelope.typ, 'client');
assert.equal(envelope.v, 1);
assert.equal(envelope.d.n, 'ChatGPT');

// Every signed credential type carries its own prefix and signing context.
// Authorization codes are deliberately absent: they are opaque Redis values and
// must never verify as a signed credential.
for (const [type, context] of Object.entries(SIGNING_CONTEXTS)) {
  assert.equal(typeof context, 'string');
  assert.equal(CREDENTIAL_PREFIXES[type].startsWith('rfn_'), true);
}
assert.deepEqual(Object.keys(SIGNING_CONTEXTS).sort(), ['access_token', 'client', 'refresh_token']);
assert.deepEqual(Object.keys(CREDENTIAL_PREFIXES).sort(), ['access_token', 'client', 'refresh_token']);
assert.equal(new Set(Object.values(CREDENTIAL_PREFIXES)).size, 3, 'each credential type needs a distinct prefix');
assert.equal(new Set(Object.values(SIGNING_CONTEXTS)).size, 3, 'each credential type needs a distinct signing context');

// A credential of one type must not verify as another.
const access = await signCredential(SECRET, 1, 'access_token', { d: 'payload' });
const refresh = await signCredential(SECRET, 1, 'refresh_token', { d: 'payload' });

assert.equal(await verifyCredential(KEYS, 'access_token', signedClient), null, 'a client id must not work as an access token');
assert.equal(await verifyCredential(KEYS, 'client', access), null, 'an access token must not work as a client id');
assert.equal(await verifyCredential(KEYS, 'access_token', refresh), null, 'a refresh token must not work as an access token');
assert.equal(await verifyCredential(KEYS, 'refresh_token', access), null, 'an access token must not work as a refresh token');
assert.equal(await verifyCredential(KEYS, 'refresh_token', signedClient), null, 'a client id must not work as a refresh token');

// An opaque authorization code must never verify as any signed credential.
const opaqueCode = `rfn_ac_${'a'.repeat(43)}`;
for (const type of Object.keys(CREDENTIAL_PREFIXES)) {
  assert.equal(await verifyCredential(KEYS, type, opaqueCode), null, `an opaque authorization code must not verify as ${type}`);
}

// Relabelling the prefix must not defeat the type assertion.
const relabelled = CREDENTIAL_PREFIXES.access_token + refresh.slice(CREDENTIAL_PREFIXES.refresh_token.length);
assert.equal(await verifyCredential(KEYS, 'access_token', relabelled), null, 'a relabelled prefix must not pass the type assertion');

// Tampering with typ must invalidate the signature.
{
  const [prefix, rest] = [access.slice(0, CREDENTIAL_PREFIXES.access_token.length), access.slice(CREDENTIAL_PREFIXES.access_token.length)];
  const [body, signature] = rest.split('.');
  const tampered = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
  tampered.typ = 'authorization_code';
  const forgedBody = base64urlEncode(new TextEncoder().encode(JSON.stringify(tampered)));
  assert.equal(
    await verifyCredential(KEYS, 'access_token', `${prefix}${forgedBody}.${signature}`),
    null,
    'a tampered typ must not verify',
  );
  assert.equal(
    await verifyCredential(KEYS, 'access_token', `${prefix}${body}.${signature}tampered`),
    null,
    'a tampered signature must not verify',
  );
}

// A different secret must not verify.
assert.equal(await verifyCredential([{ version: 1, secret: 'a-completely-different-secret-value' }], 'client', signedClient), null);

// --- Signing key rotation: a retained previous key keeps old credentials valid.
const rotatedKeys = [
  { version: 2, secret: 'the-new-signing-secret-value-with-length' },
  { version: 1, secret: SECRET },
];
assert.equal((await verifyCredential(rotatedKeys, 'client', signedClient)).v, 1, 'the legacy key must still verify');
assert.equal(
  await verifyCredential([{ version: 2, secret: 'the-new-signing-secret-value-with-length' }], 'client', signedClient),
  null,
  'without the legacy key the old credential must fail',
);

console.log('Online OAuth client identification passed.');
