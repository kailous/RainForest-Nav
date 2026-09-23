// Minimal Upstash-compatible REST endpoint, backed by an in-memory map.
// Lets the online MCP auth-state code be exercised end to end without live
// Redis credentials. It implements the exact command subset lib/mcp-server
// uses; it is NOT a general Redis emulator.
import { createServer } from 'node:http';

export const FAKE_REDIS_TOKEN = 'fake-upstash-token';

// One server per process. Suites run in a single Node process, so repeatedly
// starting and stopping listeners invites ephemeral-port reuse and stale
// keep-alive sockets. Sharing a single instance removes that class of flake.
let shared = null;

export async function useFakeUpstash() {
  if (!shared) {
    shared = await startFakeUpstash();
    // The shared server is never closed, so it must not hold the event loop
    // open once the suites finish.
    shared.unref();
    process.env.UPSTASH_REDIS_REST_URL = shared.url;
    process.env.UPSTASH_REDIS_REST_TOKEN = shared.token;
  }
  return shared;
}


export async function startFakeUpstash() {
  const store = new Map();

  const liveValue = key => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };

  const execute = args => {
    const [name, ...rest] = args.map(String);
    const command = name.toUpperCase();

    if (command === 'PING') return 'PONG';

    if (command === 'GET') {
      const entry = liveValue(rest[0]);
      return entry ? entry.value : null;
    }

    if (command === 'SET') {
      const [key, value, ...flags] = rest;
      const upper = flags.map(flag => flag.toUpperCase());
      const exIndex = upper.indexOf('EX');
      const pxIndex = upper.indexOf('PX');
      const ttlMs = pxIndex >= 0
        ? Number(flags[pxIndex + 1])
        : exIndex >= 0
          ? Number(flags[exIndex + 1]) * 1000
          : 0;
      const wantsNx = upper.includes('NX');
      const wantsXx = upper.includes('XX');
      const wantsGet = upper.includes('GET');

      const existing = liveValue(key);
      if (wantsNx && existing) return null;
      if (wantsXx && !existing) return null;

      store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
      // SET ... XX GET returns the previous value, which is what makes it an
      // atomic compare-and-swap for refresh-token rotation.
      return wantsGet ? (existing ? existing.value : null) : 'OK';
    }

    if (command === 'GETDEL') {
      const entry = liveValue(rest[0]);
      store.delete(rest[0]);
      return entry ? entry.value : null;
    }

    if (command === 'DEL') {
      const keys = rest;
      return keys.filter(key => store.delete(key)).length;
    }

    // Models the rotation script from lib/mcp-server/refresh-tokens.ts. The fake
    // only recognises that exact script, and the real Lua is exercised by
    // test/upstash-integration.mjs against a live Redis.
    if (command === 'EVAL') {
      const script = String(rest[0]);
      const keyCount = Number(rest[1]);
      const keys = rest.slice(2, 2 + keyCount);
      const argv = rest.slice(2 + keyCount);
      if (!script.includes('rf-rotate-refresh-v1')) throw new Error('unsupported script');
      return rotateRefresh(keys, argv);
    }

    throw new Error(`unsupported command: ${command}`);
  };

  // Synchronous by construction, so the compare/rotate/revoke sequence is
  // atomic here in the same way Lua makes it atomic on a real server.
  const rotateRefresh = ([jtiKey, familyKey], [presentedJti, nextJti, ttlRaw, capRaw]) => {
    const current = liveValue(jtiKey);
    if (!current) return 'missing';

    if (!liveValue(familyKey)) {
      store.delete(jtiKey);
      return 'missing';
    }

    if (current.value !== presentedJti) {
      store.delete(jtiKey);
      store.delete(familyKey);
      return 'replay';
    }

    const ttl = Number(ttlRaw);
    if (!ttl || ttl <= 0) {
      store.delete(jtiKey);
      store.delete(familyKey);
      return 'expired';
    }

    store.set(jtiKey, { value: nextJti, expiresAt: Date.now() + ttl });

    const family = liveValue(familyKey);
    const familyTtl = family.expiresAt ? family.expiresAt - Date.now() : -1;
    const cap = Number(capRaw);
    if (family.expiresAt && (familyTtl < 0 || familyTtl > cap)) family.expiresAt = Date.now() + cap;

    return 'rotated';
  };

  const server = createServer((req, res) => {
    // Force a fresh connection per request. Without this, the OS can hand a
    // later test the same ephemeral port and the client's keep-alive pool will
    // reuse a socket that belonged to an already-closed server.
    res.shouldKeepAlive = false;

    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${FAKE_REDIS_TOKEN}`) {
      return send(401, { error: 'unauthorized' });
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const args = JSON.parse(body);
        if (!Array.isArray(args)) return send(400, { error: 'expected an array command' });
        return send(200, { result: execute(args) });
      } catch (error) {
        return send(400, { error: error instanceof Error ? error.message : 'bad request' });
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    token: FAKE_REDIS_TOKEN,
    size: () => store.size,
    // Suites share one server, so each clears the store before asserting on
    // freshly-created state.
    reset: () => store.clear(),
    unref: () => server.unref(),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
