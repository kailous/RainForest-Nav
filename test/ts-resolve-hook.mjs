// Test-only resolver hook: lets Node load the project's TypeScript modules the
// same way Next/webpack does, by trying the .ts extension when a relative
// import omits one. Without this, `import './keys'` inside lib/mcp-server
// resolves under Next but fails under Node's native ESM loader.
//
// Usage: node --import ./test/ts-resolve-hook.mjs test/some-test.mjs
import { registerHooks } from 'node:module';

const RELATIVE = /^\.\.?\//;
const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {}
      }
    }
    return nextResolve(specifier, context);
  },
});
