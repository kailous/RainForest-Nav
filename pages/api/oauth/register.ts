import type { NextApiRequest, NextApiResponse } from 'next';
import { registerDynamicClient } from '../../../lib/mcp-server/oauth-clients';
import { isSigningConfigured } from '../../../lib/mcp-server/oauth-signing';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

// Dynamic Client Registration (RFC 7591), kept only as a compatibility fallback.
// CIMD is the primary mechanism and needs no endpoint. Issued client IDs are
// HMAC-signed and self-contained, so this route writes no server-side state.
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({
      error: 'invalid_request',
      error_description: 'Use POST for dynamic client registration.',
    });
  }

  if (!isSigningConfigured()) {
    return res.status(503).json({
      error: 'temporarily_unavailable',
      error_description: 'Client registration is unavailable. Configure MCP_OAUTH_SIGNING_KEY.',
    });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'The client metadata is not a JSON object.',
    });
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
    return res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'Only public PKCE clients are supported.',
    });
  }

  try {
    const client = await registerDynamicClient({
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
    });
    return res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  } catch (error) {
    return res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: error instanceof Error ? error.message : 'Invalid client metadata.',
    });
  }
}
