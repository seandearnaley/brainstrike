import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { McpHostOAuthAuthSnapshot } from '@brainstrike/assistant-contract';
import {
  checkResourceAllowed,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  resourceUrlFromServerUrl,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  validateClientMetadataUrl,
} from '@modelcontextprotocol/client';
import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

const DEFAULT_CALLBACK_PATH = '/mcp/oauth/callback';
const MAX_CALLBACK_URL_BYTES = 16 * 1024;
const AUTHORIZATION_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOST = '127.0.0.1';
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export interface McpOAuthPersistedState {
  clientInformation?: StoredOAuthClientInformation;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastSuccessfulConnectionAt?: number;
  resourceUrl?: string;
  tokens?: StoredOAuthTokens;
  updatedAt: number;
}

export interface McpOAuthStoreIdentity {
  readonly resourceUrl: string;
  readonly scopeKey: string;
  readonly serverId: string;
}

export interface McpOAuthStore {
  clear(identity: McpOAuthStoreIdentity): Promise<void>;
  clearAll(): Promise<void>;
  read(identity: McpOAuthStoreIdentity): Promise<Readonly<Record<string, McpOAuthPersistedState>>>;
  write(
    identity: McpOAuthStoreIdentity,
    records: Readonly<Record<string, McpOAuthPersistedState>>
  ): Promise<void>;
}

interface EncryptedStoreSchema {
  records: Record<string, string>;
}

const encryptedStores = new Set<McpOAuthStore>();
const liveProviders = new Set<McpOAuthClientProvider>();

interface SafeStorageLike {
  decryptString(value: Buffer): string;
  encryptString(value: string): Buffer;
  getSelectedStorageBackend?(): string;
  isEncryptionAvailable(): boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafeStorage(storage: SafeStorageLike): void {
  if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('MCP OAuth persistence requires OS-backed safeStorage encryption.');
  }
}

function assertSecureOAuthUrl(input: string | URL | Request): void {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  const loopback =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('MCP OAuth network endpoints must use HTTPS outside loopback test endpoints.');
  }
}

function identityKey(identity: McpOAuthStoreIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([identity.serverId, identity.resourceUrl, identity.scopeKey]), 'utf8')
    .digest('hex');
}

export function createMcpOAuthStoreIdentity(
  serverId: string,
  serverUrl: string | URL,
  scopes?: readonly string[]
): McpOAuthStoreIdentity {
  return {
    resourceUrl: resourceUrlFromServerUrl(new URL(serverUrl)).href,
    scopeKey: [...normalizeOAuthScopes(scopes)].sort().join(' '),
    serverId,
  };
}

const OAUTH_SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;

function normalizeOAuthScopes(scopes: readonly string[] | undefined): readonly string[] {
  if (scopes === undefined || scopes.length === 0) {
    return Object.freeze([]);
  }
  if (
    scopes.some((scope) => !OAUTH_SCOPE_TOKEN_PATTERN.test(scope)) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new Error('MCP OAuth scopes must be unique RFC 6749 scope tokens.');
  }
  return Object.freeze([...scopes]);
}

function latestOAuthRecord(
  records: Readonly<Record<string, McpOAuthPersistedState>>,
  preferredIssuer?: string
): readonly [string, McpOAuthPersistedState] | undefined {
  if (preferredIssuer !== undefined) {
    const preferred = records[preferredIssuer];
    if (preferred) {
      return [preferredIssuer, preferred];
    }
  }
  const sorted = Object.entries(records).sort((left, right) => {
    const successfulConnectionDelta =
      (right[1].lastSuccessfulConnectionAt ?? -1) - (left[1].lastSuccessfulConnectionAt ?? -1);
    return successfulConnectionDelta || right[1].updatedAt - left[1].updatedAt;
  });
  return sorted.find(([, record]) => record.tokens !== undefined) ?? sorted[0];
}

function parseGrantedScopes(scope: string | undefined): readonly string[] | undefined {
  if (scope === undefined) {
    return;
  }
  const scopes = scope.split(' ');
  if (
    scopes.length === 0 ||
    scopes.some((entry) => !OAUTH_SCOPE_TOKEN_PATTERN.test(entry)) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new Error('MCP OAuth granted scope is malformed.');
  }
  return scopes;
}

function projectMcpOAuthAuth(
  records: Readonly<Record<string, McpOAuthPersistedState>>,
  identity: McpOAuthStoreIdentity,
  requestedScopes: readonly string[],
  preferredIssuer?: string
): McpHostOAuthAuthSnapshot {
  const selected = latestOAuthRecord(records, preferredIssuer);
  const issuer = selected?.[0];
  const record = selected?.[1];
  const recordedScopes = parseGrantedScopes(record?.tokens?.scope);
  const grantedScopes = record?.tokens ? (recordedScopes ?? requestedScopes) : [];
  const authorizationServer =
    record?.discoveryState?.authorizationServerMetadata?.issuer ??
    record?.discoveryState?.authorizationServerUrl ??
    issuer;
  return {
    ...(authorizationServer ? { authorizationServer } : {}),
    credentialState: record?.tokens ? 'stored' : 'missing',
    grantedScopes,
    ...(record?.lastSuccessfulConnectionAt === undefined
      ? {}
      : { lastSuccessfulConnectionAt: record.lastSuccessfulConnectionAt }),
    requestedScopes: [...requestedScopes],
    resourceUrl: identity.resourceUrl,
    type: 'oauth-user',
  };
}

export async function readMcpOAuthAuthProjection(
  store: McpOAuthStore,
  identity: McpOAuthStoreIdentity,
  policy: { requestedScopes?: readonly string[] } = {}
): Promise<McpHostOAuthAuthSnapshot> {
  const requestedScopes = normalizeOAuthScopes(policy.requestedScopes);
  return projectMcpOAuthAuth(await store.read(identity), identity, requestedScopes);
}

function parseRecords(raw: string): Readonly<Record<string, McpOAuthPersistedState>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('MCP OAuth persisted state is malformed.', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
  for (const state of Object.values(parsed)) {
    validatePersistedRecord(state);
  }
  return parsed as Readonly<Record<string, McpOAuthPersistedState>>;
}

function parseEncryptedRecordMap(value: unknown): EncryptedStoreSchema['records'] {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error('MCP OAuth encrypted store is malformed.');
  }
  return value as EncryptedStoreSchema['records'];
}

function validatePersistedRecord(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value['updatedAt'] !== 'number' ||
    !Number.isSafeInteger(value['updatedAt'])
  ) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
  validatePersistedTokens(value['tokens']);
  validatePersistedClientInformation(value['clientInformation']);
  validatePersistedDiscoveryState(value['discoveryState']);
  const lastSuccessfulConnectionAt = value['lastSuccessfulConnectionAt'];
  if (
    lastSuccessfulConnectionAt !== undefined &&
    (typeof lastSuccessfulConnectionAt !== 'number' ||
      !Number.isSafeInteger(lastSuccessfulConnectionAt) ||
      lastSuccessfulConnectionAt < 0 ||
      lastSuccessfulConnectionAt > MAX_DATE_EPOCH_MS)
  ) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
}

function validatePersistedTokens(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
  if (typeof value['access_token'] !== 'string' || typeof value['token_type'] !== 'string') {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
  for (const field of ['refresh_token', 'scope', 'issuer']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error('MCP OAuth persisted state is malformed.');
    }
  }
}

function validatePersistedClientInformation(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value) || typeof value['client_id'] !== 'string') {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
}

function validatePersistedDiscoveryState(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (
    !isRecord(value) ||
    typeof value['authorizationServerUrl'] !== 'string' ||
    !URL.canParse(value['authorizationServerUrl'])
  ) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
}

export function createSafeStorageMcpOAuthStore(
  store: ElectronStore<EncryptedStoreSchema> = new ElectronStore<EncryptedStoreSchema>({
    name: 'brainstrike-mcp-oauth',
  }),
  storage: SafeStorageLike = safeStorage
): McpOAuthStore {
  const typedStore = store as ElectronStore<EncryptedStoreSchema> & {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  };
  let queueTail: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = queueTail.then(operation);
    queueTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  const result: McpOAuthStore = {
    async clear(identity) {
      const key = identityKey(identity);
      await enqueue(() => {
        const records = parseEncryptedRecordMap(typedStore.get('records'));
        if (!Object.hasOwn(records, key)) {
          return;
        }
        const next = { ...records };
        delete next[key];
        typedStore.set('records', next);
      });
    },
    async clearAll() {
      await enqueue(() => typedStore.set('records', {}));
    },
    async read(identity) {
      const key = identityKey(identity);
      return await enqueue(() => {
        const records = parseEncryptedRecordMap(typedStore.get('records'));
        const encrypted = records[key];
        if (encrypted === undefined) {
          return {};
        }
        assertSafeStorage(storage);
        return parseRecords(storage.decryptString(Buffer.from(encrypted, 'base64')));
      });
    },
    async write(identity, nextRecords) {
      const key = identityKey(identity);
      await enqueue(() => {
        assertSafeStorage(storage);
        const records = parseEncryptedRecordMap(typedStore.get('records'));
        const encrypted = storage.encryptString(JSON.stringify(nextRecords));
        const next = { ...records, [key]: encrypted.toString('base64') };
        typedStore.set('records', next);
      });
    },
  };
  encryptedStores.add(result);
  return result;
}

export function createLazySafeStorageMcpOAuthStore(
  createStore: () => McpOAuthStore = createSafeStorageMcpOAuthStore
): McpOAuthStore {
  let store: McpOAuthStore | undefined;
  const resolveStore = (): McpOAuthStore => {
    store ??= createStore();
    return store;
  };
  return {
    async clear(identity) {
      await resolveStore().clear(identity);
    },
    async clearAll() {
      await resolveStore().clearAll();
    },
    async read(identity) {
      return await resolveStore().read(identity);
    },
    async write(identity, records) {
      await resolveStore().write(identity, records);
    },
  };
}

export function createInMemoryMcpOAuthStore(): McpOAuthStore {
  const records = new Map<string, Readonly<Record<string, McpOAuthPersistedState>>>();
  return {
    async clear(identity) {
      records.delete(identityKey(identity));
    },
    async clearAll() {
      records.clear();
    },
    async read(identity) {
      return records.get(identityKey(identity)) ?? {};
    },
    async write(identity, nextRecords) {
      records.set(identityKey(identity), structuredClone(nextRecords));
    },
  };
}

interface LoopbackCallback {
  arm(expectedState: string): Promise<void>;
  cancel(): void;
  readonly close: () => Promise<void>;
  readonly redirectUrl: string;
  wait(): Promise<URLSearchParams>;
}

interface PendingCallback {
  readonly reject: (error: Error) => void;
  readonly resolve: (params: URLSearchParams) => void;
}

function applyCallbackHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
}

async function startLoopbackCallback(pathname: string): Promise<LoopbackCallback> {
  let port = 0;
  let expectedState: string | undefined;
  let pending: PendingCallback | undefined;
  let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let closed = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    applyCallbackHeaders(response);
    const host = request.headers.host;
    if (host !== `${LOOPBACK_HOST}:${port}` && host !== `localhost:${port}`) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid Host');
      return;
    }
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (request.method !== 'GET' || url.pathname !== pathname) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    if (Buffer.byteLength(url.href, 'utf8') > MAX_CALLBACK_URL_BYTES) {
      response
        .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Invalid callback');
      return;
    }
    if (expectedState === undefined || url.searchParams.get('state') !== expectedState) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid state');
      return;
    }
    response.writeHead(url.searchParams.has('code') ? 200 : 400, {
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(url.searchParams.has('code') ? 'Authorization received' : 'Authorization failed');
    if (settled) {
      return;
    }
    settled = true;
    const current = pending;
    pending = undefined;
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = undefined;
    }
    current?.resolve(new URLSearchParams(url.searchParams));
  });

  const teardown = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await teardown();
    throw new Error('MCP OAuth loopback server did not expose a bound port.');
  }
  port = address.port;

  return {
    arm: async (state) => {
      if (expectedState !== undefined && !settled) {
        throw new Error('MCP OAuth loopback callback is already armed.');
      }
      expectedState = state;
      settled = false;
    },
    cancel: () => {
      if (settled) {
        return;
      }
      settled = true;
      const current = pending;
      pending = undefined;
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = undefined;
      }
      current?.reject(new Error('MCP OAuth authorization was cancelled.'));
    },
    close: teardown,
    redirectUrl: `http://${LOOPBACK_HOST}:${port}${pathname}`,
    wait: () =>
      new Promise<URLSearchParams>((resolve, reject) => {
        if (settled) {
          reject(new Error('MCP OAuth callback wait is not active.'));
          return;
        }
        pending = { reject, resolve };
        pendingTimeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          pending = undefined;
          pendingTimeout = undefined;
          reject(new Error('MCP OAuth authorization callback timed out.'));
          void teardown();
        }, AUTHORIZATION_CALLBACK_TIMEOUT_MS);
      }),
  };
}

async function loadOAuthStartupState(
  store: McpOAuthStore,
  identity: McpOAuthStoreIdentity
): Promise<{
  callback: LoopbackCallback;
  persistedRecords: Readonly<Record<string, McpOAuthPersistedState>>;
}> {
  const [recordsResult, callbackResult] = await Promise.allSettled([
    store.read(identity),
    startLoopbackCallback(DEFAULT_CALLBACK_PATH),
  ]);
  if (recordsResult.status === 'fulfilled' && callbackResult.status === 'fulfilled') {
    return { callback: callbackResult.value, persistedRecords: recordsResult.value };
  }
  const failures: unknown[] = [];
  if (recordsResult.status === 'rejected') {
    failures.push(recordsResult.reason);
  }
  if (callbackResult.status === 'rejected') {
    failures.push(callbackResult.reason);
  } else {
    try {
      await callbackResult.value.close();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  throw new AggregateError(failures, 'MCP OAuth provider startup failed');
}

export interface McpOAuthClientProviderOptions {
  readonly clientMetadataUrl?: string;
  readonly clientName?: string;
  readonly fetchFn?: FetchLike;
  readonly openExternal: (url: string) => Promise<void>;
  readonly preRegisteredClient?: StoredOAuthClientInformation;
  readonly scopes?: readonly string[];
  readonly serverId: string;
  readonly serverUrl: string | URL;
  readonly store: McpOAuthStore;
}

export interface McpOAuthClientProvider extends OAuthClientProvider {
  authSnapshot(): McpHostOAuthAuthSnapshot;
  cancel(): Promise<void>;
  close(): Promise<McpOAuthCloseProof>;
  disconnect(): Promise<void>;
  readonly fetch: FetchLike;
  recordSuccessfulConnection(): Promise<void>;
  readonly redirectUrl: string;
  readonly waitForAuthorizationCallback: () => Promise<URLSearchParams>;
}

export interface McpOAuthCloseProof {
  readonly callbacksClosed: 1;
  readonly loopbackPortsClosed: 1;
}

export async function createMcpOAuthClientProvider(
  options: McpOAuthClientProviderOptions
): Promise<McpOAuthClientProvider> {
  const requestedScopes = normalizeOAuthScopes(options.scopes);
  const serverUrl = new URL(options.serverUrl);
  if (serverUrl.username.length > 0 || serverUrl.password.length > 0 || serverUrl.hash.length > 0) {
    throw new Error('MCP OAuth server URL must not contain credentials or a fragment.');
  }
  assertSecureOAuthUrl(serverUrl);
  validateClientMetadataUrl(options.clientMetadataUrl);
  const identity = createMcpOAuthStoreIdentity(options.serverId, serverUrl, requestedScopes);
  const resourceUrl = identity.resourceUrl;
  const { callback, persistedRecords } = await loadOAuthStartupState(options.store, identity);
  const records = new Map<string, McpOAuthPersistedState>(Object.entries(persistedRecords));
  let currentIssuer: string | undefined;
  let currentState: string | undefined;
  let authorizationCallback: Promise<URLSearchParams> | undefined;
  let closePromise: Promise<McpOAuthCloseProof> | undefined;
  let closed = false;
  let generation = 0;
  const tokenGenerations = new Map<string, number>();
  const tokenFlights = new Map<string, Promise<Response>>();
  let writeTail: Promise<void> = Promise.resolve();

  const assertOpen = (): void => {
    if (closed) {
      throw new Error('MCP OAuth client provider is closed.');
    }
  };

  const persist = (): Promise<void> => {
    const next = writeTail.then(async () => {
      await options.store.write(identity, Object.fromEntries(records));
    });
    writeTail = next.catch(() => undefined);
    return next;
  };

  const currentRecord = (): McpOAuthPersistedState => {
    if (currentIssuer === undefined) {
      throw new Error('MCP OAuth authorization-server issuer is not established.');
    }
    const existing = records.get(currentIssuer);
    if (existing) {
      return existing;
    }
    const created = { updatedAt: Date.now() } satisfies McpOAuthPersistedState;
    records.set(currentIssuer, created);
    return created;
  };

  const replaceCurrentRecord = (patch: Partial<McpOAuthPersistedState>): McpOAuthPersistedState => {
    const record = currentRecord();
    const next = { ...record, ...patch, updatedAt: Date.now() };
    records.set(currentIssuer as string, next);
    return next;
  };

  const clearCurrentRecordField = (
    field: 'clientInformation' | 'codeVerifier' | 'discoveryState' | 'tokens'
  ): void => {
    const next = { ...currentRecord(), updatedAt: Date.now() };
    delete next[field];
    records.set(currentIssuer as string, next);
  };

  const persistCurrentRecord = (): Promise<void> => {
    if (currentIssuer === undefined) {
      throw new Error('MCP OAuth authorization-server issuer is not established.');
    }
    return persist();
  };

  const fetchBase = options.fetchFn ?? fetch;
  const tokenTag = (accessToken: string): string =>
    createHash('sha256').update(accessToken, 'utf8').digest('hex');
  const recordTokenGeneration = async (
    response: Response,
    requestGeneration: number
  ): Promise<Response> => {
    const payload = (await response
      .clone()
      .json()
      .catch(() => undefined)) as unknown;
    const record = isRecord(payload) ? payload : undefined;
    if (typeof record?.['access_token'] === 'string') {
      tokenGenerations.set(tokenTag(record['access_token']), requestGeneration);
    }
    return response;
  };
  const fetchWithTokenFlight: FetchLike = async (input, init) => {
    assertOpen();
    assertSecureOAuthUrl(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const params = body === undefined ? undefined : new URLSearchParams(body);
    const grantType = params?.get('grant_type');
    const requestGeneration = generation;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return await fetchBase(input, init);
    }
    if (grantType === 'authorization_code') {
      return await recordTokenGeneration(await fetchBase(input, init), requestGeneration);
    }
    const url = String(input);
    const requestHeaders = new Headers(init?.headers);
    const key = `${url}\n${body}\n${requestHeaders.get('authorization') ?? ''}`;
    const existing = tokenFlights.get(key);
    const flight =
      existing ??
      fetchBase(input, init).then((response) => recordTokenGeneration(response, requestGeneration));
    if (!existing) {
      tokenFlights.set(key, flight);
      void flight.then(
        () => tokenFlights.delete(key),
        () => tokenFlights.delete(key)
      );
    }
    const response = await flight;
    return response.clone();
  };

  // biome-ignore-start lint/style/useNamingConvention: OAuth metadata uses RFC wire names.
  const clientMetadata: OAuthClientMetadata = {
    application_type: 'native',
    client_name: options.clientName ?? 'Brainstrike MCP Client',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: [callback.redirectUrl],
    response_types: ['code'],
    ...(requestedScopes.length > 0 ? { scope: requestedScopes.join(' ') } : {}),
    token_endpoint_auth_method: 'none',
  };
  // biome-ignore-end lint/style/useNamingConvention: OAuth metadata uses RFC wire names.

  const closeProvider = (): Promise<McpOAuthCloseProof> => {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    callback.cancel();
    closePromise = Promise.all([writeTail, callback.close()]).then(() => {
      liveProviders.delete(provider);
      return { callbacksClosed: 1, loopbackPortsClosed: 1 };
    });
    return closePromise;
  };

  const clearAllState = async (): Promise<void> => {
    generation += 1;
    callback.cancel();
    tokenFlights.clear();
    await writeTail;
    records.clear();
    currentIssuer = undefined;
    currentState = undefined;
    authorizationCallback = undefined;
    await options.store.clear(identity);
  };

  const provider: McpOAuthClientProvider = {
    authSnapshot() {
      return projectMcpOAuthAuth(
        Object.fromEntries(records),
        identity,
        requestedScopes,
        currentIssuer
      );
    },
    clientMetadata,
    ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    async cancel() {
      generation += 1;
      tokenGenerations.clear();
      await closeProvider();
    },
    async clientInformation(ctx?: OAuthClientInformationContext) {
      assertOpen();
      if (ctx) {
        currentIssuer = ctx.issuer;
      }
      if (currentIssuer === undefined) {
        return options.preRegisteredClient;
      }
      const stored = records.get(currentIssuer)?.clientInformation;
      if (stored) {
        return stored;
      }
      if (
        options.preRegisteredClient &&
        (options.preRegisteredClient.issuer === undefined ||
          options.preRegisteredClient.issuer === currentIssuer)
      ) {
        return options.preRegisteredClient.issuer === undefined && currentIssuer
          ? { ...options.preRegisteredClient, issuer: currentIssuer }
          : options.preRegisteredClient;
      }
      return;
    },
    async close() {
      return await closeProvider();
    },
    async codeVerifier() {
      assertOpen();
      return (
        currentRecord().codeVerifier ??
        (() => {
          throw new Error('MCP OAuth code verifier is unavailable.');
        })()
      );
    },
    async disconnect() {
      const closing = closeProvider();
      await clearAllState();
      tokenGenerations.clear();
      await closing;
    },
    async discoveryState() {
      if (currentIssuer !== undefined) {
        return records.get(currentIssuer)?.discoveryState;
      }
      return records.size === 1 ? records.values().next().value?.discoveryState : undefined;
    },
    fetch: fetchWithTokenFlight,
    async invalidateCredentials(scope) {
      assertOpen();
      if (scope === 'all') {
        await clearAllState();
        return;
      }
      if (currentIssuer === undefined) {
        return;
      }
      if (scope === 'client') {
        clearCurrentRecordField('clientInformation');
      }
      if (scope === 'tokens') {
        generation += 1;
        clearCurrentRecordField('tokens');
      }
      if (scope === 'verifier') {
        clearCurrentRecordField('codeVerifier');
      }
      if (scope === 'discovery') {
        clearCurrentRecordField('discoveryState');
      }
      await persist();
    },
    async recordSuccessfulConnection() {
      assertOpen();
      const selected = latestOAuthRecord(Object.fromEntries(records), currentIssuer);
      if (!selected?.[1].tokens) {
        throw new Error('MCP OAuth connection succeeded without stored credentials.');
      }
      currentIssuer = selected[0];
      replaceCurrentRecord({ lastSuccessfulConnectionAt: Date.now() });
      await persistCurrentRecord();
    },
    async redirectToAuthorization(authorizationUrl) {
      assertOpen();
      assertSecureOAuthUrl(authorizationUrl);
      const state = authorizationUrl.searchParams.get('state');
      if (!state || state !== currentState) {
        throw new Error('MCP OAuth authorization state was not bound to this client.');
      }
      await callback.arm(state);
      authorizationCallback = callback.wait();
      authorizationCallback.catch(() => undefined);
      await options.openExternal(authorizationUrl.toString());
    },
    redirectUrl: callback.redirectUrl,
    async resourceUrl() {
      return currentIssuer === undefined
        ? resourceUrl
        : (records.get(currentIssuer)?.resourceUrl ?? resourceUrl);
    },
    async saveClientInformation(info, ctx) {
      assertOpen();
      currentIssuer = ctx?.issuer ?? info.issuer;
      if (currentIssuer === undefined) {
        throw new Error('MCP OAuth client information has no issuer.');
      }
      replaceCurrentRecord({ clientInformation: info });
      await persist();
    },
    async saveCodeVerifier(value) {
      assertOpen();
      replaceCurrentRecord({ codeVerifier: value });
      await persistCurrentRecord();
    },
    async saveDiscoveryState(state) {
      assertOpen();
      currentIssuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
      replaceCurrentRecord({ discoveryState: state });
      await persist();
    },
    async saveResourceUrl(value) {
      assertOpen();
      replaceCurrentRecord({ resourceUrl: value });
      await persistCurrentRecord();
    },
    async saveTokens(tokens, ctx) {
      assertOpen();
      currentIssuer = ctx?.issuer ?? tokens.issuer;
      if (currentIssuer === undefined) {
        throw new Error('MCP OAuth tokens have no issuer.');
      }
      const tag = tokenTag(tokens.access_token);
      const tokenGeneration = tokenGenerations.get(tag);
      tokenGenerations.delete(tag);
      if (
        (tokenGeneration === undefined && generation !== 0) ||
        (tokenGeneration !== undefined && tokenGeneration !== generation)
      ) {
        return;
      }
      replaceCurrentRecord({ tokens });
      await persist();
    },
    state() {
      assertOpen();
      currentState = randomBytes(32).toString('base64url');
      return currentState;
    },
    async tokens(ctx) {
      if (ctx) {
        currentIssuer = ctx.issuer;
      }
      if (currentIssuer !== undefined) {
        return records.get(currentIssuer)?.tokens;
      }
      return records.size === 1 ? records.values().next().value?.tokens : undefined;
    },
    async validateResourceURL(server, resource) {
      const expected = resourceUrlFromServerUrl(server);
      if (
        resource &&
        !checkResourceAllowed({ configuredResource: resource, requestedResource: expected })
      ) {
        throw new Error('MCP OAuth protected-resource metadata does not match the MCP server URL.');
      }
      return expected;
    },
    waitForAuthorizationCallback: () => {
      if (authorizationCallback === undefined) {
        throw new Error('MCP OAuth authorization callback is not pending.');
      }
      return authorizationCallback;
    },
  };
  liveProviders.add(provider);
  return provider;
}

/** Clears every live MCP OAuth provider and encrypted MCP OAuth store. */
export async function purgeMcpOAuthRuntimeState(): Promise<void> {
  await Promise.all([...liveProviders].map(async (provider) => await provider.disconnect()));
  await Promise.all([...encryptedStores].map(async (store) => await store.clearAll()));
}
