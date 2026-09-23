// Unit tests for authorization request validation.
import assert from 'node:assert/strict';
import {
  AuthorizationRequestError,
  parseAuthorizationParameters,
  parseClientRequest,
} from '../lib/mcp/authorization-request.mjs';

const RESOURCE = 'https://nav.rainforest.org.cn/api/mcp';
const SCOPES = ['navigation:read', 'navigation:write'];
const OPTIONS = { resourceId: RESOURCE, scopes: SCOPES };

const params = query => new URLSearchParams(query);
const CHALLENGE = 'a'.repeat(43);

function expectError(run, code) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AuthorizationRequestError, `expected an AuthorizationRequestError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected an error with code ${code}`);
}

// --- Stage 1: only what gates redirect trust.
assert.deepEqual(
  parseClientRequest(params(`response_type=code&client_id=https%3A%2F%2Fc.example%2Fc.json&redirect_uri=https%3A%2F%2Fc.example%2Fcb&state=xyz`)),
  { clientId: 'https://c.example/c.json', redirectUri: 'https://c.example/cb', state: 'xyz' },
);
assert.equal(parseClientRequest(params('response_type=code&client_id=a&redirect_uri=b')).state, '', 'state defaults to empty');

expectError(() => parseClientRequest(params('client_id=a&redirect_uri=b')), 'unsupported_response_type');
expectError(() => parseClientRequest(params('response_type=token&client_id=a&redirect_uri=b')), 'unsupported_response_type');
expectError(() => parseClientRequest(params('response_type=code&redirect_uri=b')), 'invalid_request');
expectError(() => parseClientRequest(params('response_type=code&client_id=a')), 'invalid_request');

// --- Stage 2: everything else, validated only after the redirect is trusted.
assert.deepEqual(
  parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}&scope=navigation%3Aread`), OPTIONS),
  { codeChallenge: CHALLENGE, resource: RESOURCE, scopes: ['navigation:read'] },
);

// An omitted resource defaults to this deployment's own resource ID.
assert.equal(parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256`), OPTIONS).resource, RESOURCE);

// An omitted scope defaults to the full set this server offers.
assert.deepEqual(
  parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256`), OPTIONS).scopes,
  SCOPES,
);

// Scopes are de-duplicated and must be a subset.
assert.deepEqual(
  parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=navigation%3Aread+navigation%3Aread`), OPTIONS).scopes,
  ['navigation:read'],
);
expectError(
  () => parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=navigation%3Aread+admin`), OPTIONS),
  'invalid_scope',
);

// PKCE is mandatory and must be S256 with a well-formed challenge.
expectError(() => parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}`), OPTIONS), 'invalid_request');
expectError(
  () => parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=plain`), OPTIONS),
  'invalid_request',
);
expectError(
  () => parseAuthorizationParameters(params('code_challenge=short&code_challenge_method=S256'), OPTIONS),
  'invalid_request',
);
expectError(
  () => parseAuthorizationParameters(params(`code_challenge=${'a'.repeat(44)}&code_challenge_method=S256`), OPTIONS),
  'invalid_request',
);
expectError(
  () => parseAuthorizationParameters(params(`code_challenge=${'a'.repeat(42)}%3D&code_challenge_method=S256`), OPTIONS),
  'invalid_request',
);

// The resource must be this deployment's own resource — a token bound to another
// audience must never be mintable here.
expectError(
  () => parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=${encodeURIComponent('https://mcp.nav.rainforest.org.cn/mcp')}`), OPTIONS),
  'invalid_target',
);
expectError(
  () => parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=${encodeURIComponent('https://nav.rainforest.org.cn')}`), OPTIONS),
  'invalid_target',
);
expectError(
  () => parseAuthorizationParameters(params(`code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE + '/extra')}`), OPTIONS),
  'invalid_target',
);

console.log('Online authorization request validation passed.');
