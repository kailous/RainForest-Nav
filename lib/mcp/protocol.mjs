// Runtime-independent MCP primitives shared by the browser-extension relay
// (Cloudflare Worker) and the online MCP endpoint (Next.js on Vercel).
// Web APIs only: no fs, no Buffer, no node:crypto, no chrome.*.
// Modules that need those do not belong here.

export const PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', PROTOCOL_VERSION]);

export const READ_SCOPE = 'navigation:read';
export const WRITE_SCOPE = 'navigation:write';
export const NAVIGATION_SCOPES = [READ_SCOPE, WRITE_SCOPE];
export const ALLOWED_SCOPES = new Set(NAVIGATION_SCOPES);

export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
}

export function textResult(value, isError = false, meta = undefined) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(value && typeof value === 'object' ? { structuredContent: value } : {}),
    ...(meta ? { _meta: meta } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

export function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
