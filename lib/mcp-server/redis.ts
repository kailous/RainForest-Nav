// Minimal Upstash Redis REST client. Dependency-free on purpose: the online MCP
// auth control plane needs only a handful of commands, and a plain fetch keeps
// this usable from any runtime.
//
// Reads configuration at call time so tests can point it at a local endpoint.
const URL_ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'] as const;
const TOKEN_ENV_KEYS = ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'] as const;
const COMMAND_TIMEOUT_MS = 5_000;

function readEnv(keys: readonly string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return '';
}

export function isRedisConfigured(): boolean {
  return Boolean(readEnv(URL_ENV_KEYS) && readEnv(TOKEN_ENV_KEYS));
}

export function assertRedisConfigured(): void {
  if (!isRedisConfigured()) {
    throw new Error(
      'Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN).',
    );
  }
}

async function command(args: (string | number)[]): Promise<unknown> {
  const endpoint = readEnv(URL_ENV_KEYS);
  const token = readEnv(TOKEN_ENV_KEYS);
  if (!endpoint || !token) throw new Error('Redis is not configured');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });

  const payload = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!response.ok || payload?.error) {
    // Fail closed: callers must never treat an error as "absent but usable".
    throw new Error(payload?.error || `Redis command failed with HTTP ${response.status}`);
  }
  return payload?.result ?? null;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

export const redis = {
  async get(key: string): Promise<string | null> {
    return asString(await command(['GET', key]));
  },

  async set(key: string, value: string, options: { exSeconds?: number } = {}): Promise<void> {
    const args: (string | number)[] = ['SET', key, value];
    if (options.exSeconds) args.push('EX', options.exSeconds);
    await command(args);
  },

  // SET NX EX — the atomic primitive for one-time-use records.
  async setIfAbsent(key: string, value: string, exSeconds: number): Promise<boolean> {
    const result = await command(['SET', key, value, 'NX', 'EX', exSeconds]);
    return asString(result) === 'OK';
  },

  // SET ... XX GET returns the previous value, or null when the key was absent.
  // Kept for simple cases; multi-step state transitions must use eval().
  async setIfExistsAndGet(key: string, value: string, ttlMs: number): Promise<string | null> {
    const result = await command(['SET', key, value, 'XX', 'GET', 'PX', ttlMs]);
    return asString(result);
  },

  // Runs a fixed script server-side. The script text is a constant in our own
  // source and never built from request data.
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<string | null> {
    const result = await command(['EVAL', script, keys.length, ...keys, ...args.map(value => String(value))]);
    return asString(result);
  },

  async getDel(key: string): Promise<string | null> {
    return asString(await command(['GETDEL', key]));
  },

  async del(key: string): Promise<void> {
    await command(['DEL', key]);
  },
};
