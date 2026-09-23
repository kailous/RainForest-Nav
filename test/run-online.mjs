// Runs every online-MCP test suite, each in its own process.
//
// Sharing a process let suites leak environment variables and Redis state into
// one another (and repeatedly reuse ephemeral ports), which produced failures
// that only appeared in the combined run. A process per suite removes that class
// of flake and keeps each suite's assertions honest.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'online-keys.mjs',
  'online-metadata.mjs',
  'online-oauth-client.mjs',
  'online-oauth-cimd.mjs',
  'online-authorization-request.mjs',
  'online-token-flow.mjs',
  'online-auth-state.mjs',
  'online-mcp-auth.mjs',
];

let failed = 0;

for (const suite of SUITES) {
  const result = spawnSync(
    process.execPath,
    ['--import', join(here, 'ts-resolve-hook.mjs'), '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(here, suite)],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`FAILED: ${suite}`);
    failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} of ${SUITES.length} online suites failed.`);
  process.exit(1);
}
console.log(`\nAll ${SUITES.length} online suites passed.`);
