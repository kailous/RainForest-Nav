// Token machinery tests: PKCE, authorization-code consumption, access tokens,
// and refresh-token rotation including replay and concurrency behaviour.
import assert from 'node:assert/strict';
import { useFakeUpstash } from './fake-upstash.mjs';

const server = await useFakeUpstash();
server.reset();
process.env.MCP_OAUTH_SIGNING_KEY = 'token-flow-signing-secret-long-enough';

const { deriveCodeChallenge, verifyPkceS256 } = await import('../lib/mcp/pkce.mjs');
const { constantTimeStringEquals, verifyCredential } = await import('../lib/mcp/crypto.mjs');
const auth = await import('../lib/mcp-server/auth-state.ts');
const { issueAuthorizationCode, consumeAuthorizationCode } = await import('../lib/mcp-server/authorization-codes.ts');
const { issueAccessToken, verifyAccessToken, normalizeScope, scopeList } = await import('../lib/mcp-server/access-tokens.ts');
const { issueRefreshToken, rotateRefreshToken } = await import('../lib/mcp-server/refresh-tokens.ts');
const { verificationKeys } = await import('../lib/mcp-server/oauth-signing.ts');

const ISSUER = 'https://nav.rainforest.org.cn';
const RESOURCE = 'https://nav.rainforest.org.cn/api/mcp';
const SCOPES = ['navigation:read', 'navigation:write'];

// --- PKCE S256.
{
  const verifier = 'A'.repeat(43);
  const challenge = await deriveCodeChallenge(verifier);
  assert.equal(await verifyPkceS256(verifier, challenge), true);
  assert.equal(await verifyPkceS256(`${verifier}B`, challenge), false, 'a different verifier must fail');
  assert.equal(await verifyPkceS256(verifier, `${challenge.slice(0, -1)}x`), false, 'a different challenge must fail');

  // The verifier is used exactly as submitted: no trimming, no normalisation.
  assert.equal(await verifyPkceS256(` ${verifier} `, challenge), false, 'whitespace must not be trimmed');
  assert.equal(await verifyPkceS256(verifier, ` ${challenge}`), false);

  // Length and charset bounds from RFC 7636.
  assert.equal(await verifyPkceS256('A'.repeat(42), challenge), false, 'under 43 characters must fail');
  assert.equal(await verifyPkceS256('A'.repeat(129), challenge), false, 'over 128 characters must fail');
  assert.equal(await verifyPkceS256(`${'A'.repeat(42)}+`, challenge), false, 'a character outside the allowed set must fail');
  assert.equal(await verifyPkceS256('', challenge), false);
  assert.equal(await verifyPkceS256(verifier, 'short'), false, 'a malformed challenge must fail');

  // `plain` is never accepted: the challenge would have to equal the verifier.
  assert.equal(await verifyPkceS256(verifier, verifier), false, 'plain must not be accepted');
}

assert.equal(constantTimeStringEquals('abc', 'abc'), true);
assert.equal(constantTimeStringEquals('abc', 'abd'), false);
assert.equal(constantTimeStringEquals('abc', 'abcd'), false);
assert.equal(constantTimeStringEquals('', ''), true);

// --- Authorization codes are opaque and single-use.
await auth.createOnlineKey();
let state = await auth.setMcpEnabled(true);
const credentialVersion = state.credentialVersion;

{
  const code = await issueAuthorizationCode({
    clientId: 'rfn_client_x.y',
    redirectUri: 'https://client.example/cb',
    codeChallenge: 'a'.repeat(43),
    codeChallengeMethod: 'S256',
    scopes: SCOPES,
    resource: RESOURCE,
    credentialVersion,
    iat: Date.now(),
  });
  assert.match(code, /^rfn_ac_[A-Za-z0-9_-]{43}$/);

  const record = await consumeAuthorizationCode(code);
  assert.equal(record.clientId, 'rfn_client_x.y');
  assert.equal(record.resource, RESOURCE);
  assert.deepEqual(record.scopes, SCOPES);
  assert.equal(record.credentialVersion, credentialVersion);

  assert.equal(await consumeAuthorizationCode(code), null, 'a code must only be consumed once');
  assert.equal(await consumeAuthorizationCode('rfn_ac_' + 'a'.repeat(43)), null, 'an unknown code must not resolve');
  assert.equal(await consumeAuthorizationCode('rfn_at_' + 'a'.repeat(43)), null, 'a non-code prefix must not resolve');
}

// An opaque authorization code must never verify as any signed credential type.
{
  const code = await issueAuthorizationCode({
    clientId: 'c', redirectUri: 'https://client.example/cb', codeChallenge: 'a'.repeat(43),
    codeChallengeMethod: 'S256', scopes: SCOPES, resource: RESOURCE, credentialVersion, iat: Date.now(),
  });
  for (const type of ['client', 'access_token', 'refresh_token']) {
    assert.equal(await verifyCredential(verificationKeys(), type, code), null, `a code must not verify as ${type}`);
  }
}

// --- Access tokens.
{
  const issued = await issueAccessToken({ issuer: ISSUER, resource: RESOURCE, clientId: 'client-1', scopes: SCOPES, credentialVersion });
  assert.match(issued.token, /^rfn_at_/);
  assert.equal(issued.expiresIn, 3600);

  const verified = await verifyAccessToken(issued.token, { issuer: ISSUER, resource: RESOURCE });
  assert.equal(verified.clientId, 'client-1');
  assert.equal(verified.credentialVersion, credentialVersion);
  assert.deepEqual(verified.scopes, ['navigation:read', 'navigation:write'], 'scope must round-trip canonically');

  // audience and issuer are bound
  assert.equal(await verifyAccessToken(issued.token, { issuer: ISSUER, resource: 'https://nav.rainforest.org.cn' }), null, 'the bare origin is not the resource');
  assert.equal(await verifyAccessToken(issued.token, { issuer: ISSUER, resource: 'https://mcp.nav.rainforest.org.cn/mcp' }), null, 'the plugin resource must not be accepted');
  assert.equal(await verifyAccessToken(issued.token, { issuer: 'https://evil.example', resource: RESOURCE }), null, 'a foreign issuer must not be accepted');

  // A refresh token must not pass as an access token.
  const refresh = await issueRefreshToken({ clientId: 'client-1', resource: RESOURCE, scopes: SCOPES, credentialVersion });
  assert.equal(await verifyAccessToken(refresh.token, { issuer: ISSUER, resource: RESOURCE }), null);
  assert.equal(await verifyAccessToken('rfn_at_not.a.token', { issuer: ISSUER, resource: RESOURCE }), null);

  // The access token must not embed the MCP key, its hash, or PKCE material.
  const payload = JSON.stringify(JSON.parse(Buffer.from(issued.token.split('.')[0].replace('rfn_at_', ''), 'base64url').toString('utf8')));
  for (const forbidden of ['keyHash', 'redirectUri', 'codeChallenge', 'codeVerifier', 'rfn_live_']) {
    assert.equal(payload.includes(forbidden), false, `an access token must not contain ${forbidden}`);
  }
}

assert.equal(normalizeScope(['navigation:write', 'navigation:read', 'navigation:read']), 'navigation:read navigation:write');
assert.deepEqual(scopeList('navigation:write navigation:read'), ['navigation:write', 'navigation:read']);

// --- Refresh token rotation.
{
  const first = await issueRefreshToken({ clientId: 'client-1', resource: RESOURCE, scopes: SCOPES, credentialVersion });

  const rotated = await rotateRefreshToken({
    token: first.token, clientId: 'client-1', resource: RESOURCE, credentialVersion,
  });
  assert.equal(rotated.outcome, 'rotated');
  assert.match(rotated.token, /^rfn_rt_/);
  assert.notEqual(rotated.token, first.token, 'rotation must issue a new token');
  assert.deepEqual(rotated.scopes, SCOPES);

  // Replaying the superseded token revokes the whole family.
  const replay = await rotateRefreshToken({ token: first.token, clientId: 'client-1', resource: RESOURCE, credentialVersion });
  assert.equal(replay.outcome, 'replayed');

  // The token that replaced it is now unusable too.
  const afterReplay = await rotateRefreshToken({ token: rotated.token, clientId: 'client-1', resource: RESOURCE, credentialVersion });
  assert.equal(afterReplay.outcome, 'invalid', 'revoking the family must invalidate the newer token as well');
}

// --- Refresh binding errors.
{
  const issued = await issueRefreshToken({ clientId: 'client-1', resource: RESOURCE, scopes: SCOPES, credentialVersion });

  assert.equal(
    (await rotateRefreshToken({ token: issued.token, clientId: 'other', resource: RESOURCE, credentialVersion })).outcome,
    'invalid',
    'a different client_id must be refused',
  );
  assert.equal(
    (await rotateRefreshToken({ token: issued.token, clientId: 'client-1', resource: 'https://elsewhere.example/api/mcp', credentialVersion })).outcome,
    'invalid',
    'a different resource must be refused',
  );
  assert.equal(
    (await rotateRefreshToken({ token: issued.token, clientId: 'client-1', resource: RESOURCE, credentialVersion: credentialVersion + 1 })).outcome,
    'invalid',
    'a stale credentialVersion must be refused',
  );
  assert.equal(
    (await rotateRefreshToken({ token: issued.token, clientId: 'client-1', resource: RESOURCE, credentialVersion, requestedScope: 'navigation:read' })).outcome,
    'scope_mismatch',
    'a scope change must be refused',
  );
  assert.equal(
    (await rotateRefreshToken({ token: 'rfn_rt_not.a.token', clientId: 'client-1', resource: RESOURCE, credentialVersion })).outcome,
    'invalid',
  );
  // A plugin-issued credential must never work here.
  const pluginStyle = await issueAccessToken({ issuer: ISSUER, resource: RESOURCE, clientId: 'client-1', scopes: SCOPES, credentialVersion });
  assert.equal(
    (await rotateRefreshToken({ token: pluginStyle.token, clientId: 'client-1', resource: RESOURCE, credentialVersion })).outcome,
    'invalid',
    'an access token must not work as a refresh token',
  );
}

// --- A healthy family rotates repeatedly without losing the family.
{
  const issued = await issueRefreshToken({ clientId: 'client-1', resource: RESOURCE, scopes: SCOPES, credentialVersion });
  const first = await rotateRefreshToken({ token: issued.token, clientId: 'client-1', resource: RESOURCE, credentialVersion });
  const second = await rotateRefreshToken({ token: first.token, clientId: 'client-1', resource: RESOURCE, credentialVersion });
  const third = await rotateRefreshToken({ token: second.token, clientId: 'client-1', resource: RESOURCE, credentialVersion });

  assert.equal(first.outcome, 'rotated');
  assert.equal(second.outcome, 'rotated', 'a normal rotation must not revoke the family');
  assert.equal(third.outcome, 'rotated');
  assert.notEqual(third.token, second.token);
}

// --- Concurrency: only one of two simultaneous refreshes may succeed, and the
// loser counts as a replay that tears the family down.
{
  const issued = await issueRefreshToken({ clientId: 'client-1', resource: RESOURCE, scopes: SCOPES, credentialVersion });

  const results = await Promise.all([
    rotateRefreshToken({ token: issued.token, clientId: 'client-1', resource: RESOURCE, credentialVersion }),
    rotateRefreshToken({ token: issued.token, clientId: 'client-1', resource: RESOURCE, credentialVersion }),
  ]);

  const successes = results.filter(result => result.outcome === 'rotated');
  assert.equal(successes.length, 1, `exactly one concurrent refresh must succeed, got ${JSON.stringify(results.map(r => r.outcome))}`);
  assert.deepEqual(
    results.filter(result => result.outcome === 'replayed').length,
    1,
    'the loser must be treated as a replay',
  );

  // Because the loser was a replay, the winner's successor is revoked too.
  const successor = await rotateRefreshToken({
    token: successes[0].token,
    clientId: 'client-1',
    resource: RESOURCE,
    credentialVersion,
  });
  assert.equal(successor.outcome, 'invalid', 'a detected replay must revoke the whole family');
}

// --- A credential change invalidates refresh tokens.
{
  const issued = await issueRefreshToken({ clientId: 'client-1', resource: RESOURCE, scopes: SCOPES, credentialVersion });
  const beforeRevoke = (await auth.readAuthState()).credentialVersion;
  const revoked = await auth.revokeAllOnlineSessions();
  assert.equal(revoked.credentialVersion, beforeRevoke + 1, 'revoke-all must bump the version by exactly one');

  assert.equal(
    (await rotateRefreshToken({ token: issued.token, clientId: 'client-1', resource: RESOURCE, credentialVersion: revoked.credentialVersion })).outcome,
    'invalid',
    'revoke-all must invalidate outstanding refresh tokens without touching Redis families',
  );
}

// --- A disabled service must be detectable before issuing tokens.
{
  const disabled = await auth.setMcpEnabled(false);
  assert.equal(auth.isAuthUsable(disabled), false, 'a disabled deployment must not be reported as usable');
}

console.log('Online token machinery (PKCE, codes, access + refresh rotation) passed.');
