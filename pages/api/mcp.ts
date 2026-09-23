import type { NextApiRequest, NextApiResponse } from 'next';
import { put } from '@vercel/blob';
import { validateRainforestIconSvg, validateSvg } from '../../lib/mcp/icon-validation.mjs';
import {
  ICON_PROMPT_NAME,
  ICON_SKILL_CATALOG_URI,
  ICON_SKILL_URI,
  iconPromptDefinition,
  iconPromptMessage,
  iconSkillDigest,
  iconSkillEntry,
  iconSkillMarkdown,
  requireCurrentIconSkill,
} from '../../lib/mcp/icon-skill.mjs';
import { ONLINE_TOOLS, requiredScopesForRequest } from '../../lib/mcp/online-tools.mjs';
import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  rpcError,
  textResult,
} from '../../lib/mcp/protocol.mjs';
import { onlineMcpResource } from '../../lib/mcp/resource.mjs';
import { fetchPublicResourceText, inspectWebsiteIconAssets } from '../../lib/mcp/web-assets.mjs';
import {
  createNavigationUuid,
  getNavigationData,
  normalizeCategories,
  normalizeNavigationUrl,
  saveNavigationData,
  type NavigationEntry,
} from '../../lib/navigation-store';
import { recordOnlineMcpActivity } from '../../lib/mcp-server/auth-state';
import { resolveSiteOrigin } from '../../lib/mcp-server/http';
import {
  authenticateMcpRequest,
  insufficientScopeChallenge,
  isMcpAuthFailure,
  missingScopes,
  type McpAuthContext,
} from '../../lib/mcp-server/mcp-auth';

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

const SERVER_INFO = { name: 'rainforest-navigator-online', version: '1.0.0' };
const ONLINE_NAVIGATION_URI = 'rainforest://online/navigation';
const ICON_SKILL_DESCRIPTION =
  'Generate standardized 64×64 SVG website icons for RainForest Navigator from a website name or URL, then safely apply them to online navigation entries.';

const SERVER_INSTRUCTIONS =
  'Operate only on the online RainForest navigation database. For every generated icon, first call online_get_icon_generation_guide and pass its current skillDigest to the write tool. Discover official assets with inspect_website_icon_assets and fetch_public_resource_text as needed. When adding a site, default to online_add_navigation_entry_with_icon; use the bare add tool only when the user explicitly requests no generated icon. Read the entry after writes to verify the result. Never modify data without a clear user request.';

function setCors(res: NextApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
}

function stringArg(args: any, key: string, required = false): string | undefined {
  const value = args?.[key];
  if (value == null || value === '') {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value.trim();
}

function findEntry(entries: NavigationEntry[], uuid: string): { entry: NavigationEntry; index: number } {
  const index = entries.findIndex(entry => entry.uuid === uuid);
  if (index < 0) throw new Error(`Navigation entry not found: ${uuid}`);
  return { entry: entries[index], index };
}

async function uploadIconBlob(svg: string, entryName: string, requestedName?: string): Promise<string> {
  const base = (requestedName || `${entryName || 'icon'}.svg`).replace(/\.svg$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = await put(`icons/${Date.now()}-${base}.svg`, svg, {
    access: 'public',
    contentType: 'image/svg+xml',
  });
  return blob.url;
}

async function callTool(name: string, args: any): Promise<any> {
  const data = await getNavigationData({ persistMigration: true });

  if (name === 'online_list_navigation_entries') {
    const category = stringArg(args, 'category');
    const offset = Math.max(0, Number.isInteger(args?.offset) ? args.offset : 0);
    const limit = Math.min(200, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 50));
    const filtered = category
      ? data.entries.filter(entry => entry.categories.includes(category))
      : data.entries;
    return { total: filtered.length, offset, limit, entries: filtered.slice(offset, offset + limit) };
  }

  if (name === 'online_search_navigation_entries') {
    const query = stringArg(args, 'query', true)!.toLocaleLowerCase();
    const category = stringArg(args, 'category');
    const limit = Math.min(100, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 20));
    const entries = data.entries
      .filter(entry => {
        if (category && !entry.categories.includes(category)) return false;
        const haystack = [entry.name, entry.url, entry.description, ...entry.categories]
          .join('\n')
          .toLocaleLowerCase();
        return haystack.includes(query);
      })
      .slice(0, limit);
    return { total: entries.length, entries };
  }

  if (name === 'online_get_navigation_entry') {
    return findEntry(data.entries, stringArg(args, 'uuid', true)!).entry;
  }

  if (name === 'online_list_navigation_categories') {
    const counts = new Map<string, number>();
    data.entries.forEach(entry =>
      entry.categories.forEach(category => counts.set(category, (counts.get(category) || 0) + 1)),
    );
    return {
      categories: Array.from(counts.entries())
        .map(([categoryName, count]) => ({ name: categoryName, count }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  if (name === 'online_get_icon_generation_guide') {
    return {
      name: 'rainforest-icon-generator',
      resourceUri: ICON_SKILL_URI,
      skillDigest: await iconSkillDigest(),
      instructions: iconSkillMarkdown(),
    };
  }

  if (name === 'fetch_public_resource_text') {
    return fetchPublicResourceText(args.url, { maxBytes: args.maxBytes });
  }

  if (name === 'inspect_website_icon_assets') {
    return inspectWebsiteIconAssets(args.url);
  }

  if (name === 'online_add_navigation_entry') {
    if (args.skipIconGeneration !== true) {
      throw new Error('Use online_add_navigation_entry_with_icon by default, or explicitly set skipIconGeneration to true.');
    }
    const entry: NavigationEntry = {
      uuid: createNavigationUuid(),
      name: stringArg(args, 'name', true)!,
      url: normalizeNavigationUrl(stringArg(args, 'url', true)),
      description: stringArg(args, 'description') || '',
      categories: normalizeCategories(args?.categories),
      iconUrl: stringArg(args, 'iconUrl') || '',
    };
    data.entries.push(entry);
    await saveNavigationData(data);
    return entry;
  }

  if (name === 'online_add_navigation_entry_with_icon') {
    await requireCurrentIconSkill(args?.skillDigest);
    const svg = validateRainforestIconSvg(stringArg(args, 'svg', true)!);
    const name_ = stringArg(args, 'name', true)!;
    const iconUrl = await uploadIconBlob(svg, name_, stringArg(args, 'filename'));
    const entry: NavigationEntry = {
      uuid: createNavigationUuid(),
      name: name_,
      url: normalizeNavigationUrl(stringArg(args, 'url', true)),
      description: stringArg(args, 'description') || '',
      categories: normalizeCategories(args?.categories),
      iconUrl,
    };
    data.entries.push(entry);
    await saveNavigationData(data);
    return { entry, iconUrl };
  }

  if (name === 'online_update_navigation_entry') {
    const uuid = stringArg(args, 'uuid', true)!;
    const { entry, index } = findEntry(data.entries, uuid);
    const updated = { ...entry };
    if (args.name !== undefined) updated.name = stringArg(args, 'name', true)!;
    if (args.url !== undefined) updated.url = normalizeNavigationUrl(stringArg(args, 'url', true));
    if (args.description !== undefined) updated.description = stringArg(args, 'description') || '';
    if (args.categories !== undefined) updated.categories = normalizeCategories(args.categories);
    if (args.iconUrl !== undefined) updated.iconUrl = stringArg(args, 'iconUrl') || '';
    data.entries[index] = updated;
    await saveNavigationData(data);
    return updated;
  }

  if (name === 'online_delete_navigation_entry') {
    const uuid = stringArg(args, 'uuid', true)!;
    const { entry, index } = findEntry(data.entries, uuid);
    data.entries.splice(index, 1);
    await saveNavigationData(data);
    return { deleted: entry };
  }

  if (name === 'online_set_navigation_icon') {
    const uuid = stringArg(args, 'uuid', true)!;
    const svg = validateSvg(stringArg(args, 'svg', true)!);
    const { entry, index } = findEntry(data.entries, uuid);
    const iconUrl = await uploadIconBlob(svg, entry.name, stringArg(args, 'filename'));
    const updated = { ...entry, iconUrl };
    data.entries[index] = updated;
    await saveNavigationData(data);
    return { entry: updated, iconUrl };
  }

  if (name === 'online_generate_navigation_icon') {
    const uuid = stringArg(args, 'uuid', true)!;
    await requireCurrentIconSkill(args?.skillDigest);
    const svg = validateRainforestIconSvg(stringArg(args, 'svg', true)!);
    const { entry, index } = findEntry(data.entries, uuid);
    const iconUrl = await uploadIconBlob(svg, entry.name, stringArg(args, 'filename'));
    const updated = { ...entry, iconUrl };
    data.entries[index] = updated;
    await saveNavigationData(data);
    return { entry: updated, iconUrl };
  }

  if (name === 'online_clear_navigation_icon') {
    const uuid = stringArg(args, 'uuid', true)!;
    const { entry, index } = findEntry(data.entries, uuid);
    const updated = { ...entry, iconUrl: '' };
    data.entries[index] = updated;
    await saveNavigationData(data);
    return updated;
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRpc(request: any, auth: McpAuthContext): Promise<any | null> {
  const id = request?.id;
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  if (request.method.startsWith('notifications/')) return null;

  try {
    let result: any;

    if (request.method === 'initialize') {
      const requested = request.params?.protocolVersion;
      result = {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          extensions: { 'io.modelcontextprotocol/skills': {} },
        },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      };
    } else if (request.method === 'ping') {
      result = {};
    } else if (request.method === 'tools/list') {
      result = { tools: ONLINE_TOOLS };
    } else if (request.method === 'tools/call') {
      const name = request.params?.name;
      if (typeof name !== 'string') throw new Error('Tool name is required');
      try {
        result = textResult(await callTool(name, request.params?.arguments || {}));
      } catch (error) {
        result = textResult(error instanceof Error ? error.message : 'Tool call failed', true);
      }
    } else if (request.method === 'skills/list') {
      result = { skills: [await iconSkillEntry()] };
    } else if (request.method === 'skills/get') {
      if (request.params?.uri !== ICON_SKILL_CATALOG_URI) throw new Error('Skill not found');
      result = { skill: await iconSkillEntry() };
    } else if (request.method === 'resources/list') {
      result = {
        resources: [
          {
            uri: ONLINE_NAVIGATION_URI,
            name: 'RainForest online navigation',
            mimeType: 'application/json',
          },
          {
            uri: ICON_SKILL_URI,
            name: 'RainForest website icon generation skill',
            description: ICON_SKILL_DESCRIPTION,
            mimeType: 'text/markdown',
          },
          {
            uri: ICON_SKILL_CATALOG_URI,
            name: 'RainForest Icon Generator SKILL.md',
            description: 'Portable RainForest icon-generation skill exposed through the MCP skills extension.',
            mimeType: 'text/markdown',
          },
        ],
      };
    } else if (request.method === 'resources/read') {
      if (request.params?.uri === ICON_SKILL_URI) {
        result = { contents: [{ uri: ICON_SKILL_URI, mimeType: 'text/markdown', text: iconSkillMarkdown() }] };
      } else if (request.params?.uri === ICON_SKILL_CATALOG_URI) {
        result = { contents: [{ uri: ICON_SKILL_CATALOG_URI, mimeType: 'text/markdown', text: iconSkillMarkdown() }] };
      } else if (request.params?.uri === ONLINE_NAVIGATION_URI) {
        const data = await getNavigationData({ persistMigration: true });
        result = {
          contents: [{ uri: ONLINE_NAVIGATION_URI, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
        };
      } else {
        throw new Error('Resource not found');
      }
    } else if (request.method === 'prompts/list') {
      result = { prompts: [iconPromptDefinition()] };
    } else if (request.method === 'prompts/get') {
      if (request.params?.name !== ICON_PROMPT_NAME) throw new Error('Prompt not found');
      const target = String(request.params?.arguments?.target || '').trim();
      if (!target) throw new Error('The target argument is required');
      const uuid = String(request.params?.arguments?.uuid || '').trim();
      result = iconPromptMessage({
        markdown: iconSkillMarkdown(),
        digest: await iconSkillDigest(),
        target,
        uuid,
      });
    } else {
      return rpcError(id, -32601, 'Method not found');
    }

    return { jsonrpc: '2.0', id: id ?? null, result };
  } catch (error) {
    return rpcError(id, -32602, error instanceof Error ? error.message : 'Invalid params');
  }
}

// The entire endpoint is a protected resource: every method, including
// initialize and the read-only discovery calls, requires a valid credential.
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ error: 'MCP endpoint accepts POST requests.' });
    return;
  }

  const siteOrigin = resolveSiteOrigin(req);
  if (!siteOrigin) {
    res.status(503).json({
      error: 'service_unavailable',
      error_description: 'ONLINE_SITE_ORIGIN must be configured in production.',
    });
    return;
  }
  const resourceId = onlineMcpResource(siteOrigin);

  const auth = await authenticateMcpRequest(req.headers.authorization, {
    issuer: siteOrigin,
    resource: resourceId,
  });
  if (isMcpAuthFailure(auth)) {
    if (auth.challenge) res.setHeader('WWW-Authenticate', auth.challenge);
    res.status(auth.status).json({ error: auth.code, error_description: auth.description });
    return;
  }

  const body = req.body;
  const requests = Array.isArray(body) ? body : [body];

  // Scope preflight across the whole batch, before anything is executed, so a
  // batch can never apply some operations and reject others.
  const required = new Set<string>();
  for (const item of requests) {
    if (!item || typeof item !== 'object') continue;
    const method = typeof (item as any).method === 'string' ? (item as any).method : '';
    if (!method || method.startsWith('notifications/')) continue;
    for (const scope of requiredScopesForRequest(method, (item as any).params)) required.add(scope);
  }

  const missing = missingScopes(auth.scopes, Array.from(required));
  if (missing.length) {
    res.setHeader('WWW-Authenticate', insufficientScopeChallenge(siteOrigin, missing));
    res.status(403).json({
      error: 'insufficient_scope',
      error_description: `This credential is missing the required scope: ${missing.join(', ')}`,
    });
    return;
  }

  // Reaching here means the request was authenticated and authorized, so this is
  // a genuine usage timestamp rather than attack traffic.
  await recordOnlineMcpActivity('lastRequestAt');

  const responses = (await Promise.all(requests.map(item => handleRpc(item, auth)))).filter(Boolean);
  if (responses.length === 0) {
    res.status(202).end();
    return;
  }
  res.status(200).json(Array.isArray(body) ? responses : responses[0]);
}
