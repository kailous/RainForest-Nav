// Verifies the online MCP auth control plane against a live Redis wire protocol.
// Covers the hard requirement: rotate / disable / revoke-all must invalidate
// previously issued tokens with no propagation delay.
import assert from 'node:assert/strict';
import { useFakeUpstash } from './fake-upstash.mjs';

const server = await useFakeUpstash();
server.reset();

const auth = await import('../lib/mcp-server/auth-state.ts');
const { matchesKeyHash } = await import('../lib/mcp-server/keys.ts');
const { isRedisConfigured } = await import('../lib/mcp-server/redis.ts');

assert.equal(isRedisConfigured(), true, 'redis must be reported as configured');

// --- Unconfigured MCP authenticates nobody.
let state = await auth.readAuthState();
assert.equal(state.enabled, false);
assert.equal(state.credentialVersion, 0);
assert.equal(auth.isAuthUsable(state), false, 'unconfigured MCP must not be usable');

// --- First key generation.
const created = await auth.createOnlineKey();
assert.ok(created, 'first key generation must succeed');
assert.match(created.key, /^rfn_live_[A-Za-z0-9_-]{43}$/);
assert.equal(created.state.credentialVersion, 1, 'first key must bump version to 1');
assert.equal(created.state.enabled, false, 'generating a key must not enable MCP');
assert.equal(matchesKeyHash(created.key, created.state.keyHash), true);

const second = await auth.createOnlineKey();
assert.equal(second, null, 'a second generate must not overwrite the existing key');

// --- Enabling requires a key, and does not itself bump the version.
state = await auth.setMcpEnabled(true);
assert.equal(state.enabled, true);
assert.equal(state.credentialVersion, 1, 'enabling must not bump the version');
assert.equal(auth.isAuthUsable(state), true);

const enablingAgain = await auth.setMcpEnabled(true);
assert.equal(enablingAgain.credentialVersion, 1, 'a redundant enable must not bump the version');

// --- Rotation invalidates the old key and the old credential version instantly.
const staleVersion = state.credentialVersion;
const rotated = await auth.rotateOnlineKey();
assert.notEqual(rotated.key, created.key, 'rotation must produce a new key');
assert.equal(matchesKeyHash(created.key, rotated.state.keyHash), false, 'the old key must stop matching');
assert.equal(matchesKeyHash(rotated.key, rotated.state.keyHash), true);

const afterRotate = await auth.readAuthState();
assert.equal(
  auth.isCredentialVersionCurrent(afterRotate, staleVersion),
  false,
  'a token minted before rotation must be rejected immediately, with no delay',
);
assert.equal(auth.isCredentialVersionCurrent(afterRotate, rotated.state.credentialVersion), true);

// --- revoke-all bumps the version without touching the key or enabled flag.
const beforeRevoke = await auth.readAuthState();
const revoked = await auth.revokeAllOnlineSessions();
assert.equal(revoked.credentialVersion, beforeRevoke.credentialVersion + 1);
assert.equal(revoked.keyHash, beforeRevoke.keyHash, 'revoke-all must not change the key');
assert.equal(revoked.enabled, true, 'revoke-all must not disable MCP');
assert.equal(
  auth.isCredentialVersionCurrent(revoked, beforeRevoke.credentialVersion),
  false,
  'revoke-all must invalidate previously issued tokens immediately',
);

// --- Disabling revokes everything and blocks authentication.
const beforeDisable = await auth.readAuthState();
const disabled = await auth.setMcpEnabled(false);
assert.equal(disabled.enabled, false);
assert.equal(disabled.credentialVersion, beforeDisable.credentialVersion + 1, 'disabling must bump the version');
assert.equal(auth.isAuthUsable(disabled), false, 'disabled MCP must not be usable');
assert.equal(
  auth.isCredentialVersionCurrent(disabled, beforeDisable.credentialVersion),
  false,
  'disabling must invalidate previously issued tokens immediately',
);

// Re-enabling after a disable does not resurrect old tokens.
const reEnabled = await auth.setMcpEnabled(true);
assert.equal(reEnabled.enabled, true);
assert.equal(auth.isCredentialVersionCurrent(reEnabled, beforeDisable.credentialVersion), false);

// --- Malformed versions are never treated as current.
assert.equal(auth.isCredentialVersionCurrent(reEnabled, undefined), false);
assert.equal(auth.isCredentialVersionCurrent(reEnabled, null), false);
assert.equal(auth.isCredentialVersionCurrent(reEnabled, '1'), false);
assert.equal(auth.isCredentialVersionCurrent(reEnabled, 1.5), false);

// --- Activity round trip and throttling.
let activity = await auth.readOnlineMcpActivity();
assert.equal(activity.lastRequestAt, 0);

await auth.recordOnlineMcpActivity('lastRequestAt');
activity = await auth.readOnlineMcpActivity();
const firstStamp = activity.lastRequestAt;
assert.ok(firstStamp > 0, 'activity must be recorded');

await auth.recordOnlineMcpActivity('lastRequestAt');
activity = await auth.readOnlineMcpActivity();
assert.equal(activity.lastRequestAt, firstStamp, 'repeat activity writes must be throttled');

await auth.recordOnlineMcpActivity('lastAuthorizeAt');
activity = await auth.readOnlineMcpActivity();
assert.ok(activity.lastAuthorizeAt > 0, 'lastAuthorizeAt must be tracked independently');

// --- The admin projection must never leak the key hash.
const view = auth.publicOnlineMcpView(reEnabled, activity);
assert.equal(Object.prototype.hasOwnProperty.call(view, 'keyHash'), false, 'the admin view must not expose keyHash');
assert.equal(Object.keys(view).some(key => /hash/i.test(key)), false);

console.log('Online MCP auth state (Redis control plane) passed.');
