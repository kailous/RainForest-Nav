import { DurableObject } from 'cloudflare:workers';
import ICON_SKILL_MARKDOWN from '../../Skill/rainforest-icon-generator/SKILL.md';
import {
  ALLOWED_SCOPES,
  PROTOCOL_VERSION,
  READ_SCOPE,
  SUPPORTED_PROTOCOL_VERSIONS,
  WRITE_SCOPE,
  rpcError,
  textResult,
} from '../../lib/mcp/protocol.mjs';
import { validateSvg, validateRainforestIconSvg } from '../../lib/mcp/icon-validation.mjs';
import { fetchPublicResourceText, inspectWebsiteIconAssets } from '../../lib/mcp/web-assets.mjs';
import { consentPage, authorizationErrorPage } from './auth-pages.js';

const SERVICE_ORIGIN = 'https://mcp.nav.rainforest.org.cn';
// Resource and origin are separate concepts: the resource ID is the audience a
// token is bound to, and must be the MCP endpoint URL rather than the bare host.
// The legacy origin form is still accepted so connections created before this
// change keep working; remove LEGACY_RESOURCE_ID once they have re-authorized.
const RESOURCE_ID = `${SERVICE_ORIGIN}/mcp`;
const LEGACY_RESOURCE_ID = SERVICE_ORIGIN;
const ACCEPTED_RESOURCE_IDS = new Set([RESOURCE_ID, LEGACY_RESOURCE_ID]);
const BRIDGE_PROTOCOL = 'rainforest-bridge-v1';
const TOKEN_PROTOCOL_PREFIX = 'token.';
const DIRECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_ACCESS_TOKEN_PATTERN = /^rfo_[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 2_000_000;
const MAX_OAUTH_BODY_BYTES = 64_000;
const COMMAND_TIMEOUT_MS = 30_000;
const FORM_TICKET_TTL_MS = 10 * 60_000;
const AUTH_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const CLIENT_TTL_MS = 365 * 24 * 60 * 60_000;
const ICON_SKILL_URI = 'rainforest://skills/icon-generator';
const ICON_SKILL_CATALOG_URI = 'skill://rainforest-navigator/rainforest-icon-generator/SKILL.md';
const ICON_SKILL_NAME = 'rainforest-icon-generator';
const ICON_SKILL_DESCRIPTION = 'Generate standardized 64×64 SVG website icons for RainForest Navigator from a website name or URL, then safely apply them to browser-extension navigation entries.';
const ICON_PROMPT_NAME = 'rainforest_generate_navigation_icon';
const ICON_GENERATION_GUIDE = ICON_SKILL_MARKDOWN;
const SERVER_INSTRUCTIONS = 'Operate only on the paired RainForest browser extension; never use the online navigation database. For every generated icon, first call extension_get_icon_generation_guide and pass its current skillDigest to the write tool. Discover official assets with inspect_website_icon_assets, fetch_public_resource_text, and extension_extract_rendered_page_assets as needed. When adding a site, default to extension_add_navigation_entry_with_icon; use the bare add tool only when the user explicitly requests no generated icon. Read the entry after writes to verify the result. Never modify data without a clear user request.';

const tools = [
  tool('extension_list_navigation_entries', 'List entries stored in the connected RainForest browser extension.', {
    category: { type: 'string' },
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  }, [], READ_SCOPE, true),
  tool('extension_search_navigation_entries', 'Search entries stored in the connected RainForest browser extension.', {
    query: { type: 'string', minLength: 1 },
    category: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  }, ['query'], READ_SCOPE, true),
  tool('extension_get_navigation_entry', 'Get one browser-extension entry by UUID.', {
    uuid: { type: 'string', minLength: 1 },
  }, ['uuid'], READ_SCOPE, true),
  tool('extension_list_navigation_categories', 'List categories in the connected browser extension.', {}, [], READ_SCOPE, true),
  tool('extension_add_navigation_entry', 'Add an entry without generating a custom icon. Use only when the user explicitly asks to skip icon generation; otherwise use extension_add_navigation_entry_with_icon.', {
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    categories: { type: 'array', items: { type: 'string' } },
    iconUrl: { type: 'string' },
    skipIconGeneration: { type: 'boolean', const: true, description: 'Explicit confirmation that this entry should be added without a generated RainForest icon.' },
  }, ['name', 'url', 'skipIconGeneration'], WRITE_SCOPE),
  tool('extension_add_navigation_entry_with_icon', 'Atomically add a browser-extension navigation entry with a skill-compliant generated SVG icon. This is the default tool for new websites.', {
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
  }, ['name', 'url', 'svg', 'brand', 'sourceRoute', 'skillDigest'], WRITE_SCOPE),
  tool('extension_update_navigation_entry', 'Update an entry in the connected browser extension.', {
    uuid: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    categories: { type: 'array', items: { type: 'string' } },
    iconUrl: { type: 'string' },
  }, ['uuid'], WRITE_SCOPE),
  tool('extension_delete_navigation_entry', 'Delete an entry from the connected browser extension.', {
    uuid: { type: 'string', minLength: 1 },
  }, ['uuid'], WRITE_SCOPE, false, true),
  tool('extension_set_navigation_icon', 'Attach a complete SVG document to an entry in the connected browser extension.', {
    uuid: { type: 'string', minLength: 1 },
    svg: { type: 'string', minLength: 20 },
    filename: { type: 'string' },
  }, ['uuid', 'svg'], WRITE_SCOPE),
  tool('extension_clear_navigation_icon', 'Detach the custom icon from an entry in the connected browser extension.', {
    uuid: { type: 'string', minLength: 1 },
  }, ['uuid'], WRITE_SCOPE),
  tool('extension_get_icon_generation_guide', 'Read the complete RainForest website-icon generation skill before creating or applying an icon.', {}, [], READ_SCOPE, true),
  tool('fetch_public_resource_text', 'Fetch the bounded raw text of a public HTTP(S) resource, including image/svg+xml, XML, manifests, JSON, and HTML. Private hosts and unsafe redirects are blocked.', {
    url: { type: 'string', minLength: 1 },
    maxBytes: { type: 'integer', minimum: 1, maximum: 1000000, default: 500000 },
  }, ['url'], READ_SCOPE, true, false, true),
  tool('inspect_website_icon_assets', 'Inspect a public website HTML document for inline SVG logos, linked SVG/favicon assets, manifests, and likely brand images.', {
    url: { type: 'string', minLength: 1 },
  }, ['url'], READ_SCOPE, true, false, true),
  tool('extension_extract_rendered_page_assets', 'Open a public website in a background extension tab and extract logo candidates from the rendered DOM. Use when raw HTML misses client-rendered SVG.', {
    url: { type: 'string', minLength: 1 },
  }, ['url'], READ_SCOPE, true, false, true),
  tool('extension_generate_navigation_icon', 'Apply an AI-generated, skill-compliant 64×64 RainForest SVG to an existing navigation entry. Read extension_get_icon_generation_guide first, use official brand assets, and provide the complete final SVG.', {
    uuid: { type: 'string', minLength: 1 },
    svg: { type: 'string', minLength: 100 },
    filename: { type: 'string' },
    brand: { type: 'string', minLength: 1 },
    domain: { type: 'string' },
    sourceUrl: { type: 'string' },
    sourceRoute: { type: 'string', enum: ['official-vector', 'bitmap-vectorized'] },
    skillDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  }, ['uuid', 'svg', 'brand', 'sourceRoute', 'skillDigest'], WRITE_SCOPE),
  tool('extension_connection_status', 'Check whether the RainForest browser extension is connected.', {}, [], READ_SCOPE, true),
];

const toolByName = new Map(tools.map(item => [item.name, item]));

function tool(name, description, properties, required = [], scope = READ_SCOPE, readOnly = false, destructive = false, openWorld = false) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: openWorld },
    securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] },
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Cache-Control': 'no-store',
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, { status, headers: { ...corsHeaders(), ...extraHeaders } });
}

function oauthJson(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function oauthError(error, description, status = 400) {
  return oauthJson({ error, error_description: description }, status);
}

function authenticationChallenge(scope = `${READ_SCOPE} ${WRITE_SCOPE}`) {
  return `Bearer resource_metadata="${SERVICE_ORIGIN}/.well-known/oauth-protected-resource", scope="${scope}"`;
}

function scopeError(scope) {
  return textResult(`Authorization scope required: ${scope}`, true, {
    'mcp/www_authenticate': [`${authenticationChallenge(scope)}, error="insufficient_scope", error_description="Grant ${scope} to continue"`],
  });
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{40,128})$/i.exec(header.trim());
  return match?.[1] || null;
}

function websocketToken(request) {
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map(value => value.trim());
  if (!protocols.includes(BRIDGE_PROTOCOL)) return null;
  const authProtocol = protocols.find(value => value.startsWith(TOKEN_PROTOCOL_PREFIX));
  const token = authProtocol?.slice(TOKEN_PROTOCOL_PREFIX.length) || '';
  return DIRECT_TOKEN_PATTERN.test(token) ? token : null;
}

function randomToken(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${prefix}${encoded}`;
}

async function hashBytes(value) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

async function hashValue(value) {
  const digest = await hashBytes(value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function currentIconSkillDigest() {
  return `sha256:${await hashValue(ICON_SKILL_MARKDOWN)}`;
}

async function requireCurrentIconSkill(args) {
  const expected = await currentIconSkillDigest();
  if (args?.skillDigest !== expected) {
    throw new Error('Icon skill version is missing or stale. Call extension_get_icon_generation_guide and pass its skillDigest unchanged.');
  }
  return expected;
}

async function iconSkillEntry() {
  return {
    uri: ICON_SKILL_CATALOG_URI,
    frontmatter: {
      name: ICON_SKILL_NAME,
      description: ICON_SKILL_DESCRIPTION,
    },
    resources: [{
      uri: ICON_SKILL_CATALOG_URI,
      digest: await currentIconSkillDigest(),
    }],
  };
}

async function constantTimeEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([hashBytes(left), hashBytes(right)]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function bridgeForKey(env, bridgeKey) {
  return env.EXTENSION_BRIDGE.getByName(bridgeKey);
}

async function bridgeForToken(env, token) {
  return bridgeForKey(env, await hashValue(token));
}

async function oauthRecord(env, kind, token) {
  const key = await hashValue(token);
  return env.OAUTH_RECORD.getByName(`${kind}:${key}`);
}

async function writeOAuthRecord(env, kind, token, payload, expiresAt) {
  const record = await oauthRecord(env, kind, token);
  await record.write(kind, payload, expiresAt);
}

async function readOAuthRecord(env, kind, token) {
  const record = await oauthRecord(env, kind, token);
  return record.read(kind);
}

async function consumeOAuthRecord(env, kind, token) {
  const record = await oauthRecord(env, kind, token);
  return record.consume(kind);
}

function parseScopes(value) {
  const requested = String(value || '').split(/\s+/).filter(Boolean);
  const scopes = requested.length ? requested : [READ_SCOPE, WRITE_SCOPE];
  if (scopes.some(scope => !ALLOWED_SCOPES.has(scope))) return null;
  return [...new Set(scopes)];
}

function redirectUriAllowed(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['chatgpt.com', 'platform.openai.com'].includes(url.hostname)) return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  return (request.headers.get('Cookie') || '')
    .split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

function htmlResponse(body, status = 200, setCookie = undefined) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self' https://chatgpt.com https://platform.openai.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (setCookie) headers.set('Set-Cookie', setCookie);
  return new Response(body, { status, headers });
}

function errorPage(title, message, status = 400) {
  return htmlResponse(authorizationErrorPage(title, message), status);
}

async function boundedText(request, limit) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit) throw new Error('request_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw new Error('request_too_large');
  return text;
}

async function handleClientRegistration(request, env) {
  if (request.method !== 'POST') return oauthError('invalid_request', 'Use POST for dynamic client registration.', 405);
  let input;
  try {
    input = JSON.parse(await boundedText(request, MAX_OAUTH_BODY_BYTES));
  } catch {
    return oauthError('invalid_client_metadata', 'The client metadata is not valid JSON.');
  }

  const redirectUris = Array.isArray(input.redirect_uris) ? [...new Set(input.redirect_uris)] : [];
  if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some(uri => typeof uri !== 'string' || !redirectUriAllowed(uri))) {
    return oauthError('invalid_redirect_uri', 'Only ChatGPT, OpenAI Platform, or localhost callback URLs are allowed.');
  }
  if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') {
    return oauthError('invalid_client_metadata', 'Only public PKCE clients are supported.');
  }

  const clientId = randomToken('rfc_');
  const client = {
    clientId,
    clientName: String(input.client_name || 'ChatGPT').slice(0, 120),
    redirectUris,
    createdAt: Date.now(),
  };
  await writeOAuthRecord(env, 'client', clientId, client, Date.now() + CLIENT_TTL_MS);
  console.info(JSON.stringify({
    event: 'oauth_client_registered',
    clientId: clientId.slice(0, 12),
    redirectOrigins: redirectUris.map(uri => new URL(uri).origin),
  }));
  return oauthJson({
    client_id: clientId,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
}

async function validateAuthorizationRequest(url, env) {
  if (url.searchParams.get('response_type') !== 'code') throw new Error('Only response_type=code is supported.');
  const clientId = url.searchParams.get('client_id') || '';
  const client = await readOAuthRecord(env, 'client', clientId);
  if (!client) throw new Error('The OAuth client is unknown or expired.');
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  if (!client.redirectUris.includes(redirectUri)) throw new Error('The redirect_uri does not match the registered client.');
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  if (url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new Error('PKCE with code_challenge_method=S256 is required.');
  }
  const resource = url.searchParams.get('resource') || RESOURCE_ID;
  if (!ACCEPTED_RESOURCE_IDS.has(resource)) throw new Error('The requested OAuth resource is not supported.');
  const scopes = parseScopes(url.searchParams.get('scope'));
  if (!scopes) throw new Error('One or more requested scopes are not supported.');
  return {
    client,
    requestInfo: {
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      scopes,
      state: url.searchParams.get('state') || '',
    },
  };
}

async function handleAuthorize(request, env) {
  if (request.method === 'GET') {
    let validated;
    try {
      validated = await validateAuthorizationRequest(new URL(request.url), env);
    } catch (error) {
      return errorPage('无法开始授权', error instanceof Error ? error.message : 'OAuth 请求无效。');
    }
    const ticket = randomToken('rft_');
    const csrfToken = randomToken();
    await writeOAuthRecord(env, 'form', ticket, {
      ...validated.requestInfo,
      csrfHash: await hashValue(csrfToken),
    }, Date.now() + FORM_TICKET_TTL_MS);
    const cookie = `__Host-RainForestOAuthCSRF=${csrfToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
    return htmlResponse(consentPage(ticket, csrfToken, validated.requestInfo, validated.client), 200, cookie);
  }

  if (request.method !== 'POST') return errorPage('请求方式错误', '授权页面仅接受 GET 或 POST。', 405);
  let form;
  try {
    form = new URLSearchParams(await boundedText(request, MAX_OAUTH_BODY_BYTES));
  } catch {
    return errorPage('授权请求过大', '请重新开始连接。', 413);
  }

  const ticket = form.get('ticket') || '';
  const requestInfo = await readOAuthRecord(env, 'form', ticket);
  if (!requestInfo) return errorPage('授权会话已过期', '请返回 ChatGPT 重新发起连接。', 400);

  const csrfToken = form.get('csrf_token') || '';
  const csrfCookie = cookieValue(request, '__Host-RainForestOAuthCSRF');
  const submittedCsrfHash = csrfToken ? await hashValue(csrfToken) : '';
  const ticketMatches = Boolean(
    csrfToken
    && requestInfo.csrfHash
    && await constantTimeEqual(submittedCsrfHash, requestInfo.csrfHash),
  );
  const cookieMatches = !csrfCookie || await constantTimeEqual(csrfToken, csrfCookie);
  if (!ticketMatches || !cookieMatches) {
    return errorPage('授权会话失效', '安全校验未通过，请返回 ChatGPT 重新连接。', 403);
  }
  const client = await readOAuthRecord(env, 'client', requestInfo.clientId);
  if (!client || !client.redirectUris.includes(requestInfo.redirectUri)) {
    return errorPage('客户端无效', 'ChatGPT 连接信息已失效，请重新创建连接。', 400);
  }

  const extensionToken = form.get('extension_token') || '';
  if (!DIRECT_TOKEN_PATTERN.test(extensionToken)) {
    return htmlResponse(consentPage(ticket, csrfToken, requestInfo, client, '访问密钥格式不正确，请从插件 MCP接入 页面重新复制。'));
  }
  const bridgeKey = await hashValue(extensionToken);
  const bridge = await bridgeForKey(env, bridgeKey);
  const status = await bridge.status();
  if (!status.connected) {
    console.warn(JSON.stringify({ event: 'oauth_authorization_waiting_for_extension', clientId: requestInfo.clientId.slice(0, 12) }));
    return htmlResponse(consentPage(ticket, csrfToken, requestInfo, client, '没有找到已连接的插件。请在 Chrome 中开启插件 MCP 后重试。'));
  }

  const code = randomToken('rac_');
  await writeOAuthRecord(env, 'code', code, { ...requestInfo, bridgeKey }, Date.now() + AUTH_CODE_TTL_MS);
  const consumed = await consumeOAuthRecord(env, 'form', ticket);
  if (!consumed) return errorPage('授权已被使用', '请返回 ChatGPT 重新发起连接。', 400);
  console.info(JSON.stringify({
    event: 'oauth_authorization_code_issued',
    clientId: requestInfo.clientId.slice(0, 12),
    scopes: requestInfo.scopes,
  }));
  const redirect = new URL(requestInfo.redirectUri);
  redirect.searchParams.set('code', code);
  if (requestInfo.state) redirect.searchParams.set('state', requestInfo.state);
  redirect.searchParams.set('iss', SERVICE_ORIGIN);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': '__Host-RainForestOAuthCSRF=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0',
    },
  });
}

async function pkceChallenge(verifier) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return null;
  const digest = new Uint8Array(await hashBytes(verifier));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function issueTokenPair(env, grant) {
  const accessToken = randomToken('rfo_');
  const refreshToken = randomToken('rfr_');
  const now = Date.now();
  const payload = {
    bridgeKey: grant.bridgeKey,
    clientId: grant.clientId,
    scopes: grant.scopes,
    resource: grant.resource,
  };
  await Promise.all([
    writeOAuthRecord(env, 'access', accessToken, payload, now + ACCESS_TOKEN_TTL_MS),
    writeOAuthRecord(env, 'refresh', refreshToken, payload, now + REFRESH_TOKEN_TTL_MS),
  ]);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: grant.scopes.join(' '),
  };
}

async function handleToken(request, env) {
  if (request.method !== 'POST') return oauthError('invalid_request', 'Use POST for the token endpoint.', 405);
  let form;
  try {
    form = new URLSearchParams(await boundedText(request, MAX_OAUTH_BODY_BYTES));
  } catch {
    return oauthError('invalid_request', 'The token request is invalid or too large.');
  }
  const grantType = form.get('grant_type');
  const clientId = form.get('client_id') || '';
  const client = await readOAuthRecord(env, 'client', clientId);
  if (!client) return oauthError('invalid_client', 'The OAuth client is unknown or expired.', 401);

  if (grantType === 'authorization_code') {
    const code = form.get('code') || '';
    const grant = await readOAuthRecord(env, 'code', code);
    if (!grant) return oauthError('invalid_grant', 'The authorization code is invalid or expired.');
    if (grant.clientId !== clientId || grant.redirectUri !== (form.get('redirect_uri') || '')) {
      return oauthError('invalid_grant', 'The authorization code does not belong to this client.');
    }
    const challenge = await pkceChallenge(form.get('code_verifier') || '');
    if (!challenge || !(await constantTimeEqual(challenge, grant.codeChallenge))) {
      return oauthError('invalid_grant', 'PKCE verification failed.');
    }
    const resource = form.get('resource') || grant.resource;
    if (resource !== grant.resource) return oauthError('invalid_target', 'The requested resource does not match the authorization grant.');
    const consumed = await consumeOAuthRecord(env, 'code', code);
    if (!consumed) return oauthError('invalid_grant', 'The authorization code was already used.');
    console.info(JSON.stringify({ event: 'oauth_token_issued', grantType, clientId: clientId.slice(0, 12), scopes: grant.scopes }));
    return oauthJson(await issueTokenPair(env, consumed));
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token') || '';
    const grant = await readOAuthRecord(env, 'refresh', refreshToken);
    if (!grant) return oauthError('invalid_grant', 'The refresh token is invalid or expired.');
    if (grant.clientId !== clientId) return oauthError('invalid_grant', 'The refresh token does not belong to this client.');
    const resource = form.get('resource') || grant.resource;
    if (resource !== grant.resource) return oauthError('invalid_target', 'The requested resource does not match the refresh grant.');

    // A refresh grant is only meaningful while the paired extension is online.
    // Checking before consuming means a temporarily closed browser does not burn
    // the token, while rotating the plugin key leaves the old grant pointing at a
    // bridge with no socket — so a rotated key can never be refreshed around.
    const bridge = await bridgeForKey(env, grant.bridgeKey);
    const bridgeStatus = await bridge.status();
    if (!bridgeStatus.connected) {
      console.warn(JSON.stringify({ event: 'oauth_refresh_rejected_extension_offline' }));
      return oauthError('invalid_grant', 'The paired RainForest browser extension is not connected.');
    }

    const consumed = await consumeOAuthRecord(env, 'refresh', refreshToken);
    if (!consumed) return oauthError('invalid_grant', 'The refresh token was already used.');
    console.info(JSON.stringify({ event: 'oauth_token_issued', grantType, clientId: clientId.slice(0, 12), scopes: grant.scopes }));
    return oauthJson(await issueTokenPair(env, consumed));
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

async function resolveAuthorization(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  if (OAUTH_ACCESS_TOKEN_PATTERN.test(token)) {
    const grant = await readOAuthRecord(env, 'access', token);
    if (!grant || !ACCEPTED_RESOURCE_IDS.has(grant.resource)) return null;
    const bridge = await bridgeForKey(env, grant.bridgeKey);
    await bridge.recordClientActivity();
    return { bridge, scopes: grant.scopes, kind: 'oauth' };
  }
  if (DIRECT_TOKEN_PATTERN.test(token)) {
    return { bridge: await bridgeForToken(env, token), scopes: [READ_SCOPE, WRITE_SCOPE], kind: 'direct' };
  }
  return null;
}

async function handleRpc(request, authorization) {
  const id = request?.id ?? null;
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  if (request.method.startsWith('notifications/')) return null;

  try {
    let result;
    if (request.method === 'initialize') {
      const requested = request.params?.protocolVersion;
      result = {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          extensions: {
            'io.modelcontextprotocol/skills': {},
          },
        },
        serverInfo: { name: 'rainforest-navigator-extension', version: '2.5.0' },
        instructions: SERVER_INSTRUCTIONS,
      };
    } else if (request.method === 'ping') {
      result = {};
    } else if (request.method === 'tools/list') {
      result = { tools };
    } else if (request.method === 'tools/call') {
      const name = request.params?.name;
      const definition = toolByName.get(name);
      if (!definition) throw new Error(`Unknown extension tool: ${name}`);
      const requiredScope = definition.securitySchemes[0].scopes[0];
      if (!authorization.scopes.includes(requiredScope)) {
        result = scopeError(requiredScope);
      } else {
        try {
          let value;
          const args = request.params?.arguments || {};
          if (name === 'extension_get_icon_generation_guide') {
            value = {
              name: 'rainforest-icon-generator',
              resourceUri: ICON_SKILL_URI,
              skillDigest: await currentIconSkillDigest(),
              instructions: ICON_GENERATION_GUIDE,
            };
          } else if (name === 'fetch_public_resource_text') {
            value = await fetchPublicResourceText(args.url, { maxBytes: args.maxBytes });
          } else if (name === 'inspect_website_icon_assets') {
            value = await inspectWebsiteIconAssets(args.url);
          } else if (name === 'extension_connection_status') {
            value = await authorization.bridge.status();
          } else {
            if (name === 'extension_add_navigation_entry' && args.skipIconGeneration !== true) {
              throw new Error('Use extension_add_navigation_entry_with_icon by default, or explicitly set skipIconGeneration to true.');
            }
            if (['extension_generate_navigation_icon', 'extension_add_navigation_entry_with_icon'].includes(name)) {
              await requireCurrentIconSkill(args);
              validateRainforestIconSvg(args.svg);
            }
            if (name === 'extension_set_navigation_icon') validateSvg(args.svg);
            const forwarded = await authorization.bridge.dispatch(name, args);
            if (!forwarded.ok) throw new Error(forwarded.error || 'Extension tool call failed');
            value = forwarded.result;
          }
          result = textResult(value);
        } catch (error) {
          result = textResult(error instanceof Error ? error.message : 'Tool call failed', true);
        }
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
            uri: 'rainforest://extension/navigation',
            name: 'RainForest browser-extension navigation',
            mimeType: 'application/json',
          },
          {
            uri: ICON_SKILL_URI,
            name: 'RainForest website icon generation skill',
            description: 'The canonical workflow and visual constraints for generating RainForest navigation icons.',
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
      if (!authorization.scopes.includes(READ_SCOPE)) return { jsonrpc: '2.0', id, result: scopeError(READ_SCOPE) };
      if (request.params?.uri === ICON_SKILL_URI) {
        result = {
          contents: [{ uri: ICON_SKILL_URI, mimeType: 'text/markdown', text: ICON_GENERATION_GUIDE }],
        };
      } else if (request.params?.uri === ICON_SKILL_CATALOG_URI) {
        result = {
          contents: [{ uri: ICON_SKILL_CATALOG_URI, mimeType: 'text/markdown', text: ICON_SKILL_MARKDOWN }],
        };
      } else if (request.params?.uri === 'rainforest://extension/navigation') {
        const forwarded = await authorization.bridge.dispatch('extension_list_navigation_entries', { offset: 0, limit: 200 });
        if (!forwarded.ok) throw new Error(forwarded.error || 'Extension resource is unavailable');
        result = {
          contents: [{
            uri: 'rainforest://extension/navigation',
            mimeType: 'application/json',
            text: JSON.stringify(forwarded.result, null, 2),
          }],
        };
      } else {
        throw new Error('Resource not found');
      }
    } else if (request.method === 'prompts/list') {
      result = {
        prompts: [{
          name: ICON_PROMPT_NAME,
          title: 'Generate a RainForest navigation icon',
          description: 'Generate a standards-compliant website icon and optionally apply it to an existing browser-extension entry.',
          arguments: [
            { name: 'target', description: 'Website URL, domain, or brand name.', required: true },
            { name: 'uuid', description: 'Optional RainForest navigation entry UUID to update.', required: false },
          ],
        }],
      };
    } else if (request.method === 'prompts/get') {
      if (request.params?.name !== ICON_PROMPT_NAME) throw new Error('Prompt not found');
      const target = String(request.params?.arguments?.target || '').trim();
      if (!target) throw new Error('The target argument is required');
      const uuid = String(request.params?.arguments?.uuid || '').trim();
      const skillDigest = await currentIconSkillDigest();
      result = {
        description: `Generate a RainForest navigation icon for ${target}`,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `${ICON_GENERATION_GUIDE}\n\nCurrent skill digest: ${skillDigest}\nTarget: ${target}${uuid ? `\nNavigation entry UUID: ${uuid}\nAfter generating the SVG, call extension_generate_navigation_icon with this skillDigest and then extension_get_navigation_entry to verify the iconUrl changed.` : '\nIf adding this site, use extension_add_navigation_entry_with_icon with this skillDigest. Otherwise return the complete SVG without modifying navigation.'}`,
          },
        }],
      };
    } else {
      return rpcError(id, -32601, 'Method not found');
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    return rpcError(id, -32602, error instanceof Error ? error.message : 'Invalid params');
  }
}

export class OAuthRecord extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_record (
          kind TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
    });
  }

  async write(kind, payload, expiresAt) {
    this.ctx.storage.sql.exec(
      'INSERT INTO oauth_record (kind, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at',
      kind,
      JSON.stringify(payload),
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
  }

  readValue(kind) {
    const row = this.ctx.storage.sql.exec('SELECT payload, expires_at FROM oauth_record WHERE kind = ?', kind).toArray()[0];
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      this.ctx.storage.sql.exec('DELETE FROM oauth_record WHERE kind = ?', kind);
      return null;
    }
    return JSON.parse(String(row.payload));
  }

  async read(kind) {
    return this.readValue(kind);
  }

  async consume(kind) {
    const value = this.readValue(kind);
    if (value) this.ctx.storage.sql.exec('DELETE FROM oauth_record WHERE kind = ?', kind);
    return value;
  }

  async alarm() {
    this.ctx.storage.sql.exec('DELETE FROM oauth_record WHERE expires_at <= ?', Date.now());
  }
}

export class ExtensionBridge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const url = new URL(request.url);
    const attachment = {
      deviceId: (url.searchParams.get('device') || 'unknown').slice(0, 128),
      extensionVersion: (url.searchParams.get('version') || 'unknown').slice(0, 32),
      connectedAt: Date.now(),
    };

    this.ctx.acceptWebSocket(server, ['extension']);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: 'ready', connectedAt: attachment.connectedAt }));

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': BRIDGE_PROTOCOL },
    });
  }

  async status() {
    const devices = this.ctx.getWebSockets('extension')
      .filter(socket => socket.readyState === WebSocket.OPEN)
      .map(socket => socket.deserializeAttachment() || {});
    return {
      connected: devices.length > 0,
      devices,
      lastClientActivityAt: Number(await this.ctx.storage.get('lastClientActivityAt') || 0),
    };
  }

  async recordClientActivity() {
    const now = Date.now();
    const previous = Number(await this.ctx.storage.get('lastClientActivityAt') || 0);
    if (now - previous > 15_000) await this.ctx.storage.put('lastClientActivityAt', now);
    return { recorded: true, at: now };
  }

  async dispatch(operation, args) {
    const socket = this.ctx.getWebSockets('extension').find(item => item.readyState === WebSocket.OPEN);
    if (!socket) return { ok: false, error: '浏览器插件未连接。请打开 Chrome，并在插件的 MCP接入 页面开启远程访问。' };

    const id = crypto.randomUUID();
    const command = {
      type: 'command',
      id,
      operation,
      arguments: args || {},
      expiresAt: Date.now() + COMMAND_TIMEOUT_MS,
    };

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: '插件响应超时，请确认浏览器仍在运行并重试。' });
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        socket.send(JSON.stringify(command));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: error instanceof Error ? error.message : 'Failed to send extension command' });
      }
    });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string') return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON message' }));
      return;
    }

    if (payload.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      return;
    }
    if (payload.type !== 'result' || typeof payload.id !== 'string') return;

    const pending = this.pending.get(payload.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(payload.id);
    if (payload.error) pending.resolve({ ok: false, error: String(payload.error) });
    else pending.resolve({ ok: true, result: payload.result });
  }

  async webSocketError(_socket, error) {
    console.error(JSON.stringify({ level: 'error', event: 'extension_websocket_error', error: String(error) }));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/assets/')) return env.ASSETS.fetch(request);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ service: 'rainforest-extension-mcp', status: 'ok', version: '2.5.0', oauth: true, skills: true });
      }
      if (url.pathname === '/.well-known/openai-apps-challenge') {
        if (request.method !== 'GET') {
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
        }
        const challengeToken = String(env.OPENAI_APPS_CHALLENGE_TOKEN || '').trim();
        if (!challengeToken) return new Response('Not configured', { status: 404 });
        return new Response(challengeToken, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      }
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        return oauthJson({
          resource: RESOURCE_ID,
          authorization_servers: [SERVICE_ORIGIN],
          scopes_supported: [READ_SCOPE, WRITE_SCOPE],
          resource_name: 'RainForest Navigator browser extension',
          resource_documentation: 'https://nav.rainforest.org.cn',
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return oauthJson({
          issuer: SERVICE_ORIGIN,
          authorization_endpoint: `${SERVICE_ORIGIN}/oauth/authorize`,
          token_endpoint: `${SERVICE_ORIGIN}/oauth/token`,
          registration_endpoint: `${SERVICE_ORIGIN}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: [READ_SCOPE, WRITE_SCOPE],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === '/oauth/register') return handleClientRegistration(request, env);
      if (url.pathname === '/oauth/authorize') return handleAuthorize(request, env);
      if (url.pathname === '/oauth/token') return handleToken(request, env);

      if (url.pathname === '/bridge') {
        if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return json({ error: 'WebSocket upgrade required' }, 426);
        }
        const token = websocketToken(request);
        if (!token) return json({ error: 'Missing or invalid WebSocket credentials' }, 401);
        const bridge = await bridgeForToken(env, token);
        const headers = new Headers(request.headers);
        headers.set('Sec-WebSocket-Protocol', BRIDGE_PROTOCOL);
        headers.delete('Authorization');
        return bridge.fetch(new Request(request, { headers }));
      }

      if (url.pathname !== '/mcp' && url.pathname !== '/status') return json({ error: 'Not found' }, 404);
      const authorization = await resolveAuthorization(request, env);
      if (!authorization) {
        return json({ error: 'OAuth authorization or a valid plugin access key is required' }, 401, {
          'WWW-Authenticate': authenticationChallenge(),
        });
      }

      if (url.pathname === '/status') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, OPTIONS' });
        return json(await authorization.bridge.status());
      }

      if (request.method !== 'POST') return json({ error: 'MCP endpoint accepts POST requests' }, 405, { Allow: 'POST, OPTIONS' });
      let body;
      try {
        body = JSON.parse(await boundedText(request, MAX_BODY_BYTES));
      } catch (error) {
        if (error instanceof Error && error.message === 'request_too_large') return json({ error: 'Request body is too large' }, 413);
        return json(rpcError(null, -32700, 'Parse error'), 400);
      }
      const requests = Array.isArray(body) ? body : [body];
      const responses = (await Promise.all(requests.map(item => handleRpc(item, authorization)))).filter(Boolean);
      if (!responses.length) return new Response(null, { status: 202, headers: corsHeaders() });
      return json(Array.isArray(body) ? responses : responses[0]);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'request_failed',
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: 'Internal server error' }, 500);
    }
  },
};
