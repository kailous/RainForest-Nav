// Validates the Redis primitives against a real Upstash instance, including the
// refresh rotation Lua script. This is the source of truth for the script's
// behaviour; the in-process test double only models it.
//
// Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the KV_*
// equivalents). Without them the suite SKIPs explicitly — it never fakes a pass.
//
// Run: UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npm run test:upstash-integration
import assert from 'node:assert/strict';

const endpoint = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

if (!endpoint || !token) {
  console.log('SKIPPED: no real Upstash credentials in the environment (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).');
  console.log('This suite must pass before production deployment.');
  process.exit(0);
}

process.env.MCP_OAUTH_SIGNING_KEY = process.env.MCP_OAUTH_SIGNING_KEY || 'upstash-integration-signing-secret-long';
const { redis } = await import('../lib/mcp-server/redis.ts');
const { issueRefreshToken, rotateRefreshToken } = await import('../lib/mcp-server/refresh-tokens.ts');

const RESOURCE = 'https://nav.rainforest.org.cn/api/mcp';
const SCOPES = ['navigation:read', 'navigation:write'];
const credentialVersion = 1;
const namespace = `itest:${Date.now()}:${Math.random().toString(36).slice(2)}`;

const createdKeys = [];
const trackKey = async key => {
  createdKeys.push(key);
  return key;
};

try {
  // --- Core primitives.
  const probe = namespace + ':probe';
  await trackKey(probe);

  await redis.set(probe, 'v1');
  assert.equal(await redis.get(probe), 'v1', 'SET/GET must round-trip');

  assert.equal(await redis.setIfAbsent(probe, 'v2', 60), false, 'SET NX must fail when the key exists');
  assert.equal(await redis.get(probe), 'v1', 'SET NX must not overwrite');

  const nxKey = await trackKey(namespace + ':nx');
  assert.equal(await redis.setIfAbsent(nxKey, 'first', 60), true, 'SET NX must succeed on an absent key');
  assert.equal(await redis.setIfAbsent(nxKey, 'second', 60), false, 'SET NX must fail on the second attempt');

  assert.equal(await redis.getDel(nxKey), 'first', 'GETDEL must return the value');
  assert.equal(await redis.get(nxKey), null, 'GETDEL must remove the key');

  // --- EVAL support, exercised with a trivial script first.
  assert.equal(await redis.eval("return 'pong'", [], []), 'pong', 'EVAL must be supported by this instance');
  assert.equal(await redis.eval('return ARGV[1]', [], ['echoed']), 'echoed');

  // --- Comparison primitives the rotation script depends on.
  const luaKey = await trackKey(namespace + ':lua');
  await redis.set(luaKey, 'value', { exSeconds: 60 });
  assert.equal(await redis.eval("local v = redis.call('GET', KEYS[1]) if v == ARGV[1] then return 'match' end return 'mismatch'", [luaKey], ['value']), 'match');
  assert.ok((await redis.eval("return redis.call('PTTL', KEYS[1])", [luaKey], [])) !== null, 'PTTL must be available inside scripts');

  // --- Real refresh rotation through the real Lua script.
  const issued = await issueRefreshToken({
    clientId: 'itest-client',
    resource: RESOURCE,
    scopes: SCOPES,
    credentialVersion,
  });

  const rotated = await rotateRefreshToken({
    token: issued.token,
    clientId: 'itest-client',
    resource: RESOURCE,
    credentialVersion,
  });
  assert.equal(rotated.outcome, 'rotated', 'the rotation script must return rotated against real Redis');

  const replay = await rotateRefreshToken({
    token: issued.token,
    clientId: 'itest-client',
    resource: RESOURCE,
    credentialVersion,
  });
  assert.equal(replay.outcome, 'replayed', 'reusing a superseded token must be detected as a replay');

  const afterReplay = await rotateRefreshToken({
    token: rotated.token,
    clientId: 'itest-client',
    resource: RESOURCE,
    credentialVersion,
  });
  assert.equal(afterReplay.outcome, 'invalid', 'a detected replay must revoke the family');

  // --- Concurrent rotation must yield exactly one success.
  const concurrent = await issueRefreshToken({
    clientId: 'itest-client',
    resource: RESOURCE,
    scopes: SCOPES,
    credentialVersion,
  });
  const results = await Promise.all([
    rotateRefreshToken({ token: concurrent.token, clientId: 'itest-client', resource: RESOURCE, credentialVersion }),
    rotateRefreshToken({ token: concurrent.token, clientId: 'itest-client', resource: RESOURCE, credentialVersion }),
    rotateRefreshToken({ token: concurrent.token, clientId: 'itest-client', resource: RESOURCE, credentialVersion }),
  ]);
  const successes = results.filter(result => result.outcome === 'rotated');
  assert.equal(
    successes.length,
    1,
    `exactly one of three concurrent rotations must succeed against real Redis, got ${JSON.stringify(results.map(r => r.outcome))}`,
  );

  console.log('Real Upstash integration passed (primitives, EVAL, refresh rotation, concurrency).');
} finally {
  // Nothing outside this namespace is touched, but clean up anyway.
  await Promise.all(createdKeys.map(key => redis.del(key).catch(() => {})));
}
