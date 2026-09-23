import { randomUUID } from 'crypto';
import { list, put } from '@vercel/blob';
import { readFileSync } from 'fs';
import { join } from 'path';

export const NAV_DATA_BLOB = 'nav-data.json';
const NAV_DATA_PREFIX = 'nav-data';

export interface NavigationEntry {
  uuid: string;
  name: string;
  url: string;
  description: string;
  categories: string[];
  iconUrl: string;
  [key: string]: unknown;
}

export interface NavigationData {
  entries: NavigationEntry[];
}

export function createNavigationUuid(): string {
  return randomUUID();
}

function normalizeEntry(entry: any): NavigationEntry {
  const normalized = {
    ...entry,
    uuid: entry.uuid || createNavigationUuid(),
    name: String(entry.name || ''),
    url: String(entry.url || ''),
    description: String(entry.description || ''),
    categories: Array.isArray(entry.categories)
      ? entry.categories.filter((value: unknown) => typeof value === 'string' && value.trim())
      : entry.category
        ? [String(entry.category)]
        : [],
    iconUrl: String(entry.iconUrl || ''),
  };
  delete normalized.id;
  return normalized;
}

export async function saveNavigationData(data: NavigationData): Promise<string> {
  const normalized = { entries: (data.entries || []).map(normalizeEntry) };
  const blob = await put(NAV_DATA_BLOB, JSON.stringify(normalized), {
    access: 'public',
    contentType: 'application/json',
  });
  return blob.url;
}

export async function getNavigationData(options: { persistMigration?: boolean } = {}): Promise<NavigationData> {
  let source: any = null;

  try {
    const { blobs } = await list({ prefix: NAV_DATA_PREFIX });
    if (blobs.length > 0) {
      const newest = blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
      const response = await fetch(newest.url);
      if (!response.ok) throw new Error(`Blob returned HTTP ${response.status}`);
      source = await response.json();
    }
  } catch (error) {
    console.warn('Failed to read from Vercel Blob, falling back to local file:', error);
  }

  if (!source) {
    const localPath = join(process.cwd(), 'data', 'data.json');
    source = JSON.parse(readFileSync(localPath, 'utf-8'));
  }

  const originalEntries = Array.isArray(source.entries) ? source.entries : [];
  const entries = originalEntries.map(normalizeEntry);
  const migrated = originalEntries.some((entry: any) =>
    !entry.uuid || Object.prototype.hasOwnProperty.call(entry, 'id')
  );

  const data = { entries };
  if (options.persistMigration && migrated && process.env.BLOB_READ_WRITE_TOKEN) {
    await saveNavigationData(data);
  }
  return data;
}

export function normalizeNavigationUrl(value: unknown): string {
  const raw = String(value || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('URL must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use http or https');
  }
  return parsed.toString();
}

export function normalizeCategories(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('categories must be an array of strings');
  return Array.from(new Set(value.map(item => String(item).trim()).filter(Boolean)));
}
