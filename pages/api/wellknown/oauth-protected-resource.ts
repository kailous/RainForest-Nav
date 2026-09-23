import type { NextApiRequest, NextApiResponse } from 'next';
import { protectedResourceMetadata } from '../../../lib/mcp/resource.mjs';
import { originUnavailable, resolveSiteOrigin, setMetadataHeaders } from '../../../lib/mcp-server/http';

// RFC 9728 protected resource metadata for the online MCP endpoint, served at
// /.well-known/oauth-protected-resource (with and without the resource path
// appended, as the MCP specification allows both forms).
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  setMetadataHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const siteOrigin = resolveSiteOrigin(req);
  if (!siteOrigin) return originUnavailable(res);

  return res.status(200).json(protectedResourceMetadata(siteOrigin));
}
