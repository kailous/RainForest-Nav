import { NextApiRequest, NextApiResponse } from 'next';
import { put } from '@vercel/blob';
import { getAuth } from './_auth';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '2mb',
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const authError = await getAuth(req);
  if (authError) return res.status(401).json({ error: authError });

  try {
    const { filename, content } = req.body;

    if (!filename || !content) {
      return res.status(400).json({ error: 'Missing filename or content' });
    }

    if (!filename.toLowerCase().endsWith('.svg')) {
      return res.status(400).json({ error: 'Only SVG files are allowed' });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`icons/${Date.now()}-${safeName}`, content, {
      access: 'public',
      contentType: 'image/svg+xml',
    });

    res.status(200).json({ url: blob.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to upload icon' });
  }
}
