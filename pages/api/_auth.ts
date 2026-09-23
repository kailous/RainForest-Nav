import { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { list } from '@vercel/blob';

const PASSWORD_BLOB_PREFIX = 'admin-password';

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Single credential source for the admin console: the Blob-stored password wins,
// so a rotated password takes effect everywhere. Never used for MCP authentication.
export async function getCurrentPassword(): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: PASSWORD_BLOB_PREFIX });
    if (blobs.length > 0) {
      const newest = blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
      const res = await fetch(newest.url);
      const data = await res.json();
      if (data?.password) return String(data.password);
    }
  } catch {}
  return process.env.ADMIN_PASSWORD || null;
}

export async function getAuth(req: NextApiRequest): Promise<string | null> {
  const expected = await getCurrentPassword();
  if (!expected) return 'Admin password not configured';

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !safeEqual(token, expected)) return 'Unauthorized';

  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const password = req.body?.password;
  const currentPwd = await getCurrentPassword();
  if (!currentPwd) return res.status(500).json({ error: 'Password not configured' });

  if (typeof password === 'string' && safeEqual(password, currentPwd)) {
    return res.status(200).json({ token: currentPwd });
  }
  return res.status(401).json({ error: 'Wrong password' });
}
