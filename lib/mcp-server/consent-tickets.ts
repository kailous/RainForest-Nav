import { randomToken } from '../mcp/crypto.mjs';
import { redis } from './redis';

// Temporary OAuth state for the consent step: a pending authorization request
// plus the CSRF binding for the browser that started it.
const FORM_PREFIX = 'rfn_form_';
const FORM_TTL_SECONDS = 10 * 60;
const MAX_FORM_ATTEMPTS = 3;

export const CONSENT_TICKET_TTL_SECONDS = FORM_TTL_SECONDS;

export interface ConsentTicket {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  csrfHash: string;
}

const ticketKey = (ticket: string) => `online:mcp:form:${ticket}`;

export async function createConsentTicket(ticket: ConsentTicket): Promise<string> {
  for (let attempt = 0; attempt < MAX_FORM_ATTEMPTS; attempt += 1) {
    const value = randomToken(FORM_PREFIX);
    if (await redis.setIfAbsent(ticketKey(value), JSON.stringify(ticket), FORM_TTL_SECONDS)) return value;
  }
  throw new Error('unable to allocate a consent ticket');
}

export async function readConsentTicket(ticket: string): Promise<ConsentTicket | null> {
  if (!String(ticket || '').startsWith(FORM_PREFIX)) return null;
  const raw = await redis.get(ticketKey(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConsentTicket;
  } catch {
    return null;
  }
}

// The ticket is kept until authorization succeeds so a mistyped key can be
// retried; its TTL bounds how long the pending request stays usable.
export async function deleteConsentTicket(ticket: string): Promise<void> {
  await redis.del(ticketKey(ticket));
}

export function isConsentTicketShape(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(FORM_PREFIX);
}
