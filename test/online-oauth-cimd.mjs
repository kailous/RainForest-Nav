// Tests the CIMD fetch path with an injected fetch, so the allowlist boundary,
// validation, bounded reads, failure handling and caching are exercised without
// hitting the network.
import assert from 'node:assert/strict';

process.env.MCP_CIMD_ALLOWED_ORIGINS = 'https://client.example,https://cache-test.example';

const { resolveOAuthClient, isCimdOriginAllowed, allowedCimdOrigins } = await import('../lib/mcp-server/oauth-clients.ts');

function jsonResponse(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

function countingFetch(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

const validDocument = clientId => ({
  client_id: clientId,
  client_name: 'Test Client',
  redirect_uris: ['https://client.example/callback'],
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
});

// --- The allowlist is the SSRF boundary and is enforced before any fetch.
{
  assert.deepEqual(allowedCimdOrigins(), ['https://client.example', 'https://cache-test.example']);
  assert.equal(isCimdOriginAllowed('https://client.example/oauth/client.json'), true);
  assert.equal(isCimdOriginAllowed('https://attacker.example/oauth/client.json'), false);

  const counter = countingFetch(() => jsonResponse({}));
  await assert.rejects(
    () => resolveOAuthClient('https://attacker.example/oauth/client.json', { fetchImpl: counter.fetchImpl }),
    /origin is not allowed/,
    'a non-allowlisted CIMD origin must be refused',
  );
  assert.equal(counter.calls.length, 0, 'the fetch must never happen for a non-allowlisted origin');
}

// A misconfigured (empty) allowlist must fail closed rather than open up.
{
  const previous = process.env.MCP_CIMD_ALLOWED_ORIGINS;
  process.env.MCP_CIMD_ALLOWED_ORIGINS = '';
  assert.deepEqual(allowedCimdOrigins(), []);
  const counter = countingFetch(() => jsonResponse({}));
  await assert.rejects(
    () => resolveOAuthClient('https://client.example/oauth/client.json', { fetchImpl: counter.fetchImpl }),
    /origin is not allowed/,
    'an unset allowlist must refuse every CIMD client',
  );
  assert.equal(counter.calls.length, 0);
  process.env.MCP_CIMD_ALLOWED_ORIGINS = previous;
}

// --- A valid document resolves, and the follow-up call is served from cache.
{
  const clientId = 'https://client.example/oauth/client.json';
  const counter = countingFetch(() => jsonResponse(validDocument(clientId)));

  const first = await resolveOAuthClient(clientId, { fetchImpl: counter.fetchImpl });
  assert.equal(first.clientId, clientId);
  assert.equal(first.clientName, 'Test Client');
  assert.equal(first.source, 'cimd');
  assert.deepEqual(first.redirectUris, ['https://client.example/callback']);

  assert.equal(counter.calls[0].url, clientId, 'the document must be fetched from the client_id URL itself');
  assert.equal(counter.calls[0].init.redirect, 'manual', 'redirects must not be followed');
  assert.equal(counter.calls[0].init.cache, 'no-store');

  const second = await resolveOAuthClient(clientId, { fetchImpl: counter.fetchImpl });
  assert.equal(second.clientId, clientId);
  assert.equal(counter.calls.length, 1, 'a successful lookup must be cached');
}

// --- Failures must surface and must never be cached.
{
  const failingId = 'https://client.example/oauth/failing.json';
  const counter = countingFetch(() => jsonResponse({ error: 'nope' }, { status: 404 }));
  await assert.rejects(() => resolveOAuthClient(failingId, { fetchImpl: counter.fetchImpl }), /HTTP 404/);
  await assert.rejects(() => resolveOAuthClient(failingId, { fetchImpl: counter.fetchImpl }), /HTTP 404/);
  assert.equal(counter.calls.length, 2, 'a 404 must not be cached');
}

{
  const serverErrorId = 'https://client.example/oauth/500.json';
  const counter = countingFetch(() => jsonResponse({}, { status: 503 }));
  await assert.rejects(() => resolveOAuthClient(serverErrorId, { fetchImpl: counter.fetchImpl }), /HTTP 503/);
  await assert.rejects(() => resolveOAuthClient(serverErrorId, { fetchImpl: counter.fetchImpl }), /HTTP 503/);
  assert.equal(counter.calls.length, 2, 'a 5xx must not be cached');
}

// A redirect response must be treated as a failure, not silently followed.
{
  const redirectId = 'https://client.example/oauth/redirect.json';
  const counter = countingFetch(() =>
    new Response(null, { status: 302, headers: { location: 'https://attacker.example/client.json' } }),
  );
  await assert.rejects(() => resolveOAuthClient(redirectId, { fetchImpl: counter.fetchImpl }), /HTTP 302/);
  assert.equal(counter.calls.length, 1);
}

// Invalid schemas must not be cached either.
{
  const badJsonId = 'https://client.example/oauth/bad-json.json';
  await assert.rejects(
    () => resolveOAuthClient(badJsonId, { fetchImpl: countingFetch(() => jsonResponse('<html>not json</html>')).fetchImpl }),
    /not valid JSON/,
  );

  const mismatchId = 'https://client.example/oauth/mismatch.json';
  await assert.rejects(
    () =>
      resolveOAuthClient(mismatchId, {
        fetchImpl: countingFetch(() => jsonResponse({ ...validDocument('https://someone-else.example/c.json') })).fetchImpl,
      }),
    /does not match/,
  );

  const badRedirectId = 'https://client.example/oauth/bad-redirect.json';
  await assert.rejects(
    () =>
      resolveOAuthClient(badRedirectId, {
        fetchImpl: countingFetch(() =>
          jsonResponse({ client_id: badRedirectId, redirect_uris: ['http://evil.example.com/cb'] }),
        ).fetchImpl,
      }),
    /unsupported redirect_uri/,
  );
}

// Oversized documents are refused before parsing.
{
  const hugeId = 'https://client.example/oauth/huge.json';
  await assert.rejects(
    () =>
      resolveOAuthClient(hugeId, {
        fetchImpl: countingFetch(() =>
          jsonResponse({ ...validDocument(hugeId), padding: 'x'.repeat(70_000) }),
        ).fetchImpl,
      }),
    /too large/,
  );
}

// --- Unknown or unsafe client_id shapes resolve to null without any fetch.
{
  const counter = countingFetch(() => jsonResponse({}));
  assert.equal(await resolveOAuthClient('not-a-client-id', { fetchImpl: counter.fetchImpl }), null);
  assert.equal(await resolveOAuthClient('', { fetchImpl: counter.fetchImpl }), null);
  assert.equal(await resolveOAuthClient('https://127.0.0.1/client.json', { fetchImpl: counter.fetchImpl }), null);
  assert.equal(await resolveOAuthClient('http://client.example/client.json', { fetchImpl: counter.fetchImpl }), null);
  assert.equal(counter.calls.length, 0, 'an unusable client_id must never trigger a fetch');
}

// --- The cache is bounded: the oldest entry is evicted once the limit is hit.
{
  const counter = countingFetch(url => jsonResponse({ ...validDocument(url) }));
  const first = 'https://cache-test.example/c0.json';
  await resolveOAuthClient(first, { fetchImpl: counter.fetchImpl });
  const callsAfterFirst = counter.calls.length;

  for (let index = 1; index <= 55; index += 1) {
    await resolveOAuthClient(`https://cache-test.example/c${index}.json`, { fetchImpl: counter.fetchImpl });
  }

  const callsBeforeRefetch = counter.calls.length;
  await resolveOAuthClient(first, { fetchImpl: counter.fetchImpl });
  assert.equal(
    counter.calls.length,
    callsBeforeRefetch + 1,
    'the oldest entry must have been evicted, forcing a re-fetch',
  );
  assert.ok(callsAfterFirst >= 1);
}

console.log('Online OAuth CIMD resolution passed.');
