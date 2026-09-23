import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { validateRainforestIconSvg } from '../../lib/mcp/icon-validation.mjs';
import { fetchPublicResourceText, inspectWebsiteIconAssets, validatePublicHttpUrl } from '../../lib/mcp/web-assets.mjs';

const baseUrl = process.env.RAINFOREST_MCP_TEST_URL || 'http://127.0.0.1:8788';
const resource = 'https://mcp.nav.rainforest.org.cn';
const extensionToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const directHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${extensionToken}` };
const socketUrl = `${baseUrl.replace(/^http/, 'ws')}/bridge?device=integration-test&version=0.0.0`;

assert.equal(
  readFileSync(new URL('../src/frontend-theme.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../../extension/newtab/css/root.css', import.meta.url), 'utf8'),
  'MCP authorization theme variables must stay in sync with the extension frontend',
);

assert.throws(
  () => validateRainforestIconSvg('<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="58" height="58" rx="20" fill="#E8EAED"/><image href="data:image/png;base64,AA=="/></svg>'),
  /may not embed bitmap images/,
);

assert.throws(() => validatePublicHttpUrl('http://127.0.0.1/logo.svg'), /private or reserved/);
assert.throws(() => validatePublicHttpUrl('http://localhost/logo.svg'), /public host/);

const fetchedSvg = await fetchPublicResourceText('https://assets.example.com/logo.svg', {
  fetchImpl: async () => new Response('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>', {
    headers: { 'Content-Type': 'image/svg+xml' },
  }),
});
assert.equal(fetchedSvg.contentType, 'image/svg+xml');
assert.match(fetchedSvg.body, /<path/);

const inspectedAssets = await inspectWebsiteIconAssets('https://example.com/', {
  fetchImpl: async url => {
    if (url.endsWith('/site.webmanifest')) {
      return new Response(JSON.stringify({ icons: [{ src: '/app-icon.svg', type: 'image/svg+xml', sizes: 'any' }] }), {
        headers: { 'Content-Type': 'application/manifest+json' },
      });
    }
    return new Response('<html><head><title>Example</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="manifest" href="/site.webmanifest"></head><body><header><a class="logo"><svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg></a></header></body></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  },
});
assert.equal(inspectedAssets.title, 'Example');
assert.ok(inspectedAssets.candidates.some(candidate => candidate.url === 'https://example.com/favicon.svg'));
assert.ok(inspectedAssets.candidates.some(candidate => candidate.url === 'https://example.com/app-icon.svg'));
assert.match(inspectedAssets.inlineSvgs[0].svg, /<svg/);

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function hiddenValue(html, name) {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  assert.ok(match, `Missing hidden input: ${name}`);
  return match[1];
}

const unauthenticated = await fetch(`${baseUrl}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
});
assert.equal(unauthenticated.status, 401);
assert.match(unauthenticated.headers.get('www-authenticate') || '', /oauth-protected-resource/);

const socket = new WebSocket(socketUrl, ['rainforest-bridge-v1', `token.${extensionToken}`]);

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 5000);
  socket.addEventListener('open', () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
  socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
});

let lastBridgeOperation = null;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.type !== 'command') return;
  lastBridgeOperation = message.operation;
  socket.send(JSON.stringify({
    type: 'result',
    id: message.id,
    result: { total: 1, entries: [{ uuid: 'test-entry', name: 'Test', url: 'https://example.com/' }] },
  }));
});

const directStatusResponse = await fetch(`${baseUrl}/status`, { headers: directHeaders });
assert.equal(directStatusResponse.status, 200);
const directStatus = await directStatusResponse.json();
assert.equal(directStatus.connected, true);
assert.equal(directStatus.devices[0].deviceId, 'integration-test');

const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
assert.equal(metadataResponse.status, 200);
const metadata = await metadataResponse.json();
assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
assert.ok(metadata.registration_endpoint.endsWith('/oauth/register'));

const redirectUri = 'https://chatgpt.com/connector/oauth/integration-test';
const registerResponse = await fetch(`${baseUrl}/oauth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_name: 'RainForest OAuth integration test',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
});
assert.equal(registerResponse.status, 201);
const client = await registerResponse.json();
assert.match(client.client_id, /^rfc_/);

const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', client.client_id);
authorizeUrl.searchParams.set('redirect_uri', redirectUri);
authorizeUrl.searchParams.set('code_challenge', challenge);
authorizeUrl.searchParams.set('code_challenge_method', 'S256');
authorizeUrl.searchParams.set('resource', resource);
authorizeUrl.searchParams.set('scope', 'navigation:read navigation:write');
authorizeUrl.searchParams.set('state', 'integration-state');

const authorizeResponse = await fetch(authorizeUrl, { redirect: 'manual' });
assert.equal(authorizeResponse.status, 200);
const authorizationCsp = authorizeResponse.headers.get('content-security-policy') || '';
assert.match(authorizationCsp, /form-action 'self' https:\/\/chatgpt\.com https:\/\/platform\.openai\.com/);
const consentHtml = await authorizeResponse.text();
assert.match(consentHtml, /连接你的导航/);
assert.match(consentHtml, /pattern="\[A-Za-z0-9_\\-\]\{43\}"/);
const ticket = hiddenValue(consentHtml, 'ticket');
const csrfToken = hiddenValue(consentHtml, 'csrf_token');
const cookie = (authorizeResponse.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^__Host-RainForestOAuthCSRF=/);

const consentResponse = await fetch(`${baseUrl}/oauth/authorize`, {
  method: 'POST',
  redirect: 'manual',
  // ChatGPT's OAuth window may not return the authorization cookie. The
  // one-time form ticket must remain sufficient while still binding the CSRF
  // value to server-side state.
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    ticket,
    csrf_token: csrfToken,
    extension_token: extensionToken,
  }),
});
assert.equal(consentResponse.status, 302);
const callback = new URL(consentResponse.headers.get('location'));
assert.equal(callback.origin + callback.pathname, redirectUri);
assert.equal(callback.searchParams.get('state'), 'integration-state');
assert.equal(callback.searchParams.get('iss'), resource);
const code = callback.searchParams.get('code');
assert.ok(code);

const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  }),
});
assert.equal(tokenResponse.status, 200);
const oauth = await tokenResponse.json();
assert.match(oauth.access_token, /^rfo_/);
assert.match(oauth.refresh_token, /^rfr_/);
assert.equal(oauth.token_type, 'Bearer');

const oauthHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${oauth.access_token}` };
async function mcpRpc(id, method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: oauthHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const initialized = await mcpRpc(0, 'initialize', { protocolVersion: '2025-06-18' });
assert.ok(initialized.result.capabilities.extensions['io.modelcontextprotocol/skills']);
assert.match(initialized.result.instructions, /first call extension_get_icon_generation_guide/);

const listedSkills = await mcpRpc(0.1, 'skills/list');
assert.equal(listedSkills.result.skills.length, 1);
const iconSkillEntry = listedSkills.result.skills[0];
assert.equal(iconSkillEntry.frontmatter.name, 'rainforest-icon-generator');
assert.match(iconSkillEntry.uri, /^skill:\/\/rainforest-navigator\/rainforest-icon-generator\/SKILL\.md$/);

const fetchedSkill = await mcpRpc(0.2, 'skills/get', { uri: iconSkillEntry.uri });
assert.deepEqual(fetchedSkill.result.skill, iconSkillEntry);

const portableSkillResource = await mcpRpc(0.3, 'resources/read', { uri: iconSkillEntry.uri });
const portableSkillText = portableSkillResource.result.contents[0].text;
assert.equal(portableSkillText, readFileSync(new URL('../../Skill/rainforest-icon-generator/SKILL.md', import.meta.url), 'utf8'));
assert.match(portableSkillText, /^---\nname: rainforest-icon-generator/m);
assert.equal(iconSkillEntry.resources[0].digest, `sha256:${createHash('sha256').update(portableSkillText).digest('hex')}`);

const productStatusResponse = await fetch(`${baseUrl}/status`, { headers: directHeaders });
const productStatus = await productStatusResponse.json();
assert.ok(productStatus.lastClientActivityAt > 0);

const listedTools = await mcpRpc(1, 'tools/list');
assert.ok(listedTools.result.tools.some(tool => tool.name === 'extension_get_icon_generation_guide'));
assert.ok(listedTools.result.tools.some(tool => tool.name === 'extension_generate_navigation_icon'));
assert.ok(listedTools.result.tools.some(tool => tool.name === 'fetch_public_resource_text'));
assert.ok(listedTools.result.tools.some(tool => tool.name === 'inspect_website_icon_assets'));
assert.ok(listedTools.result.tools.some(tool => tool.name === 'extension_extract_rendered_page_assets'));
assert.ok(listedTools.result.tools.some(tool => tool.name === 'extension_add_navigation_entry_with_icon'));

const guideTool = await mcpRpc(2, 'tools/call', {
  name: 'extension_get_icon_generation_guide',
  arguments: {},
});
assert.match(guideTool.result.structuredContent.instructions, /<svg width="64" height="64" viewBox="0 0 64 64" fill="none"/);
assert.match(guideTool.result.structuredContent.instructions, /Do not embed PNG/);
assert.match(guideTool.result.structuredContent.skillDigest, /^sha256:[a-f0-9]{64}$/);

const listedResources = await mcpRpc(3, 'resources/list');
assert.ok(listedResources.result.resources.some(resourceItem => resourceItem.uri === 'rainforest://skills/icon-generator'));
const skillResource = await mcpRpc(4, 'resources/read', { uri: 'rainforest://skills/icon-generator' });
assert.match(skillResource.result.contents[0].text, /official site's rendered header\/navigation/);
assert.match(skillResource.result.contents[0].text, /paste the complete `<svg>/);
assert.match(skillResource.result.contents[0].text, /do not replace it with a PNG or approximate redraw/);

const listedPrompts = await mcpRpc(5, 'prompts/list');
assert.ok(listedPrompts.result.prompts.some(prompt => prompt.name === 'rainforest_generate_navigation_icon'));
const iconPrompt = await mcpRpc(6, 'prompts/get', {
  name: 'rainforest_generate_navigation_icon',
  arguments: { target: 'example.com', uuid: 'test-entry' },
});
assert.match(iconPrompt.result.messages[0].content.text, /extension_generate_navigation_icon/);

const toolResponse = await fetch(`${baseUrl}/mcp`, {
  method: 'POST',
  headers: oauthHeaders,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'extension_list_navigation_entries', arguments: {} },
  }),
});
assert.equal(toolResponse.status, 200);
const rpc = await toolResponse.json();
assert.equal(rpc.result.structuredContent.total, 1);
assert.equal(rpc.result.structuredContent.entries[0].uuid, 'test-entry');

lastBridgeOperation = null;
const rejectedWithoutSkill = await mcpRpc(7, 'tools/call', {
  name: 'extension_generate_navigation_icon',
  arguments: {
    uuid: 'test-entry',
    brand: 'Example',
    domain: 'example.com',
    sourceRoute: 'official-vector',
    svg: '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="58" height="58" rx="20" fill="#E8EAED"/><g id="brand-icon"><circle cx="32" cy="32" r="16" fill="#111827"/></g></svg>',
  },
});
assert.equal(rejectedWithoutSkill.result.isError, true);
assert.match(rejectedWithoutSkill.result.content[0].text, /skill version is missing or stale/i);
assert.equal(lastBridgeOperation, null);

const generatedIcon = await mcpRpc(8, 'tools/call', {
  name: 'extension_generate_navigation_icon',
  arguments: {
    uuid: 'test-entry',
    brand: 'Example',
    domain: 'example.com',
    sourceRoute: 'official-vector',
    skillDigest: guideTool.result.structuredContent.skillDigest,
    svg: '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="58" height="58" rx="20" fill="#E8EAED"/><g id="brand-icon"><circle cx="32" cy="32" r="16" fill="#111827"/></g></svg>',
  },
});
assert.equal(generatedIcon.result.structuredContent.entries[0].uuid, 'test-entry');
assert.equal(lastBridgeOperation, 'extension_generate_navigation_icon');

const addedWithIcon = await mcpRpc(9, 'tools/call', {
  name: 'extension_add_navigation_entry_with_icon',
  arguments: {
    name: 'Example',
    url: 'https://example.com/',
    brand: 'Example',
    domain: 'example.com',
    sourceUrl: 'https://example.com/favicon.svg',
    sourceRoute: 'official-vector',
    skillDigest: guideTool.result.structuredContent.skillDigest,
    svg: '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="58" height="58" rx="20" fill="#E8EAED"/><g id="brand-icon"><circle cx="32" cy="32" r="16" fill="#111827"/></g></svg>',
  },
});
assert.equal(addedWithIcon.result.structuredContent.entries[0].uuid, 'test-entry');
assert.equal(lastBridgeOperation, 'extension_add_navigation_entry_with_icon');

const refreshResponse = await fetch(`${baseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: oauth.refresh_token,
    resource,
  }),
});
assert.equal(refreshResponse.status, 200);
const refreshed = await refreshResponse.json();
assert.match(refreshed.access_token, /^rfo_/);
assert.notEqual(refreshed.refresh_token, oauth.refresh_token);

socket.close(1000, 'test-complete');
console.log('Remote MCP OAuth + WebSocket bridge integration passed.');
