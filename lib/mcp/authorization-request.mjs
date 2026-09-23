// Validation of OAuth authorization requests. Split deliberately into two
// stages: the client and redirect_uri must be established before any error may
// be sent as a redirect, because redirecting to an unverified URI would turn the
// authorization endpoint into an open redirect.
//
// Runtime-independent: Web APIs only.

export class AuthorizationRequestError extends Error {
  constructor(code, description) {
    super(description);
    this.name = 'AuthorizationRequestError';
    this.code = code;
  }
}

// Stage 1 — only what is needed to decide whether a redirect target can be
// trusted. Failures here must be rendered, never redirected.
export function parseClientRequest(params) {
  const responseType = params.get('response_type');
  if (responseType !== 'code') {
    throw new AuthorizationRequestError('unsupported_response_type', 'Only response_type=code is supported.');
  }

  const clientId = params.get('client_id') || '';
  if (!clientId) throw new AuthorizationRequestError('invalid_request', 'client_id is required.');

  const redirectUri = params.get('redirect_uri') || '';
  if (!redirectUri) throw new AuthorizationRequestError('invalid_request', 'redirect_uri is required.');

  return { clientId, redirectUri, state: params.get('state') || '' };
}

// Stage 2 — everything else. Once the client and redirect_uri are verified these
// failures may be reported through an error redirect.
export function parseAuthorizationParameters(params, options) {
  const codeChallengeMethod = params.get('code_challenge_method');
  if (codeChallengeMethod !== 'S256') {
    throw new AuthorizationRequestError('invalid_request', 'code_challenge_method must be S256.');
  }

  const codeChallenge = params.get('code_challenge') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new AuthorizationRequestError('invalid_request', 'code_challenge must be a 43-character base64url value.');
  }

  const resource = params.get('resource') || options.resourceId;
  if (resource !== options.resourceId) {
    throw new AuthorizationRequestError('invalid_target', 'The requested resource is not supported by this authorization server.');
  }

  return { codeChallenge, resource, scopes: parseScopes(params.get('scope'), options.scopes) };
}

function parseScopes(value, allowed) {
  const requested = String(value || '').split(/\s+/).filter(Boolean);
  const scopes = requested.length ? Array.from(new Set(requested)) : [...allowed];

  const unsupported = scopes.filter(scope => !allowed.includes(scope));
  if (unsupported.length) {
    throw new AuthorizationRequestError('invalid_scope', `Unsupported scope: ${unsupported.join(', ')}`);
  }
  return scopes;
}
