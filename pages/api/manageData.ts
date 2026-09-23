import { NextApiRequest, NextApiResponse } from 'next';
import { list, put } from '@vercel/blob';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getAuth } from './_auth';

const BLOB_PREFIX = 'nav-data';

// 生成 UUID
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function getData(): Promise<{ entries: any[] }> {
  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX });
    if (blobs.length > 0) {
      console.log('getData: found blobs:', blobs.map(b => b.url).join(', '));
      const newest = blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
      console.log('getData: using newest:', newest.url);
      const res = await fetch(newest.url);
      const data = await res.json();

      // 确保所有条目都有 UUID
      let updated = false;
      data.entries = data.entries.map((entry: any) => {
        if (!entry.uuid) {
          entry.uuid = generateUUID();
          updated = true;
        }
        return entry;
      });

      // 如果有更新，保存回去
      if (updated) {
        console.log('Added UUIDs to entries, saving...');
        await saveData(data);
      }

      return data;
    }
    console.log('getData: no blobs found, using local file');
  } catch (e) {
    console.warn('Failed to read from Vercel Blob, falling back to local file:', e);
  }
  const localPath = join(process.cwd(), 'data', 'data.json');
  return JSON.parse(readFileSync(localPath, 'utf-8'));
}

async function saveData(data: { entries: any[] }): Promise<string> {
  const blob = await put(`${BLOB_PREFIX}.json`, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
  });
  console.log('Data saved, URL:', blob.url);
  return blob.url;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const authError = await getAuth(req);
  if (authError) return res.status(401).json({ error: authError });

  try {
    const data = await getData();

    if (req.method === 'POST') {
      const { name, url, description, categories, iconUrl } = req.body;
      if (!name || !url) {
        return res.status(400).json({ error: 'Name and URL are required' });
      }
      const newEntry = {
        uuid: generateUUID(),
        name,
        url,
        description: description || '',
        categories: categories || [],
        iconUrl: iconUrl || '',
      };
      console.log('Adding entry:', newEntry);
      data.entries.push(newEntry);
      console.log('Total entries:', data.entries.length);
      const savedUrl = await saveData(data);
      console.log('Saved to:', savedUrl);
      return res.status(200).json(newEntry);
    }

    if (req.method === 'PUT') {
      const { uuid, ...updates } = req.body;
      const index = data.entries.findIndex((e: any) => e.uuid === uuid);
      if (index === -1) return res.status(404).json({ error: 'Entry not found' });
      data.entries[index] = { ...data.entries[index], ...updates };
      await saveData(data);
      return res.status(200).json(data.entries[index]);
    }

    if (req.method === 'DELETE') {
      const { uuid } = req.body;
      data.entries = data.entries.filter((e: any) => e.uuid !== uuid);
      await saveData(data);
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'POST, PUT, DELETE');
    res.status(405).json({ message: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Operation failed' });
  }
}
