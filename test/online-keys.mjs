import assert from 'node:assert/strict';
import {
  generateOnlineKey,
  hashOnlineKey,
  isOnlineKey,
  keyLast4,
  matchesKeyHash,
} from '../lib/mcp-server/keys.ts';

for (let i = 0; i < 25; i += 1) {
  const key = generateOnlineKey();
  assert.match(key, /^rfn_live_[A-Za-z0-9_-]{43}$/, 'key must be rfn_live_ plus a 43-char body');

  const hash = hashOnlineKey(key);
  assert.match(hash, /^[a-f0-9]{64}$/, 'stored hash must be sha256 hex');
  assert.equal(hashOnlineKey(key), hash, 'hashing must be deterministic');
  assert.equal(matchesKeyHash(key, hash), true, 'the issuing key must verify');
  assert.equal(keyLast4(key), key.slice(-4), 'display suffix must be the last four characters');

  const tampered = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(matchesKeyHash(tampered, hash), false, 'a tampered key must not verify');
}

const distinct = new Set();
for (let i = 0; i < 500; i += 1) distinct.add(generateOnlineKey());
assert.equal(distinct.size, 500, 'generated keys must not collide');

// Cross-system isolation: plugin keys are bare 43-char base64url with no prefix.
assert.equal(isOnlineKey('B'.repeat(43)), false, 'bare plugin keys must not be treated as online keys');
assert.equal(isOnlineKey(`rfn_live_${'a'.repeat(42)}`), false, 'short bodies must be rejected');
assert.equal(isOnlineKey(`rfn_live_${'a'.repeat(44)}`), false, 'long bodies must be rejected');
assert.equal(isOnlineKey('rfo_oauthstyle'), false, 'OAuth-style prefixes must not be online keys');
assert.equal(isOnlineKey(''), false, 'empty input must be rejected');

// Unconfigured MCP must never authenticate anyone.
assert.equal(matchesKeyHash(generateOnlineKey(), ''), false, 'an empty stored hash must never match');

console.log('Online MCP key primitives passed.');
