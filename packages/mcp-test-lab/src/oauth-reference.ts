import { createHash, randomBytes as createRandomBytes, timingSafeEqual } from 'node:crypto';
import {
  getOAuthProtectedResourceMetadataUrl,
  type McpHttpHandler,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { McpLabProtocolMethod } from './faults.js';

const BODY_LIMIT_BYTES = 16 * 1024;
const CODE_LIFETIME_SECONDS = 300;
const STATE_LIFETIME_SECONDS = 300;
const TOKEN_LIFETIME_SECONDS = 300;
const MAX_CLIENTS = 64;
const MAX_CODES = 128;
const MAX_STATES = 128;
const MAX_TOKENS = 128;
const MAX_URL_BYTES = 8 * 1024;
const MCP_BODY_LIMIT_BYTES = 1024 * 1024;
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const STATE_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/u;
const AUTHORIZATION_KEYS = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'resource',
  'response_type',
  'scope',
  'state',
]);
const TOKEN_KEYS = new Set([
  'client_id',
  'code',
  'code_verifier',
  'grant_type',
  'redirect_uri',
  'resource',
]);
const CALLBACK_KEYS = new Set(['code', 'error', 'error_description', 'error_uri', 'iss', 'state']);

interface RegisteredClient {
  readonly redirectUris: readonly string[];
}

interface AuthorizationCode {
  readonly challenge: string;
  readonly clientId: string;
  readonly expiresAt: number;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scope: string;
}

interface AccessToken {
  readonly clientId: string;
  readonly expiresAt: number;
  readonly resource: string;
  readonly scope: string;
}

interface OAuthRuntime {
  readonly clients: Map<string, RegisteredClient>;
  readonly codes: Map<string, AuthorizationCode>;
  nextAccessToken(): string;
  nextAuthorizationCode(): string;
  nextClientId(): string;
  readonly states: Map<string, number>;
  readonly tokens: Map<string, AccessToken>;
}

class BodyLimitError extends Error {}

export interface McpOAuthReferenceEndpoint {
  readonly authorizationServerMetadataUrl: URL;
  readonly authorizationUrl: URL;
  readonly issuer: URL;
  readonly kind: 'oauth-loopback-http';
  readonly protectedResourceMetadataUrl: URL;
  readonly registrationUrl: URL;
  readonly tokenUrl: URL;
  readonly url: URL;
}

export interface McpOAuthReferenceStateCounts {
  readonly clients: number;
  readonly codes: number;
  readonly states: number;
  readonly tokens: number;
}

export interface McpOAuthReferenceHandler extends McpHttpHandler {
  readonly endpoint: McpOAuthReferenceEndpoint;
  stateCounts(): McpOAuthReferenceStateCounts;
}

export interface McpOAuthReferenceHandlerOptions {
  readonly beforeAuthorizationMutation?: (
    request: Request,
    method: McpLabProtocolMethod
  ) => Promise<void>;
  readonly beforeMcpDispatch?: (request: Request, boundedRequest: Request) => Promise<unknown>;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface McpOAuthAuthorizationResponseVerifierOptions {
  readonly endpoint: McpOAuthReferenceEndpoint;
  readonly expectedRedirectUri: string;
  readonly expectedState: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactStringArray(value: unknown, expected: string): value is readonly string[] {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function requestsSupportedAuthorizationCodeGrant(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.includes('authorization_code') &&
    value.every((grant) => grant === 'authorization_code' || grant === 'refresh_token') &&
    new Set(value).size === value.length
  );
}

function methodNotAllowed(method: string): Response {
  return new Response('Method not allowed', { headers: { allow: method }, status: 405 });
}

function oauthError(error: string, description: string): Response {
  return Response.json(
    { error, ['error_description']: description },
    { headers: { 'cache-control': 'no-store' }, status: 400 }
  );
}

function authorizationError(
  endpoint: McpOAuthReferenceEndpoint,
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined
): Response {
  const callback = new URL(redirectUri);
  callback.searchParams.set('error', error);
  callback.searchParams.set('error_description', description);
  callback.searchParams.set('iss', endpoint.issuer.href);
  if (state !== undefined) {
    callback.searchParams.set('state', state);
  }
  return new Response(null, {
    headers: { 'cache-control': 'no-store', location: callback.href },
    status: 302,
  });
}

function metadataResponse(value: OAuthMetadata | OAuthProtectedResourceMetadata): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } });
}

async function serveMetadata(
  request: Request,
  value: OAuthMetadata | OAuthProtectedResourceMetadata,
  method: McpLabProtocolMethod,
  beforeMutation: McpOAuthReferenceHandlerOptions['beforeAuthorizationMutation']
): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }
  if (new URL(request.url).search) {
    return oauthError('invalid_request', 'Metadata request is invalid');
  }
  await beforeMutation?.(request, method);
  return metadataResponse(value);
}

function hasContentType(request: Request, expected: string): boolean {
  return request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === expected;
}

async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > limit) {
      throw new BodyLimitError('MCP OAuth request body exceeds the fixture limit');
    }
  }
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    total += result.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyLimitError('MCP OAuth request body exceeds the fixture limit');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedBody(request: Request): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    await readBoundedBytes(request, BODY_LIMIT_BYTES)
  );
}

function readKnownParams(
  params: URLSearchParams,
  allowed: ReadonlySet<string>
): Readonly<Record<string, string>> | undefined {
  const values: Record<string, string> = {};
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      continue;
    }
    if (params.getAll(key).length !== 1) {
      return;
    }
    const value = params.get(key);
    if (value === null) {
      return;
    }
    values[key] = value;
  }
  return values;
}

function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function createRuntime(randomBytes: (size: number) => Uint8Array): OAuthRuntime {
  let clientSequence = 0;
  let codeSequence = 0;
  let tokenSequence = 0;
  const nextId = (prefix: string, sequence: number): string => {
    const entropy = randomBytes(18);
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 18) {
      throw new Error('MCP OAuth random source returned an invalid byte sequence');
    }
    return `${prefix}-${sequence}-${Buffer.from(entropy).toString('base64url')}`;
  };
  return {
    clients: new Map(),
    codes: new Map(),
    nextAccessToken() {
      tokenSequence += 1;
      return nextId('brainstrike-lab-access', tokenSequence);
    },
    nextAuthorizationCode() {
      codeSequence += 1;
      return nextId('brainstrike-lab-code', codeSequence);
    },
    nextClientId() {
      clientSequence += 1;
      return nextId('brainstrike-lab-client', clientSequence);
    },
    states: new Map(),
    tokens: new Map(),
  };
}

function pruneExpiredRecords(runtime: OAuthRuntime, nowSeconds: number): void {
  for (const [code, record] of runtime.codes) {
    if (record.expiresAt <= nowSeconds) {
      runtime.codes.delete(code);
    }
  }
  for (const [state, expiresAt] of runtime.states) {
    if (expiresAt <= nowSeconds) {
      runtime.states.delete(state);
    }
  }
  for (const [token, record] of runtime.tokens) {
    if (record.expiresAt <= nowSeconds) {
      runtime.tokens.delete(token);
    }
  }
}

function pkceMatches(verifier: string, expectedChallenge: string): boolean {
  if (!PKCE_VALUE_PATTERN.test(verifier)) {
    return false;
  }
  const actual = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(expectedChallenge);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function createAuthorizationMetadata(endpoint: McpOAuthReferenceEndpoint): OAuthMetadata {
  return {
    ['authorization_endpoint']: endpoint.authorizationUrl.href,
    ['authorization_response_iss_parameter_supported']: true,
    ['code_challenge_methods_supported']: ['S256'],
    ['grant_types_supported']: ['authorization_code'],
    issuer: endpoint.issuer.href,
    ['registration_endpoint']: endpoint.registrationUrl.href,
    ['response_types_supported']: ['code'],
    ['scopes_supported']: ['mcp'],
    ['token_endpoint']: endpoint.tokenUrl.href,
    ['token_endpoint_auth_methods_supported']: ['none'],
  };
}

function createProtectedResourceMetadata(
  endpoint: McpOAuthReferenceEndpoint
): OAuthProtectedResourceMetadata {
  return {
    ['authorization_servers']: [endpoint.issuer.href],
    ['bearer_methods_supported']: ['header'],
    resource: endpoint.url.href,
    ['resource_name']: 'Brainstrike MCP Lab',
    ['scopes_supported']: ['mcp'],
  };
}

async function registerClient(
  request: Request,
  runtime: OAuthRuntime,
  beforeMutation: McpOAuthReferenceHandlerOptions['beforeAuthorizationMutation']
): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (new URL(request.url).search || !hasContentType(request, 'application/json')) {
    return oauthError('invalid_client_metadata', 'Client registration is invalid');
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request));
  } catch {
    return oauthError('invalid_client_metadata', 'Client registration is invalid');
  }
  if (!isRecord(body)) {
    return oauthError('invalid_client_metadata', 'Client registration is invalid');
  }
  const redirectUris = body['redirect_uris'];
  const clientName = body['client_name'];
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 8 ||
    !redirectUris.every(
      (value): value is string => typeof value === 'string' && isLoopbackRedirect(value)
    ) ||
    new Set(redirectUris).size !== redirectUris.length
  ) {
    return oauthError('invalid_redirect_uri', 'Client redirect URI is invalid');
  }
  if (
    body['application_type'] !== 'native' ||
    typeof clientName !== 'string' ||
    clientName.length === 0 ||
    clientName.length > 128 ||
    !requestsSupportedAuthorizationCodeGrant(body['grant_types']) ||
    !isExactStringArray(body['response_types'], 'code') ||
    body['token_endpoint_auth_method'] !== 'none' ||
    (body['scope'] !== undefined && body['scope'] !== 'mcp')
  ) {
    return oauthError('invalid_client_metadata', 'Client registration is invalid');
  }
  if (runtime.clients.size >= MAX_CLIENTS) {
    return oauthError('invalid_client_metadata', 'Client registration capacity was reached');
  }
  await beforeMutation?.(request, 'oauth/register');
  const clientId = runtime.nextClientId();
  runtime.clients.set(clientId, { redirectUris: Object.freeze([...redirectUris]) });
  return Response.json(
    {
      ['application_type']: 'native',
      ['client_id']: clientId,
      ['client_id_issued_at']: 1_700_000_000,
      ['client_name']: clientName,
      ['grant_types']: ['authorization_code'],
      ['redirect_uris']: [...redirectUris],
      ['response_types']: ['code'],
      ...(body['scope'] === 'mcp' ? { scope: 'mcp' } : {}),
      ['token_endpoint_auth_method']: 'none',
    },
    { headers: { 'cache-control': 'no-store' }, status: 201 }
  );
}

async function authorizeClient(
  request: Request,
  endpoint: McpOAuthReferenceEndpoint,
  runtime: OAuthRuntime,
  nowSeconds: number,
  beforeMutation: McpOAuthReferenceHandlerOptions['beforeAuthorizationMutation']
): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }
  if (Buffer.byteLength(request.url) > MAX_URL_BYTES) {
    return oauthError('invalid_request', 'Authorization request is invalid');
  }
  const values = readKnownParams(new URL(request.url).searchParams, AUTHORIZATION_KEYS);
  const clientId = values?.['client_id'];
  const redirectUri = values?.['redirect_uri'];
  const state = values?.['state'];
  if (
    !(
      values &&
      clientId &&
      redirectUri &&
      runtime.clients.get(clientId)?.redirectUris.includes(redirectUri)
    )
  ) {
    return oauthError('invalid_request', 'Authorization request is invalid');
  }
  pruneExpiredRecords(runtime, nowSeconds);
  if (values['resource'] === undefined) {
    return authorizationError(
      endpoint,
      redirectUri,
      'invalid_request',
      'Authorization resource is required',
      state
    );
  }
  if (values['resource'] !== endpoint.url.href) {
    return authorizationError(
      endpoint,
      redirectUri,
      'invalid_target',
      'Authorization resource is invalid',
      state
    );
  }
  if (runtime.states.size >= MAX_STATES || runtime.codes.size >= MAX_CODES) {
    return authorizationError(
      endpoint,
      redirectUri,
      'temporarily_unavailable',
      'Authorization request capacity was reached',
      state
    );
  }
  if (
    values['response_type'] !== 'code' ||
    values['code_challenge_method'] !== 'S256' ||
    !PKCE_VALUE_PATTERN.test(values['code_challenge'] ?? '') ||
    !state ||
    !STATE_PATTERN.test(state) ||
    runtime.states.has(state) ||
    values['scope'] !== 'mcp'
  ) {
    return authorizationError(
      endpoint,
      redirectUri,
      'invalid_request',
      'Authorization request is invalid',
      state
    );
  }
  await beforeMutation?.(request, 'oauth/authorize');
  runtime.states.set(state, nowSeconds + STATE_LIFETIME_SECONDS);
  const code = runtime.nextAuthorizationCode();
  runtime.codes.set(code, {
    challenge: values['code_challenge'] ?? '',
    clientId,
    expiresAt: nowSeconds + CODE_LIFETIME_SECONDS,
    redirectUri,
    resource: endpoint.url.href,
    scope: 'mcp',
  });
  const callback = new URL(redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('iss', endpoint.issuer.href);
  callback.searchParams.set('state', state);
  return new Response(null, { headers: { location: callback.href }, status: 302 });
}

async function exchangeCode(
  request: Request,
  endpoint: McpOAuthReferenceEndpoint,
  runtime: OAuthRuntime,
  nowSeconds: number,
  beforeMutation: McpOAuthReferenceHandlerOptions['beforeAuthorizationMutation']
): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (request.headers.has('authorization')) {
    return oauthError('invalid_client', 'Public client authentication is invalid');
  }
  if (
    new URL(request.url).search ||
    !hasContentType(request, 'application/x-www-form-urlencoded')
  ) {
    return oauthError('invalid_request', 'Token request is invalid');
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await readBoundedBody(request));
  } catch {
    return oauthError('invalid_request', 'Token request is invalid');
  }
  const values = readKnownParams(params, TOKEN_KEYS);
  if (
    params.has('client_secret') ||
    params.has('client_assertion') ||
    params.has('client_assertion_type')
  ) {
    return oauthError('invalid_client', 'Public client authentication is invalid');
  }
  const code = values?.['code'];
  const verifier = values?.['code_verifier'];
  pruneExpiredRecords(runtime, nowSeconds);
  const record = code ? runtime.codes.get(code) : undefined;
  if (values?.['resource'] === undefined) {
    return oauthError('invalid_request', 'Token resource is required');
  }
  if (values['resource'] !== endpoint.url.href) {
    return oauthError('invalid_target', 'Token resource is invalid');
  }
  const invalidGrant =
    values?.['grant_type'] !== 'authorization_code' ||
    !code ||
    !record ||
    !verifier ||
    !pkceMatches(verifier, record.challenge) ||
    values['client_id'] !== record.clientId ||
    values['redirect_uri'] !== record.redirectUri;
  if (invalidGrant) {
    if (code && record) {
      runtime.codes.delete(code);
    }
    return oauthError('invalid_grant', 'Authorization code or PKCE binding is invalid');
  }
  if (runtime.tokens.size >= MAX_TOKENS) {
    return oauthError('temporarily_unavailable', 'Token capacity was reached');
  }
  await beforeMutation?.(request, 'oauth/token');
  runtime.codes.delete(code);
  const accessToken = runtime.nextAccessToken();
  runtime.tokens.set(accessToken, {
    clientId: record.clientId,
    expiresAt: nowSeconds + TOKEN_LIFETIME_SECONDS,
    resource: record.resource,
    scope: record.scope,
  });
  return Response.json(
    {
      ['access_token']: accessToken,
      ['expires_in']: TOKEN_LIFETIME_SECONDS,
      scope: record.scope,
      ['token_type']: 'Bearer',
    },
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } }
  );
}

async function prepareMcpRequest(request: Request): Promise<Request | Response> {
  const url = new URL(request.url);
  if (url.search) {
    return Response.json({ error: 'mcp_lab_query_not_allowed' }, { status: 400 });
  }
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (!hasContentType(request, 'application/json')) {
    return Response.json({ error: 'mcp_lab_content_type_required' }, { status: 415 });
  }
  let body: Uint8Array;
  try {
    body = await readBoundedBytes(request, MCP_BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof BodyLimitError) {
      return Response.json({ error: 'mcp_lab_body_too_large' }, { status: 413 });
    }
    throw error;
  }
  try {
    return new Request(request.url, {
      body: new TextDecoder('utf-8', { fatal: true }).decode(body),
      headers: request.headers,
      method: request.method,
      signal: request.signal,
    });
  } catch {
    return Response.json({ error: 'mcp_lab_body_invalid_utf8' }, { status: 400 });
  }
}

export function createMcpOAuthReferenceEndpoint(origin: URL): McpOAuthReferenceEndpoint {
  const issuer = new URL(origin);
  if (
    issuer.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(issuer.hostname) ||
    issuer.pathname !== '/' ||
    issuer.search ||
    issuer.hash ||
    issuer.username ||
    issuer.password
  ) {
    throw new Error('MCP OAuth reference origin must be an uncredentialed loopback HTTP origin');
  }
  const url = new URL('/mcp', issuer);
  return Object.freeze({
    authorizationServerMetadataUrl: new URL('/.well-known/oauth-authorization-server', issuer),
    authorizationUrl: new URL('/authorize', issuer),
    issuer,
    kind: 'oauth-loopback-http' as const,
    protectedResourceMetadataUrl: new URL(getOAuthProtectedResourceMetadataUrl(url)),
    registrationUrl: new URL('/register', issuer),
    tokenUrl: new URL('/token', issuer),
    url,
  });
}

function hasExactExpectedRedirectQuery(callback: URL, expectedRedirect: URL): boolean {
  for (const key of new Set(expectedRedirect.searchParams.keys())) {
    const expectedValues = expectedRedirect.searchParams.getAll(key);
    const actualValues = callback.searchParams.getAll(key);
    if (
      actualValues.length !== expectedValues.length ||
      actualValues.some((value, index) => value !== expectedValues[index])
    ) {
      return false;
    }
  }
  return true;
}

function readAuthorizationResponseCode(values: Readonly<Record<string, string>>): string {
  if (values['error']) {
    if (values['code']) {
      throw new Error('MCP OAuth authorization response contains both code and error');
    }
    const description = values['error_description'];
    throw new Error(
      `MCP OAuth authorization error: ${values['error']}${description ? ` (${description})` : ''}`
    );
  }
  const code = values['code'];
  if (!code) {
    throw new Error('MCP OAuth authorization response is missing an authorization code');
  }
  return code;
}

export function createMcpOAuthAuthorizationResponseVerifier(
  options: McpOAuthAuthorizationResponseVerifierOptions
): (callback: URL) => string {
  const expectedRedirect = new URL(options.expectedRedirectUri);
  if (
    !(isLoopbackRedirect(expectedRedirect.href) && STATE_PATTERN.test(options.expectedState)) ||
    [...expectedRedirect.searchParams.keys()].some((key) => CALLBACK_KEYS.has(key))
  ) {
    throw new Error('MCP OAuth callback verifier configuration is invalid');
  }
  let consumed = false;
  return (callback: URL): string => {
    if (consumed) {
      throw new Error('MCP OAuth authorization response was already consumed');
    }
    if (
      callback.origin !== expectedRedirect.origin ||
      callback.pathname !== expectedRedirect.pathname ||
      callback.hash !== expectedRedirect.hash ||
      !hasExactExpectedRedirectQuery(callback, expectedRedirect)
    ) {
      throw new Error('MCP OAuth authorization response redirect mismatch');
    }
    if (Buffer.byteLength(callback.href) > MAX_URL_BYTES) {
      throw new Error('MCP OAuth authorization response exceeds the fixture limit');
    }
    const values = readKnownParams(callback.searchParams, CALLBACK_KEYS);
    if (!values) {
      throw new Error('MCP OAuth authorization response repeats a known parameter');
    }
    if (values['state'] !== options.expectedState) {
      throw new Error('MCP OAuth authorization response state mismatch');
    }
    if (values['iss'] !== options.endpoint.issuer.href) {
      throw new Error('MCP OAuth authorization response issuer mismatch');
    }
    const code = readAuthorizationResponseCode(values);
    consumed = true;
    return code;
  };
}

export function createMcpOAuthReferenceHandler(
  downstream: McpHttpHandler,
  endpoint: McpOAuthReferenceEndpoint,
  options: McpOAuthReferenceHandlerOptions = {}
): McpOAuthReferenceHandler {
  if (
    options.beforeAuthorizationMutation !== undefined &&
    typeof options.beforeAuthorizationMutation !== 'function'
  ) {
    throw new Error('MCP OAuth reference authorization hook must be a function');
  }
  if (options.beforeMcpDispatch !== undefined && typeof options.beforeMcpDispatch !== 'function') {
    throw new Error('MCP OAuth reference MCP dispatch hook must be a function');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new Error('MCP OAuth reference clock must be a function');
  }
  if (options.randomBytes !== undefined && typeof options.randomBytes !== 'function') {
    throw new Error('MCP OAuth reference random source must be a function');
  }
  const now = options.now ?? (() => Date.now());
  const runtime = createRuntime(options.randomBytes ?? createRandomBytes);
  const authorizationMetadata = createAuthorizationMetadata(endpoint);
  const protectedResourceMetadata = createProtectedResourceMetadata(endpoint);
  let authorizationMutationTail = Promise.resolve();
  const serializeAuthorizationMutation = <Result>(
    mutation: () => Promise<Result>
  ): Promise<Result> => {
    const result = authorizationMutationTail.then(mutation);
    authorizationMutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const gate = requireBearerAuth({
    requiredScopes: ['mcp'],
    resourceMetadataUrl: endpoint.protectedResourceMetadataUrl.href,
    verifier: {
      async verifyAccessToken(token) {
        const record = runtime.tokens.get(token);
        if (!record) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown access token');
        }
        const nowSeconds = Math.floor(now() / 1000);
        if (record.expiresAt <= nowSeconds) {
          runtime.tokens.delete(token);
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has expired');
        }
        const remainingLifetime = record.expiresAt - nowSeconds;
        return {
          clientId: record.clientId,
          expiresAt: Math.ceil(Date.now() / 1000) + remainingLifetime,
          resource: new URL(record.resource),
          scopes: record.scope.split(' '),
          token,
        };
      },
    },
  });
  const routes = new Map<string, (request: Request) => Promise<Response> | Response>([
    [
      endpoint.authorizationServerMetadataUrl.pathname,
      (request) =>
        serveMetadata(
          request,
          authorizationMetadata,
          'oauth/authorization-server',
          options.beforeAuthorizationMutation
        ),
    ],
    [
      endpoint.protectedResourceMetadataUrl.pathname,
      (request) =>
        serveMetadata(
          request,
          protectedResourceMetadata,
          'oauth/protected-resource',
          options.beforeAuthorizationMutation
        ),
    ],
    [
      endpoint.registrationUrl.pathname,
      (request) =>
        serializeAuthorizationMutation(() =>
          registerClient(request, runtime, options.beforeAuthorizationMutation)
        ),
    ],
    [
      endpoint.authorizationUrl.pathname,
      (request) =>
        serializeAuthorizationMutation(() =>
          authorizeClient(
            request,
            endpoint,
            runtime,
            Math.floor(now() / 1000),
            options.beforeAuthorizationMutation
          )
        ),
    ],
    [
      endpoint.tokenUrl.pathname,
      (request) =>
        serializeAuthorizationMutation(() =>
          exchangeCode(
            request,
            endpoint,
            runtime,
            Math.floor(now() / 1000),
            options.beforeAuthorizationMutation
          )
        ),
    ],
  ]);
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const inFlightRequests = new Set<Promise<void>>();
  const handler: McpOAuthReferenceHandler = {
    bus: downstream.bus,
    close(): Promise<void> {
      if (!closePromise) {
        closed = true;
        closePromise = (async () => {
          await Promise.all(inFlightRequests);
          runtime.clients.clear();
          runtime.codes.clear();
          runtime.states.clear();
          runtime.tokens.clear();
          await downstream.close();
        })().catch((error: unknown) => {
          closePromise = undefined;
          throw error;
        });
      }
      return closePromise;
    },
    endpoint,
    async fetch(request, requestOptions) {
      if (closed) {
        throw new Error('MCP OAuth reference handler is closed');
      }
      let finishRequest: (() => void) | undefined;
      const requestFinished = new Promise<void>((resolve) => {
        finishRequest = resolve;
      });
      inFlightRequests.add(requestFinished);
      try {
        const url = new URL(request.url);
        const route = routes.get(url.pathname);
        if (route) {
          return await route(request);
        }
        if (url.pathname !== endpoint.url.pathname) {
          return new Response('Not found', { status: 404 });
        }
        const auth = await gate(request);
        if (auth instanceof Response) {
          return auth;
        }
        const boundedRequest = await prepareMcpRequest(request);
        if (boundedRequest instanceof Response) {
          return boundedRequest;
        }
        const parsedBody = await options.beforeMcpDispatch?.(request, boundedRequest);
        return await downstream.fetch(boundedRequest, {
          ...requestOptions,
          authInfo: auth,
          ...(parsedBody === undefined ? {} : { parsedBody }),
        });
      } finally {
        inFlightRequests.delete(requestFinished);
        finishRequest?.();
      }
    },
    notify: downstream.notify,
    stateCounts: () =>
      Object.freeze({
        clients: runtime.clients.size,
        codes: runtime.codes.size,
        states: runtime.states.size,
        tokens: runtime.tokens.size,
      }),
  };
  return Object.freeze(handler);
}
