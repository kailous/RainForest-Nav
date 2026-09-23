import type { NextApiRequest, NextApiResponse } from 'next';
import { normalizeOrigin } from '../mcp/resource.mjs';

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  const hostname = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

// The canonical origin that identifies this deployment as an OAuth issuer.
//
// Every value derived from it — iss, authorization_endpoint, token_endpoint,
// registration_endpoint, protected resource authorization_servers, and the
// resource ID itself — must come from this single function so the deployment
// cannot present two different identities.
//
// Production never trusts the Host header: ONLINE_SITE_ORIGIN is required and a
// missing value fails closed. Preview and development may derive the origin from
// platform-provided deployment info, or from a loopback Host for local work.
export function resolveSiteOrigin(req: NextApiRequest): string | null {
  const configured = process.env.ONLINE_SITE_ORIGIN;
  if (configured) return normalizeOrigin(configured);

  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === 'production' || (!vercelEnv && process.env.NODE_ENV === 'production')) {
    return null;
  }

  const deploymentUrl = process.env.VERCEL_URL;
  if (deploymentUrl) return normalizeOrigin(`https://${deploymentUrl}`);

  const host = headerValue(req.headers['x-forwarded-host']) || headerValue(req.headers.host);
  if (!host || !isLoopbackHost(host)) return null;
  return normalizeOrigin(`http://${host}`);
}

export function setMetadataHeaders(res: NextApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version');
  res.setHeader('Cache-Control', 'no-store');
}

export function setOAuthHeaders(res: NextApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

export function originUnavailable(res: NextApiResponse): void {
  setMetadataHeaders(res);
  res.status(503).json({
    error: 'temporarily_unavailable',
    error_description: 'ONLINE_SITE_ORIGIN must be configured in production.',
  });
}
