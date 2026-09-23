import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizationServerMetadata } from '../../../lib/mcp/resource.mjs';
import { originUnavailable, resolveSiteOrigin, setMetadataHeaders } from '../../../lib/mcp-server/http';

// RFC 8414 authorization server metadata for the online deployment. The online
// site is its own authorization server and never delegates to the plugin
// Worker, so `issuer` is the site origin.
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

  return res.status(200).json(authorizationServerMetadata(siteOrigin));
}
