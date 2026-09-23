// End-to-end verification of the admin settings API, driving a real Next dev
// server against a wire-level fake Upstash instance.
//
// Fully self-contained: the child server is started with a known admin password
// and an empty Blob token, so admin auth resolves through process.env instead of
// touching the production Blob store.
//
// Scenario 1 (Redis configured): the full admin lifecycle, and the guarantee
//   that the plaintext key is returned exactly once.
// Scenario 2 (Redis missing): the endpoint fails closed with 503 instead of
//   silently falling back to a weaker store.
//
// Run: node --import ./test/ts-resolve-hook.mjs test/settings-api.e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFakeUpstash } from './fake-upstash.mjs';

const PORT = 3223;
const BASE = `http://127.0.0.1:${PORT}`;
const NEXT_BIN = 'node_modules/next/dist/bin/next';
const ADMIN_PASSWORD = 'e2e-admin-password';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_PASSWORD}` };

async function call(method, body) {
  const response = await fetch(`${BASE}/api/mcp/settings`, {
    method,
    headers: adminHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

let child = null;
let serverLog = '';

async function startServer(extraEnv) {
  serverLog = '';
  child = spawn(process.execPath, [NEXT_BIN, 'dev', '-p', String(PORT)], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      // An empty token keeps admin auth on the env password path and guarantees
      // this test never reads or writes the production Blob store.
      BLOB_READ_WRITE_TOKEN: '',
      ADMIN_PASSWORD,
      MCP_OAUTH_SIGNING_KEY: 'e2e-signing-key-that-is-long-enough-32',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => (serverLog += chunk));
  child.stderr.on('data', chunk => (serverLog += chunk));

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1500);
    try {
      await call('GET');
      return;
    } catch {}
  }
  throw new Error(`next dev did not become ready. Log tail:\n${serverLog.slice(-1500)}`);
}

async function stopServer() {
  if (!child) return;
  child.kill('SIGTERM');
  child = null;
  await sleep(2000);
}

function fail(label, response) {
  return `${label} failed with HTTP ${response.status}: ${JSON.stringify(response.body)}\n--- server log ---\n${serverLog.slice(-2000)}`;
}

const fake = await startFakeUpstash();

try {
  // --- Scenario 1: Redis configured.
  await startServer({ UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token });

  const initial = await call('GET');
  assert.equal(initial.status, 200, fail('GET', initial));
  assert.equal(initial.body.enabled, false);
  assert.equal(initial.body.hasKey, false);
  assert.equal(initial.body.credentialVersion, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(initial.body, 'keyHash'), false, 'must not leak keyHash');
  console.log('GET 初始:', JSON.stringify(initial.body));

  const generated = await call('POST', { action: 'generate-key' });
  assert.equal(generated.status, 200, fail('generate-key', generated));
  assert.match(generated.body.key, /^rfn_live_[A-Za-z0-9_-]{43}$/, 'must return the plaintext key once');
  assert.equal(generated.body.credentialVersion, 1);
  assert.equal(generated.body.enabled, false, 'generating a key must not enable MCP');
  console.log(`POST generate-key: 明文密钥长度 ${generated.body.key.length}, version=1`);

  const afterGenerate = await call('GET');
  assert.equal(afterGenerate.body.hasKey, true);
  assert.equal(afterGenerate.body.key, undefined, 'GET must never return the plaintext key');
  assert.equal(afterGenerate.body.keyLast4, generated.body.key.slice(-4));
  assert.equal(Object.prototype.hasOwnProperty.call(afterGenerate.body, 'keyHash'), false);
  console.log(`GET 再读: hasKey=true, keyLast4=${afterGenerate.body.keyLast4}, 无明文与哈希`);

  const duplicate = await call('POST', { action: 'generate-key' });
  assert.equal(duplicate.status, 409, fail('duplicate generate', duplicate));

  const enabled = await call('POST', { action: 'set-enabled', enabled: true });
  assert.equal(enabled.status, 200, fail('set-enabled', enabled));
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.credentialVersion, 1, 'enabling must not bump the version');
  console.log('POST set-enabled(true): enabled=true, version 仍为 1');

  const rotated = await call('POST', { action: 'rotate-key' });
  assert.equal(rotated.status, 200, fail('rotate-key', rotated));
  assert.notEqual(rotated.body.key, generated.body.key);
  assert.equal(rotated.body.credentialVersion, 2, 'rotation must bump the version');
  console.log('POST rotate-key: 新密钥, version=2（旧令牌立即失效）');

  const revoked = await call('POST', { action: 'revoke-all' });
  assert.equal(revoked.status, 200, fail('revoke-all', revoked));
  assert.equal(revoked.body.credentialVersion, 3);
  assert.equal(revoked.body.enabled, true, 'revoke-all must not disable MCP');

  const disabled = await call('POST', { action: 'set-enabled', enabled: false });
  assert.equal(disabled.status, 200, fail('set-enabled(false)', disabled));
  assert.equal(disabled.body.enabled, false);
  assert.equal(disabled.body.credentialVersion, 4, 'disabling must bump the version');
  console.log('POST set-enabled(false): enabled=false, version=4');

  const unauthorized = await fetch(`${BASE}/api/mcp/settings`, {
    headers: { Authorization: 'Bearer definitely-not-the-admin-password' },
  });
  assert.equal(unauthorized.status, 401, 'admin auth must still gate the endpoint');

  // --- OAuth discovery documents, served through next.config rewrites.
  const resourceMeta = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  assert.equal(resourceMeta.status, 200, 'protected resource metadata must be reachable');
  const resourceBody = await resourceMeta.json();
  assert.equal(resourceBody.resource, `${BASE}/api/mcp`);
  assert.deepEqual(resourceBody.authorization_servers, [BASE], 'the site must authorize for itself');
  assert.equal(resourceMeta.headers.get('access-control-allow-origin'), '*', 'metadata must be CORS-readable');
  assert.match(resourceMeta.headers.get('cache-control') || '', /no-store/);
  console.log('GET /.well-known/oauth-protected-resource:', JSON.stringify(resourceBody));

  const pathAware = await fetch(`${BASE}/.well-known/oauth-protected-resource/api/mcp`);
  assert.equal(pathAware.status, 200, 'the path-appended metadata form must resolve too');

  const authServerMeta = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  assert.equal(authServerMeta.status, 200, 'authorization server metadata must be reachable');
  const authServerBody = await authServerMeta.json();
  assert.equal(authServerBody.issuer, BASE);
  assert.equal(authServerBody.authorization_endpoint, `${BASE}/oauth/authorize`);
  assert.equal(authServerBody.client_id_metadata_document_supported, true, 'CIMD must be advertised');
  console.log(
    `GET /.well-known/oauth-authorization-server: issuer=${authServerBody.issuer}, CIMD=${authServerBody.client_id_metadata_document_supported}`,
  );

  const metadataRejectsPost = await fetch(`${BASE}/.well-known/oauth-authorization-server`, { method: 'POST' });
  assert.equal(metadataRejectsPost.status, 405, 'metadata documents must be read-only');

  // --- DCR compatibility fallback. CIMD is primary and needs no endpoint, so
  // this route must issue self-contained client IDs and store nothing.
  const registerResponse = await fetch(`${BASE}/api/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'E2E Client',
      redirect_uris: ['https://client.example.com/callback'],
    }),
  });
  const registerText = await registerResponse.text();
  assert.equal(registerResponse.status, 201, `register failed: ${registerText}`);
  const clientRecord = JSON.parse(registerText);
  assert.match(clientRecord.client_id, /^rfn_client_/, 'client ids must be self-identifying');
  assert.equal(clientRecord.token_endpoint_auth_method, 'none');
  assert.deepEqual(clientRecord.redirect_uris, ['https://client.example.com/callback']);
  assert.deepEqual(clientRecord.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(clientRecord.response_types, ['code']);
  console.log(`POST /api/oauth/register: 201, client_id=${clientRecord.client_id.slice(0, 22)}…`);

  const badRedirect = await fetch(`${BASE}/api/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://evil.example.com/cb'] }),
  });
  assert.equal(badRedirect.status, 400, 'plain-http off-loopback redirects must be refused');

  const confidentialClient = await fetch(`${BASE}/api/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://client.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  });
  assert.equal(confidentialClient.status, 400, 'confidential clients must be refused');

  const registerRejectsGet = await fetch(`${BASE}/api/oauth/register`);
  assert.equal(registerRejectsGet.status, 405, 'registration is POST-only');

  // --- Authorization endpoint.
  const reEnabled = await call('POST', { action: 'set-enabled', enabled: true });
  assert.equal(reEnabled.body.enabled, true);
  const mcpKey = rotated.body.key;
  const redirectUri = clientRecord.redirect_uris[0];

  // A real PKCE pair, so the token exchange can be exercised.
  const { deriveCodeChallenge } = await import('../lib/mcp/pkce.mjs');
  const codeVerifier = 'e2e-code-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
  const codeChallenge = await deriveCodeChallenge(codeVerifier);

  const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: clientRecord.client_id,
    redirect_uri: redirectUri,
    state: 'state-123',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })) {
    authorizeUrl.searchParams.set(key, value);
  }

  const consentResponse = await fetch(authorizeUrl, { redirect: 'manual' });
  const consentHtml = await consentResponse.text();
  assert.equal(consentResponse.status, 200, `the consent page must render: ${consentHtml.slice(0, 200)}`);
  assert.match(consentHtml, /线上 MCP 密钥/, 'the consent form must ask for the online MCP key');

  const ticket = consentHtml.match(/name="ticket" value="([^"]+)"/)?.[1];
  const csrfToken = consentHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(ticket && csrfToken, 'the consent page must embed a ticket and a CSRF token');

  const csrfCookie = (consentResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(csrfCookie, /^rf_oauth_csrf=/, 'a CSRF cookie must be set with the consent page');
  console.log('GET /oauth/authorize: 授权页渲染，含 ticket / CSRF / Cookie');

  const submitConsent = async ({ cookie = csrfCookie, key = mcpKey, body }) =>
    fetch(`${BASE}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(body || { ticket, csrf_token: csrfToken, mcp_key: key }).toString(),
      redirect: 'manual',
    });

  // A wrong key re-renders the form instead of redirecting.
  const wrongKey = await submitConsent({ key: 'rfn_live_' + 'A'.repeat(43) });
  const wrongKeyHtml = await wrongKey.text();
  assert.equal(wrongKey.status, 401, 'a wrong MCP key must not authorize');
  assert.equal(wrongKey.headers.get('location'), null, 'a wrong key must not redirect');
  assert.match(wrongKeyHtml, /密钥不正确/, 'the form must explain the failure');
  console.log('POST /oauth/authorize（错误密钥）: 401，重新渲染表单，无跳转');

  // CSRF: the ticket alone must not be enough without the browser's cookie.
  const noCookie = await submitConsent({ cookie: '' });
  assert.equal(noCookie.status, 302, 'the failure is reported through the verified redirect_uri');
  const noCookieLocation = new URL(noCookie.headers.get('location'));
  assert.equal(noCookieLocation.searchParams.get('error'), 'invalid_request');
  assert.equal(noCookieLocation.searchParams.get('iss'), BASE, 'RFC 9207: error redirects must carry iss');
  console.log('POST /oauth/authorize（缺 CSRF Cookie）: 302 error=invalid_request + iss');

  // The happy path issues a code bound to the requested state and issuer.
  const success = await submitConsent({});
  assert.equal(success.status, 302, 'a valid consent must redirect');
  const successLocation = new URL(success.headers.get('location'));
  assert.equal(successLocation.origin + successLocation.pathname, redirectUri, 'only the registered redirect_uri may receive the code');
  assert.match(String(successLocation.searchParams.get('code')), /^rfn_ac_[A-Za-z0-9_-]{43}$/);
  assert.equal(successLocation.searchParams.get('state'), 'state-123', 'state must be returned unchanged');
  assert.equal(successLocation.searchParams.get('iss'), BASE, 'RFC 9207: success redirects must carry iss');
  assert.equal(successLocation.toString().includes(mcpKey), false, 'the MCP key must never appear in the redirect');
  console.log(`POST /oauth/authorize: 302 code=${String(successLocation.searchParams.get('code')).slice(0, 12)}… state 原样返回, iss=${BASE}`);

  // Open-redirect guard: an unregistered redirect_uri is never redirected to.
  const openRedirect = new URL(authorizeUrl);
  openRedirect.searchParams.set('redirect_uri', 'https://attacker.example/callback');
  const openRedirectResponse = await fetch(openRedirect, { redirect: 'manual' });
  assert.equal(openRedirectResponse.headers.get('location'), null, 'an unverified redirect_uri must never be used');
  assert.ok(openRedirectResponse.status >= 400, 'an unverified redirect_uri must produce an error page');
  console.log(`GET /oauth/authorize（未注册 redirect_uri）: ${openRedirectResponse.status} 错误页，无 Location`);

  // A resource pointing at the plugin deployment must be refused.
  const wrongResource = new URL(authorizeUrl);
  wrongResource.searchParams.set('resource', 'https://mcp.nav.rainforest.org.cn/mcp');
  const wrongResourceResponse = await fetch(wrongResource, { redirect: 'manual' });
  assert.equal(wrongResourceResponse.status, 302, 'a verified redirect target may receive the error');
  const wrongResourceLocation = new URL(wrongResourceResponse.headers.get('location'));
  assert.equal(wrongResourceLocation.searchParams.get('error'), 'invalid_target');
  assert.equal(wrongResourceLocation.searchParams.get('iss'), BASE);
  console.log('GET /oauth/authorize（插件版 resource）: 302 error=invalid_target + iss');

  // --- Token endpoint.
  const postForm = async (fields, extraHeaders = {}) =>
    fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });

  const tokenJson = async response => ({ status: response.status, body: await response.json() });
  const baseExchange = code => ({
    grant_type: 'authorization_code',
    code,
    client_id: clientRecord.client_id,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    resource: `${BASE}/api/mcp`,
  });

  // The code obtained from the happy-path consent is still unconsumed.
  const code = String(successLocation.searchParams.get('code'));
  const exchange = await tokenJson(await postForm(baseExchange(code)));
  assert.equal(exchange.status, 200, `token exchange failed: ${JSON.stringify(exchange.body)}`);
  assert.match(exchange.body.access_token, /^rfn_at_/);
  assert.match(exchange.body.refresh_token, /^rfn_rt_/);
  assert.equal(exchange.body.token_type, 'Bearer');
  assert.equal(exchange.body.expires_in, 3600);
  assert.equal(exchange.body.scope, 'navigation:read navigation:write');
  for (const forbidden of ['credentialVersion', 'keyHash', 'rfn_live_']) {
    assert.equal(JSON.stringify(exchange.body).includes(forbidden), false, `the token response must not leak ${forbidden}`);
  }
  console.log(`POST /oauth/token（authorization_code）: 200, scope="${exchange.body.scope}"`);

  // A code is single-use, even after a successful exchange.
  const replayCode = await tokenJson(await postForm(baseExchange(code)));
  assert.equal(replayCode.status, 400);
  assert.equal(replayCode.body.error, 'invalid_grant', 'a used code must not be redeemable twice');
  console.log('POST /oauth/token（重复兑换同一 code）: invalid_grant');

  // Helper: run a fresh consent so each negative case gets its own code.
  const freshCode = async () => {
    const consent = await fetch(authorizeUrl, { redirect: 'manual' });
    const html = await consent.text();
    const cookie = (consent.headers.get('set-cookie') || '').split(';')[0];
    const submitted = await fetch(`${BASE}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({
        ticket: html.match(/name="ticket" value="([^"]+)"/)[1],
        csrf_token: html.match(/name="csrf_token" value="([^"]+)"/)[1],
        mcp_key: mcpKey,
      }).toString(),
      redirect: 'manual',
    });
    return new URL(submitted.headers.get('location')).searchParams.get('code');
  };

  const wrongVerifierCode = await freshCode();
  const wrongVerifier = await tokenJson(
    await postForm({ ...baseExchange(wrongVerifierCode), code_verifier: 'e2e-code-verifier-abcdefghijklmnopqrstuvwxyz0123456788' }),
  );
  assert.equal(wrongVerifier.body.error, 'invalid_grant', 'a wrong code_verifier must be refused');
  console.log('POST /oauth/token（错误 code_verifier）: invalid_grant');

  const missingResourceCode = await freshCode();
  const missingResource = { ...baseExchange(missingResourceCode) };
  delete missingResource.resource;
  const missingResourceResult = await tokenJson(await postForm(missingResource));
  assert.equal(missingResourceResult.body.error, 'invalid_target', 'resource must never be defaulted');
  assert.equal(missingResourceResult.status, 400);
  console.log('POST /oauth/token（缺 resource）: invalid_target');

  const pluginResourceCode = await freshCode();
  const pluginResource = await tokenJson(
    await postForm({ ...baseExchange(pluginResourceCode), resource: 'https://mcp.nav.rainforest.org.cn/mcp' }),
  );
  assert.equal(pluginResource.body.error, 'invalid_target', 'the plugin resource must be refused');

  // Parameter pollution: a repeated single-use parameter is rejected, not resolved.
  const duplicated = `grant_type=authorization_code&grant_type=authorization_code&code=${encodeURIComponent(await freshCode())}&client_id=${encodeURIComponent(clientRecord.client_id)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_verifier=${codeVerifier}&resource=${encodeURIComponent(`${BASE}/api/mcp`)}`;
  const duplicatedResponse = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: duplicated,
  });
  const duplicatedBody = await duplicatedResponse.json();
  assert.equal(duplicatedBody.error, 'invalid_request', 'a repeated parameter must be rejected');
  console.log('POST /oauth/token（重复 grant_type）: invalid_request');

  // JSON is not accepted, and neither is client authentication we do not offer.
  const jsonBody = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseExchange(await freshCode())),
  });
  assert.equal((await jsonBody.json()).error, 'invalid_request', 'only form encoding is accepted');

  const basicAuth = await postForm(baseExchange(await freshCode()), {
    Authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
  });
  assert.equal(basicAuth.status, 401, 'client authentication must be refused');
  assert.equal((await basicAuth.json()).error, 'invalid_client');

  const secretParam = await postForm({ ...baseExchange(await freshCode()), client_secret: 'shh' });
  assert.equal((await secretParam.json()).error, 'invalid_client', 'client_secret must be refused');
  console.log('POST /oauth/token（JSON body / Basic / client_secret）: 全部拒绝');

  // --- Refresh rotation.
  const firstRefresh = exchange.body.refresh_token;
  const refreshed = await tokenJson(
    await postForm({
      grant_type: 'refresh_token',
      refresh_token: firstRefresh,
      client_id: clientRecord.client_id,
      resource: `${BASE}/api/mcp`,
    }),
  );
  assert.equal(refreshed.status, 200, `refresh failed: ${JSON.stringify(refreshed.body)}`);
  assert.match(refreshed.body.access_token, /^rfn_at_/);
  assert.notEqual(refreshed.body.refresh_token, firstRefresh, 'refresh must rotate the token');
  console.log('POST /oauth/token（refresh_token）: 200，已轮换');

  const replayRefresh = await tokenJson(
    await postForm({
      grant_type: 'refresh_token',
      refresh_token: firstRefresh,
      client_id: clientRecord.client_id,
      resource: `${BASE}/api/mcp`,
    }),
  );
  assert.equal(replayRefresh.body.error, 'invalid_grant', 'a replayed refresh token must be refused');

  const afterReplay = await tokenJson(
    await postForm({
      grant_type: 'refresh_token',
      refresh_token: refreshed.body.refresh_token,
      client_id: clientRecord.client_id,
      resource: `${BASE}/api/mcp`,
    }),
  );
  assert.equal(afterReplay.body.error, 'invalid_grant', 'detecting a replay must revoke the whole family');
  console.log('POST /oauth/token（RT 重放 → family 撤销）: 新旧 refresh token 均失效');

  // --- Disabling MCP blocks the exchange.
  const disabledCode = await freshCode();
  await call('POST', { action: 'set-enabled', enabled: false });
  const disabledExchange = await tokenJson(await postForm(baseExchange(disabledCode)));
  assert.equal(disabledExchange.status, 503, 'a disabled deployment must not issue tokens');
  assert.equal(disabledExchange.body.error, 'temporarily_unavailable');
  assert.equal(disabledExchange.body.error_description, 'MCP service is disabled.');
  assert.equal(disabledExchange.body.credentialVersion, undefined);
  console.log('POST /oauth/token（MCP 已关闭）: 503 temporarily_unavailable');

  // --- /api/mcp is a protected resource.
  await call('POST', { action: 'set-enabled', enabled: true });

  const mcpCall = (body, headers = {}) =>
    fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  const bearer = token => ({ Authorization: `Bearer ${token}` });

  const noAuth = await mcpCall(rpc(1, 'initialize', {}));
  assert.equal(noAuth.status, 401, 'the endpoint must be protected');
  const challenge = noAuth.headers.get('www-authenticate') || '';
  assert.match(challenge, /^Bearer resource_metadata="/);
  assert.match(challenge, /oauth-protected-resource\/api\/mcp/, 'the canonical metadata URL must be advertised');
  console.log('POST /api/mcp（无凭据）: 401 + WWW-Authenticate');

  // Legacy credentials must never authenticate.
  for (const [label, credential] of [
    ['admin password', ADMIN_PASSWORD],
    ['legacy API key', 'legacy-mcp-api-key-value'],
    ['plugin 43-char key', 'B'.repeat(43)],
    ['plugin OAuth token', `rfo_${'a'.repeat(43)}`],
  ]) {
    const response = await mcpCall(rpc(1, 'initialize', {}), bearer(credential));
    assert.equal(response.status, 401, `${label} must not authenticate`);
    const body = await response.json();
    assert.equal(body.error, 'invalid_token');
  }
  console.log('POST /api/mcp（后台密码 / 旧 API Key / 插件凭据）: 全部 401');

  // The static key authenticates and reaches the tool catalogue.
  const staticTools = await mcpCall(rpc(2, 'tools/list', {}), bearer(mcpKey));
  assert.equal(staticTools.status, 200);
  const toolNames = (await staticTools.json()).result.tools.map(entry => entry.name);
  assert.ok(toolNames.includes('online_list_navigation_entries'));
  assert.ok(toolNames.includes('online_delete_navigation_entry'));
  assert.ok(toolNames.includes('online_get_icon_generation_guide'));
  assert.equal(toolNames.some(name => name.startsWith('extension_')), false, 'the online server must not expose plugin tools');
  console.log(`POST /api/mcp（static key）: 200, ${toolNames.length} 个工具，均为 online_ 前缀`);

  // A read-only OAuth token, obtained through the real authorization flow.
  const readScopeAuthorize = new URL(authorizeUrl);
  readScopeAuthorize.searchParams.set('scope', 'navigation:read');
  const readConsent = await fetch(readScopeAuthorize, { redirect: 'manual' });
  const readConsentHtml = await readConsent.text();
  const readConsentCookie = (readConsent.headers.get('set-cookie') || '').split(';')[0];
  const readConsentSubmit = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: readConsentCookie },
    body: new URLSearchParams({
      ticket: readConsentHtml.match(/name="ticket" value="([^"]+)"/)[1],
      csrf_token: readConsentHtml.match(/name="csrf_token" value="([^"]+)"/)[1],
      mcp_key: mcpKey,
    }).toString(),
    redirect: 'manual',
  });
  const readCode = new URL(readConsentSubmit.headers.get('location')).searchParams.get('code');
  const readTokenResponse = await tokenJson(await postForm(baseExchange(readCode)));
  assert.equal(readTokenResponse.status, 200, JSON.stringify(readTokenResponse.body));
  assert.equal(readTokenResponse.body.scope, 'navigation:read', 'the granted scope must follow the request');
  const readToken = readTokenResponse.body.access_token;

  const readTool = await mcpCall(
    rpc(3, 'tools/call', { name: 'online_list_navigation_categories', arguments: {} }),
    bearer(readToken),
  );
  assert.equal(readTool.status, 200, 'a read-scope token must reach read tools');

  const writeTool = await mcpCall(
    rpc(4, 'tools/call', { name: 'online_delete_navigation_entry', arguments: { uuid: 'nope' } }),
    bearer(readToken),
  );
  assert.equal(writeTool.status, 403, 'a read-scope token must not reach write tools');
  const scopeChallenge = writeTool.headers.get('www-authenticate') || '';
  assert.match(scopeChallenge, /error="insufficient_scope"/);
  assert.match(scopeChallenge, /scope="navigation:write"/);
  console.log('POST /api/mcp（read scope → read tool / write tool）: 200 / 403 insufficient_scope');

  // A batch is rejected as a whole, so it can never half-execute.
  const batch = await mcpCall(
    [
      rpc(5, 'tools/call', { name: 'online_list_navigation_categories', arguments: {} }),
      rpc(6, 'tools/call', { name: 'online_delete_navigation_entry', arguments: { uuid: 'nope' } }),
    ],
    bearer(readToken),
  );
  assert.equal(batch.status, 403, 'a batch containing a write must be refused entirely for a read-scope token');
  console.log('POST /api/mcp（batch read+write，read token）: 整批 403');

  // Disabling the service must not look like an authentication problem.
  await call('POST', { action: 'set-enabled', enabled: false });
  const disabledMcp = await mcpCall(rpc(7, 'initialize', {}), bearer(mcpKey));
  assert.equal(disabledMcp.status, 503);
  assert.equal(disabledMcp.headers.get('www-authenticate'), null, 'a disabled service must not send a challenge');
  const disabledBody = await disabledMcp.json();
  assert.equal(disabledBody.error, 'service_disabled');
  console.log('POST /api/mcp（MCP 已关闭）: 503 service_disabled，无 WWW-Authenticate');

  await stopServer();

  // --- Scenario 2: no Redis configured must fail closed.
  await startServer({ UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });

  const blocked = await call('GET');
  assert.equal(blocked.status, 503, fail('fail-closed GET', blocked));
  assert.match(String(blocked.body?.error), /Redis is not configured/, 'error must name the missing dependency');
  console.log('无 Redis 配置时 GET: 503 fail closed');

  const blockedWrite = await call('POST', { action: 'rotate-key' });
  assert.equal(blockedWrite.status, 503, fail('fail-closed rotate-key', blockedWrite));
  console.log('无 Redis 配置时 POST rotate-key: 503 fail closed');

  console.log('线上 MCP 管理 API 端到端校验通过（含 fail-closed 分支）。');
} finally {
  await stopServer();
  await fake.close();
}
