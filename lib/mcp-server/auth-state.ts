import { generateOnlineKey, hashOnlineKey, keyLast4 } from './keys';
import { redis } from './redis';

// The online MCP auth control plane lives in Redis, not Vercel Blob: Blob in the
// pinned SDK only supports public objects with guessable pathnames, and cannot
// promise that a rotated credentialVersion is visible immediately.
const AUTH_KEY = 'online:mcp:auth';
const ACTIVITY_KEY = 'online:mcp:activity';
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60_000;

export interface OnlineMcpAuthState {
  enabled: boolean;
  credentialVersion: number;
  keyHash: string;
  keyLast4: string;
  keyCreatedAt: number;
  updatedAt: number;
}

export interface OnlineMcpActivity {
  lastRequestAt: number;
  lastAuthorizeAt: number;
}

export const DEFAULT_AUTH_STATE: OnlineMcpAuthState = {
  enabled: false,
  credentialVersion: 0,
  keyHash: '',
  keyLast4: '',
  keyCreatedAt: 0,
  updatedAt: 0,
};

export const DEFAULT_ACTIVITY: OnlineMcpActivity = { lastRequestAt: 0, lastAuthorizeAt: 0 };

export async function readAuthState(): Promise<OnlineMcpAuthState> {
  const raw = await redis.get(AUTH_KEY);
  if (!raw) return DEFAULT_AUTH_STATE;
  try {
    return { ...DEFAULT_AUTH_STATE, ...(JSON.parse(raw) as Partial<OnlineMcpAuthState>) };
  } catch {
    return DEFAULT_AUTH_STATE;
  }
}

async function writeAuthState(state: OnlineMcpAuthState): Promise<OnlineMcpAuthState> {
  const next = { ...state, updatedAt: Date.now() };
  await redis.set(AUTH_KEY, JSON.stringify(next));
  return next;
}

// MCP is only usable once an admin has generated a key and left it enabled.
export function isAuthUsable(state: OnlineMcpAuthState): boolean {
  return state.enabled === true && state.credentialVersion > 0 && Boolean(state.keyHash);
}

// Every issued token carries the version it was minted under; a mismatch means
// the key was rotated, MCP was disabled, or sessions were revoked.
export function isCredentialVersionCurrent(state: OnlineMcpAuthState, version: unknown): boolean {
  return Number.isInteger(version) && version === state.credentialVersion;
}

export async function createOnlineKey(): Promise<{ state: OnlineMcpAuthState; key: string } | null> {
  const state = await readAuthState();
  if (state.keyHash) return null;
  return issueKey();
}

export async function rotateOnlineKey(): Promise<{ state: OnlineMcpAuthState; key: string }> {
  return issueKey();
}

async function issueKey(): Promise<{ state: OnlineMcpAuthState; key: string }> {
  const state = await readAuthState();
  const key = generateOnlineKey();
  const next = await writeAuthState({
    ...state,
    keyHash: hashOnlineKey(key),
    keyLast4: keyLast4(key),
    keyCreatedAt: Date.now(),
    credentialVersion: state.credentialVersion + 1,
  });
  return { state: next, key };
}

export async function setMcpEnabled(enabled: boolean): Promise<OnlineMcpAuthState> {
  const state = await readAuthState();
  if (enabled && !state.keyHash) throw new Error('Generate an MCP key before enabling MCP.');
  if (enabled === state.enabled) return state;
  return writeAuthState({
    ...state,
    enabled,
    // Disabling revokes every issued token; enabling does not need to.
    credentialVersion: enabled ? state.credentialVersion : state.credentialVersion + 1,
  });
}

export async function revokeAllOnlineSessions(): Promise<OnlineMcpAuthState> {
  const state = await readAuthState();
  return writeAuthState({ ...state, credentialVersion: state.credentialVersion + 1 });
}

export async function readOnlineMcpActivity(): Promise<OnlineMcpActivity> {
  const raw = await redis.get(ACTIVITY_KEY);
  if (!raw) return DEFAULT_ACTIVITY;
  try {
    return { ...DEFAULT_ACTIVITY, ...(JSON.parse(raw) as Partial<OnlineMcpActivity>) };
  } catch {
    return DEFAULT_ACTIVITY;
  }
}

// Per-instance throttle: last-activity timestamps are advisory UI data, so a
// best-effort write avoids a Redis round trip on every MCP request.
const activityWrittenAt = new Map<keyof OnlineMcpActivity, number>();

export async function recordOnlineMcpActivity(field: keyof OnlineMcpActivity): Promise<void> {
  const now = Date.now();
  if (now - (activityWrittenAt.get(field) || 0) < ACTIVITY_WRITE_INTERVAL_MS) return;
  activityWrittenAt.set(field, now);
  try {
    const activity = await readOnlineMcpActivity();
    await redis.set(ACTIVITY_KEY, JSON.stringify({ ...activity, [field]: now }));
  } catch (error) {
    activityWrittenAt.delete(field);
    console.warn('Failed to record online MCP activity:', error);
  }
}

export function publicOnlineMcpView(state: OnlineMcpAuthState, activity: OnlineMcpActivity) {
  return {
    enabled: state.enabled,
    hasKey: Boolean(state.keyHash),
    keyLast4: state.keyLast4,
    keyCreatedAt: state.keyCreatedAt,
    credentialVersion: state.credentialVersion,
    updatedAt: state.updatedAt,
    lastRequestAt: activity.lastRequestAt,
    lastAuthorizeAt: activity.lastAuthorizeAt,
  };
}
