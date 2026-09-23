// Structural guard for pages/admin.js.
//
// A previous partial-hunk staging of this file placed the MCP useEffect inside
// the login submit handler and dropped the MCP helper definitions. Neither
// `tsc` nor `next build` catches that class of mistake, so it shipped and broke
// the admin login. These invariants catch it at test time instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../pages/admin.js', import.meta.url), 'utf8');
const lines = source.split('\n');

// 1. Every React hook call must sit at the component's top level. A hook nested
// in a handler, branch or loop is an invalid hook call at runtime.
const hookLines = lines
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(entry => /useEffect\s*\(/.test(entry.line) && !entry.line.includes('import '));

assert.ok(hookLines.length > 0, 'expected the admin page to declare hooks');

for (const hook of hookLines) {
  assert.match(
    hook.line,
    /^ {2}useEffect\s*\(/,
    `pages/admin.js:${hook.number} calls useEffect at a nested indentation — hooks must stay at the component top level`,
  );
}

// 2. The login submit handler must never contain a hook call.
{
  const start = lines.findIndex(line => line.includes('const handleLogin'));
  assert.ok(start >= 0, 'expected handleLogin to exist in pages/admin.js');

  const end = lines.findIndex((line, index) => index > start && line === '  };');
  assert.ok(end > start, 'expected to find the end of handleLogin');

  const body = lines.slice(start, end + 1).join('\n');
  assert.equal(body.includes('useEffect'), false, 'handleLogin must not call useEffect');
}

// 3. Every helper the MCP panel references must be defined exactly once. A
// referenced-but-undefined helper only fails when the page is rendered.
for (const helper of [
  'copyMcpText',
  'mcpRequest',
  'loadMcpState',
  'runMcpAction',
  'copyLocalMcpConfig',
  'formatMcpTime',
]) {
  const definitions = source.match(new RegExp(`const ${helper} =`, 'g')) || [];
  assert.equal(definitions.length, 1, `${helper} must be defined exactly once in pages/admin.js`);
}

// 4. Balanced braces are a cheap proxy for a structurally intact file.
{
  const opens = (source.match(/{/g) || []).length;
  const closes = (source.match(/}/g) || []).length;
  assert.equal(opens, closes, 'pages/admin.js has unbalanced braces');
}

console.log('Admin page structure passed.');
