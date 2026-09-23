import { NextApiRequest, NextApiResponse } from 'next';
import { getAuth } from '../_auth';
import { isRedisConfigured } from '../../../lib/mcp-server/redis';
import {
  createOnlineKey,
  publicOnlineMcpView,
  readAuthState,
  readOnlineMcpActivity,
  revokeAllOnlineSessions,
  rotateOnlineKey,
  setMcpEnabled,
} from '../../../lib/mcp-server/auth-state';

// Admin console API for the online MCP. Authenticated with the admin password
// only — the MCP key is never accepted here, and is never returned again after
// the response that creates it.
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const authError = await getAuth(req);
  if (authError) return res.status(401).json({ error: authError });

  if (!isRedisConfigured()) {
    return res
      .status(503)
      .json({ error: 'Redis is not configured, so online MCP auth state is unavailable.' });
  }

  if (req.method === 'GET') {
    const [state, activity] = await Promise.all([readAuthState(), readOnlineMcpActivity()]);
    return res.status(200).json(publicOnlineMcpView(state, activity));
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const action = req.body?.action;

  if (action === 'generate-key') {
    const created = await createOnlineKey();
    if (!created) return res.status(409).json({ error: 'A key already exists. Rotate it instead.' });
    const activity = await readOnlineMcpActivity();
    return res.status(200).json({ ...publicOnlineMcpView(created.state, activity), key: created.key });
  }

  if (action === 'rotate-key') {
    const rotated = await rotateOnlineKey();
    const activity = await readOnlineMcpActivity();
    return res.status(200).json({ ...publicOnlineMcpView(rotated.state, activity), key: rotated.key });
  }

  if (action === 'set-enabled') {
    try {
      const state = await setMcpEnabled(req.body?.enabled === true);
      const activity = await readOnlineMcpActivity();
      return res.status(200).json(publicOnlineMcpView(state, activity));
    } catch (error) {
      return res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'Unable to change MCP state' });
    }
  }

  if (action === 'revoke-all') {
    const state = await revokeAllOnlineSessions();
    const activity = await readOnlineMcpActivity();
    return res.status(200).json(publicOnlineMcpView(state, activity));
  }

  return res.status(400).json({ error: 'Unsupported action' });
}
