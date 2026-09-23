import { randomToken } from '../mcp/crypto.mjs';
import { redis } from './redis';

// Authorization codes are opaque, single-use tokens held in Redis. The token
// endpoint consumes them with GETDEL, so a replayed code can never succeed.
const CODE_PREFIX = 'rfn_ac_';
const CODE_TTL_SECONDS = 60;
const ISSUE_ATTEMPTS = 3;

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
  resource: string;
  credentialVersion: number;
  iat: number;
}

const codeKey = (code: string) => `online:mcp:code:${code}`;

export async function issueAuthorizationCode(record: AuthorizationCodeRecord): Promise<string> {
  for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt += 1) {
    const code = randomToken(CODE_PREFIX);
    // SET NX EX guarantees one record per code even under concurrent issuance.
    if (await redis.setIfAbsent(codeKey(code), JSON.stringify(record), CODE_TTL_SECONDS)) return code;
  }
  throw new Error('unable to allocate an authorization code');
}

export async function consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | null> {
  if (!String(code || '').startsWith(CODE_PREFIX)) return null;

  const raw = await redis.getDel(codeKey(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthorizationCodeRecord;
  } catch {
    return null;
  }
}

export const AUTHORIZATION_CODE_TTL_SECONDS = CODE_TTL_SECONDS;
