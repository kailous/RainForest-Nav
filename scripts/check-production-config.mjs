#!/usr/bin/env node
// Pre-deployment environment check for the online MCP deployment.
//
// Run against the production environment (for example with `vercel env pull`):
//   node --env-file=.env.production.local scripts/check-production-config.mjs
//
// Exits non-zero when a blocking problem is found, so it can gate a release.
const results = [];

function pass(name, detail) {
  results.push({ level: 'PASS', name, detail });
}

function warn(name, detail) {
  results.push({ level: 'WARN', name, detail });
}

function fail(name, detail) {
  results.push({ level: 'FAIL', name, detail });
}

function read(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return null;
}

const MIN_SECRET_LENGTH = 32;

// --- Canonical origin. Production must never derive the OAuth issuer from the
// Host header, so this is mandatory and must be a bare https origin.
{
  const configured = process.env.ONLINE_SITE_ORIGIN;
  if (!configured) {
    fail('ONLINE_SITE_ORIGIN', 'required in production; without it the OAuth issuer cannot be pinned');
  } else if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(configured)) {
    fail('ONLINE_SITE_ORIGIN', `must be a bare https origin with no path or trailing slash, got "${configured}"`);
  } else {
    pass('ONLINE_SITE_ORIGIN', configured);
  }
}

// --- Redis holds the auth control plane and is a hard dependency.
{
  const redis = read('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL');
  const token = read('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN');
  if (!redis || !token) {
    fail('Redis credentials', 'set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  } else if (!/^https:\/\//.test(redis.value)) {
    fail(redis.name, 'must be an https endpoint');
  } else {
    pass('Redis credentials', `${redis.name} configured (token present)`);
  }
}

// --- OAuth signing secret.
{
  const key = process.env.MCP_OAUTH_SIGNING_KEY;
  if (!key) {
    fail('MCP_OAUTH_SIGNING_KEY', 'required; OAuth flows cannot work without it');
  } else if (key.length < MIN_SECRET_LENGTH) {
    fail('MCP_OAUTH_SIGNING_KEY', `must be at least ${MIN_SECRET_LENGTH} characters`);
  } else if (/^(change|test|example|secret|password)/i.test(key)) {
    fail('MCP_OAUTH_SIGNING_KEY', 'looks like a placeholder value');
  } else {
    pass('MCP_OAUTH_SIGNING_KEY', `configured (${key.length} characters)`);
  }

  if (process.env.MCP_OAUTH_SIGNING_KEY_PREVIOUS) {
    warn(
      'MCP_OAUTH_SIGNING_KEY_PREVIOUS',
      'verification-only: it must never sign new credentials, and must be removed once the migration window closes',
    );
  }
}

// --- Blob storage for navigation data.
{
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    fail('BLOB_READ_WRITE_TOKEN', 'required for online navigation storage');
  } else {
    pass('BLOB_READ_WRITE_TOKEN', 'configured');
  }
}

// --- Admin console credential. Must exist and must stay out of the MCP path.
{
  if (!process.env.ADMIN_PASSWORD) {
    fail('ADMIN_PASSWORD', 'required for the admin console');
  } else {
    pass('ADMIN_PASSWORD', 'configured (admin console only)');
  }
}

// --- CIMD allowlist. Without it, URL-based client registration is refused.
{
  const allowed = process.env.MCP_CIMD_ALLOWED_ORIGINS;
  if (!allowed) {
    warn(
      'MCP_CIMD_ALLOWED_ORIGINS',
      'not set: CIMD clients (ChatGPT) will be refused and only DCR fallback will work',
    );
  } else {
    const origins = allowed.split(',').map(value => value.trim()).filter(Boolean);
    const invalid = origins.filter(value => !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value));
    if (!origins.length || invalid.length) {
      fail('MCP_CIMD_ALLOWED_ORIGINS', `must be a comma-separated list of https origins, offending: ${invalid.join(', ')}`);
    } else {
      pass('MCP_CIMD_ALLOWED_ORIGINS', origins.join(', '));
    }
  }
}

// --- Retired credentials must not be present, and secrets must never be public.
for (const name of ['MCP_API_KEY', 'ENABLE_LEGACY_MCP_API_KEY']) {
  if (process.env[name]) {
    fail(name, 'retired: this credential path was removed and must not be configured');
  } else {
    pass(name, 'absent as expected');
  }
}

for (const name of Object.keys(process.env)) {
  if (name.startsWith('NEXT_PUBLIC_') && /(SECRET|TOKEN|KEY|PASSWORD)/i.test(name)) {
    fail(name, 'secrets must never use the NEXT_PUBLIC_ prefix');
  }
}

// --- Report.
const order = { FAIL: 0, WARN: 1, PASS: 2 };
results.sort((left, right) => order[left.level] - order[right.level]);

const width = Math.max(...results.map(entry => entry.name.length));
console.log('\nOnline MCP production configuration\n');
for (const entry of results) {
  console.log(`  ${entry.level.padEnd(4)}  ${entry.name.padEnd(width)}  ${entry.detail}`);
}

const failures = results.filter(entry => entry.level === 'FAIL').length;
const warnings = results.filter(entry => entry.level === 'WARN').length;
console.log(`\n${results.length - failures - warnings} passed, ${warnings} warning(s), ${failures} failure(s)\n`);

if (failures) {
  console.error('NOT READY: resolve every FAIL before deploying.');
  process.exit(1);
}
console.log('Configuration looks deployable. Remember to run npm run test:upstash-integration against the real Redis.');
