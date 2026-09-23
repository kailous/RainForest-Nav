// Tool catalogue for the online MCP server.
//
// Every tool declares exactly one scope, and the endpoint's HTTP-level scope
// preflight reads that declaration, so authorization decisions never depend on
// the tool implementations.
import { READ_SCOPE, WRITE_SCOPE } from './protocol.mjs';

function tool(name, description, properties, required = [], scope = READ_SCOPE, annotations = {}) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint: annotations.readOnly ?? scope === READ_SCOPE,
      destructiveHint: annotations.destructive ?? false,
      idempotentHint: annotations.idempotent ?? scope === READ_SCOPE,
      openWorldHint: annotations.openWorld ?? false,
    },
    securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] },
  };
}

export const ONLINE_TOOLS = [
  tool('online_list_navigation_entries', 'List online RainForest navigation entries, optionally filtered by category.', {
    category: { type: 'string', description: 'Exact category name.' },
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  }),

  tool('online_search_navigation_entries', 'Search online navigation entries by name, URL, description, or category.', {
    query: { type: 'string', minLength: 1 },
    category: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  }, ['query']),

  tool('online_get_navigation_entry', 'Get one online navigation entry by UUID.', {
    uuid: { type: 'string', minLength: 1 },
  }, ['uuid']),

  tool('online_list_navigation_categories', 'List online categories and the number of entries in each.', {}),

  tool('online_get_icon_generation_guide', 'Read the complete RainForest website-icon generation skill before creating or applying an icon.', {}),

  tool('fetch_public_resource_text', 'Fetch the bounded raw text of a public HTTP(S) resource, including image/svg+xml, XML, manifests, JSON, and HTML. Private hosts and unsafe redirects are blocked.', {
    url: { type: 'string', minLength: 1 },
    maxBytes: { type: 'integer', minimum: 1, maximum: 1000000, default: 500000 },
  }, ['url'], READ_SCOPE, { openWorld: true }),

  tool('inspect_website_icon_assets', 'Inspect a public website HTML document for inline SVG logos, linked SVG/favicon assets, manifests, and likely brand images.', {
    url: { type: 'string', minLength: 1 },
  }, ['url'], READ_SCOPE, { openWorld: true }),

  tool('online_add_navigation_entry', 'Add an entry without generating a custom icon. Use only when the user explicitly asks to skip icon generation; otherwise use online_add_navigation_entry_with_icon.', {
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    categories: { type: 'array', items: { type: 'string' } },
    iconUrl: { type: 'string' },
    skipIconGeneration: { type: 'boolean', const: true, description: 'Explicit confirmation that this entry should be added without a generated RainForest icon.' },
  }, ['name', 'url', 'skipIconGeneration'], WRITE_SCOPE, { readOnly: false, idempotent: false }),

  tool('online_add_navigation_entry_with_icon', 'Atomically add an online navigation entry with a skill-compliant generated SVG icon. This is the default tool for new websites.', {
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    categories: { type: 'array', items: { type: 'string' } },
    svg: { type: 'string', minLength: 100 },
    filename: { type: 'string' },
    brand: { type: 'string', minLength: 1 },
    domain: { type: 'string' },
    sourceUrl: { type: 'string' },
    sourceRoute: { type: 'string', enum: ['official-vector', 'bitmap-vectorized'] },
    skillDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  }, ['name', 'url', 'svg', 'brand', 'sourceRoute', 'skillDigest'], WRITE_SCOPE, { readOnly: false, idempotent: false }),

  tool('online_update_navigation_entry', 'Update fields on an existing online navigation entry.', {
    uuid: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    categories: { type: 'array', items: { type: 'string' } },
    iconUrl: { type: 'string' },
  }, ['uuid'], WRITE_SCOPE, { readOnly: false, idempotent: true }),

  tool('online_delete_navigation_entry', 'Delete an online navigation entry by UUID.', {
    uuid: { type: 'string', minLength: 1 },
  }, ['uuid'], WRITE_SCOPE, { readOnly: false, destructive: true, idempotent: true }),

  tool('online_set_navigation_icon', 'Upload SVG source as an entry icon and attach it to the entry.', {
    uuid: { type: 'string', minLength: 1 },
    svg: { type: 'string', minLength: 20, description: 'Complete SVG source.' },
    filename: { type: 'string', description: 'Optional .svg filename.' },
  }, ['uuid', 'svg'], WRITE_SCOPE, { readOnly: false, idempotent: false }),

  tool('online_clear_navigation_icon', 'Detach the custom icon from an entry.', {
    uuid: { type: 'string', minLength: 1 },
  }, ['uuid'], WRITE_SCOPE, { readOnly: false, idempotent: true }),

  tool('online_generate_navigation_icon', 'Apply an AI-generated, skill-compliant 64×64 RainForest SVG to an existing online navigation entry. Read online_get_icon_generation_guide first, use official brand assets, and provide the complete final SVG.', {
    uuid: { type: 'string', minLength: 1 },
    svg: { type: 'string', minLength: 100 },
    filename: { type: 'string' },
    brand: { type: 'string', minLength: 1 },
    domain: { type: 'string' },
    sourceUrl: { type: 'string' },
    sourceRoute: { type: 'string', enum: ['official-vector', 'bitmap-vectorized'] },
    skillDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  }, ['uuid', 'svg', 'brand', 'sourceRoute', 'skillDigest'], WRITE_SCOPE, { readOnly: false, idempotent: true }),
];

const scopeByToolName = new Map(ONLINE_TOOLS.map(entry => [entry.name, entry.securitySchemes[0].scopes[0]]));

export function scopeForTool(name) {
  return scopeByToolName.get(name) || null;
}

export const WRITE_TOOL_NAMES = new Set(ONLINE_TOOLS.filter(entry => scopeForTool(entry.name) === WRITE_SCOPE).map(entry => entry.name));

// Lightweight scope preflight. Unknown methods/tools are treated as read-only so
// a genuine write can never be smuggled past the HTTP layer; the JSON-RPC layer
// still rejects unknown names.
export function requiredScopesForRequest(method, params) {
  if (method === 'tools/call') {
    return [scopeForTool(params?.name) || READ_SCOPE];
  }
  return [READ_SCOPE];
}
