import { createHash, randomBytes } from 'node:crypto';
import { addAbortListener } from 'node:events';
import {
  joinCredentialCleanup,
  observeCredentialCancellation,
} from '@brainstrike/agent-host/credential-contract';
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
import { McpLifecycleFailure } from './lifecycle-errors';
import {
  persistedClientSupportsRedirect,
  reportLoopbackListenerBound,
  reportStaleDynamicClientRegistration,
} from './oauth-client-registration';
import {
  DEFAULT_CALLBACK_PATH,
  type LoopbackCallback,
  startLoopbackCallback,
} from './oauth-loopback-callback';

const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
const MIN_LOOPBACK_PORT = 1;
const MAX_LOOPBACK_PORT = 65_535;
export interface McpOAuthPersistedState {
  clientInformation?: StoredOAuthClientInformation;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastSuccessfulConnectionAt?: number;
  /** Reuse this port on restart so the registered loopback redirect URI remains identical. */
  loopbackPort?: number;
  resourceUrl?: string;
  tokens?: StoredOAuthTokens;
  updatedAt: number;
}
export type McpOAuthRecords = Readonly<Record<string, McpOAuthPersistedState>>;
export interface McpOAuthStoreIdentity {
  readonly resourceUrl: string;
  readonly scopeKey: string;
  readonly serverId: string;
}

export interface McpOAuthStore {
  clear(identity: McpOAuthStoreIdentity, signal?: AbortSignal): Promise<void>;
  clearAll(signal?: AbortSignal): Promise<void>;
  /** Actual persistence completion; aborting a caller does not satisfy this join. */
  join?(): Promise<void>;
  read(identity: McpOAuthStoreIdentity, signal?: AbortSignal): Promise<McpOAuthRecords>;
  write(
    identity: McpOAuthStoreIdentity,
    records: McpOAuthRecords,
    signal?: AbortSignal
  ): Promise<void>;
}

export interface EncryptedStoreSchema {
  records: Record<string, string>;
}

const encryptedStores = new Set<McpOAuthStore>();
const liveProviders = new Set<McpOAuthClientProvider>();

export function registerMcpOAuthStore(store: McpOAuthStore): () => void {
  encryptedStores.add(store);
  return () => {
    encryptedStores.delete(store);
  };
}

export interface McpOAuthSafeStorage {
  decryptStringAsync(
    value: Buffer
  ): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
  encryptStringAsync(value: string): Promise<Buffer>;
  getSelectedStorageBackend?(): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
}

export interface McpOAuthEncryptedStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertSafeStorage(storage: McpOAuthSafeStorage): Promise<void> {
  if (
    !(await storage.isAsyncEncryptionAvailable()) ||
    storage.getSelectedStorageBackend?.() === 'basic_text'
  ) {
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

export function identityKey(identity: McpOAuthStoreIdentity): string {
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

function byOAuthRecordRecency(left: McpOAuthPersistedState, right: McpOAuthPersistedState): number {
  const successfulConnectionDelta =
    (right.lastSuccessfulConnectionAt ?? -1) - (left.lastSuccessfulConnectionAt ?? -1);
  return successfulConnectionDelta || right.updatedAt - left.updatedAt;
}

function latestOAuthRecord(
  records: McpOAuthRecords,
  preferredIssuer?: string
): readonly [string, McpOAuthPersistedState] | undefined {
  if (preferredIssuer !== undefined) {
    const preferred = records[preferredIssuer];
    if (preferred) {
      return [preferredIssuer, preferred];
    }
  }
  const sorted = Object.entries(records).sort((left, right) =>
    byOAuthRecordRecency(left[1], right[1])
  );
  return sorted.find(([, record]) => record.tokens !== undefined) ?? sorted[0];
}

/** Records share one listener; the latest persisted port wins for legacy records. */
function persistedLoopbackPort(records: McpOAuthRecords): number | undefined {
  return Object.values(records)
    .sort(byOAuthRecordRecency)
    .map((record) => record.loopbackPort)
    .find((port) => port !== undefined);
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
  records: McpOAuthRecords,
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

export function parseRecords(raw: string): McpOAuthRecords {
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
  return parsed as McpOAuthRecords;
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
  validatePersistedLoopbackPort(value['loopbackPort']);
}

function validatePersistedLoopbackPort(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < MIN_LOOPBACK_PORT ||
      value > MAX_LOOPBACK_PORT)
  ) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
}

function validatePersistedTokens(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (
    !isRecord(value) ||
    typeof value['access_token'] !== 'string' ||
    typeof value['token_type'] !== 'string'
  ) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
  for (const field of ['refresh_token', 'scope', 'issuer']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error('MCP OAuth persisted state is malformed.');
    }
  }
}

function validatePersistedClientInformation(value: unknown): void {
  if (value !== undefined && (!isRecord(value) || typeof value['client_id'] !== 'string')) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
}

function validatePersistedDiscoveryState(value: unknown): void {
  if (
    value !== undefined &&
    (!isRecord(value) ||
      typeof value['authorizationServerUrl'] !== 'string' ||
      !URL.canParse(value['authorizationServerUrl']))
  ) {
    throw new Error('MCP OAuth persisted state is malformed.');
  }
}

export function createSafeStorageMcpOAuthStore(
  store: McpOAuthEncryptedStore,
  storage: McpOAuthSafeStorage
): McpOAuthStore {
  let queueTail: Promise<void> = Promise.resolve();
  const cancelledNativeFailures: unknown[] = [];

  function enqueue<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const result = queueTail
      .then(() => {
        signal?.throwIfAborted();
        return operation();
      })
      .catch((error: unknown) => {
        if (signal?.aborted && error !== signal.reason) {
          cancelledNativeFailures.push(error);
        }
        throw error;
      });
    queueTail = result.then(() => undefined).catch(() => undefined);
    return observeCredentialCancellation(result, signal);
  }

  const result: McpOAuthStore = {
    async clear(identity, signal) {
      const key = identityKey(identity);
      await enqueue(() => {
        const records = parseEncryptedRecordMap(store.get('records'));
        if (!Object.hasOwn(records, key)) {
          return;
        }
        const next = { ...records };
        delete next[key];
        store.set('records', next);
      }, signal);
    },
    async clearAll(signal) {
      await enqueue(() => store.set('records', {}), signal);
    },
    async join() {
      await queueTail;
      if (cancelledNativeFailures.length > 0) {
        throw new AggregateError(
          [...cancelledNativeFailures],
          'MCP OAuth persistence completed with failures after caller cancellation.'
        );
      }
    },
    async read(identity, signal) {
      const key = identityKey(identity);
      return await enqueue(async () => {
        const records = parseEncryptedRecordMap(store.get('records'));
        const encrypted = records[key];
        if (encrypted === undefined) {
          return {};
        }
        await assertSafeStorage(storage);
        signal?.throwIfAborted();
        const { result: plaintext } = await storage.decryptStringAsync(
          Buffer.from(encrypted, 'base64')
        );
        signal?.throwIfAborted();
        return parseRecords(plaintext);
      }, signal);
    },
    async write(identity, nextRecords, signal) {
      const key = identityKey(identity);
      await enqueue(async () => {
        // Async native encryption preserves the OS boundary without blocking the protocol lane.
        await assertSafeStorage(storage);
        signal?.throwIfAborted();
        const records = parseEncryptedRecordMap(store.get('records'));
        const encrypted = await storage.encryptStringAsync(JSON.stringify(nextRecords));
        signal?.throwIfAborted();
        const next = { ...records, [key]: encrypted.toString('base64') };
        store.set('records', next);
      }, signal);
    },
  };
  registerMcpOAuthStore(result);
  return result;
}

export function createLazySafeStorageMcpOAuthStore(
  createStore: () => McpOAuthStore | Promise<McpOAuthStore>
): McpOAuthStore {
  let store: McpOAuthStore | undefined;
  let pending: Promise<McpOAuthStore> | undefined;
  const resolveStore = (): Promise<McpOAuthStore> => {
    if (store) {
      return Promise.resolve(store);
    }
    pending ??= Promise.resolve()
      .then(createStore)
      .then(
        (created) => {
          store = created;
          pending = undefined;
          return created;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        }
      );
    return pending;
  };
  const resolveForOperation = async (signal?: AbortSignal): Promise<McpOAuthStore> => {
    signal?.throwIfAborted();
    const resolved = await observeCredentialCancellation(resolveStore(), signal);
    signal?.throwIfAborted();
    return resolved;
  };
  return {
    async clear(identity, signal) {
      await (await resolveForOperation(signal)).clear(identity, signal);
    },
    async clearAll(signal) {
      await (await resolveForOperation(signal)).clearAll(signal);
    },
    async join() {
      const resolved = store ?? (pending ? await pending : undefined);
      await resolved?.join?.();
    },
    async read(identity, signal) {
      return await (await resolveForOperation(signal)).read(identity, signal);
    },
    async write(identity, records, signal) {
      await (await resolveForOperation(signal)).write(identity, records, signal);
    },
  };
}

export function createInMemoryMcpOAuthStore(): McpOAuthStore {
  const records = new Map<string, McpOAuthRecords>();
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

/** Read the persisted port before binding the callback listener. */
async function loadOAuthStartupState(
  store: McpOAuthStore,
  identity: McpOAuthStoreIdentity,
  signal?: AbortSignal
): Promise<{
  callback: LoopbackCallback;
  persistedRecords: McpOAuthRecords;
}> {
  signal?.throwIfAborted();
  const persistedRecords = await store.read(identity, signal);
  signal?.throwIfAborted();
  const callback = await startLoopbackCallback(
    DEFAULT_CALLBACK_PATH,
    persistedLoopbackPort(persistedRecords)
  );
  if (signal?.aborted) {
    await callback.close();
    signal.throwIfAborted();
  }
  return { callback, persistedRecords };
}

export interface McpOAuthClientProviderOptions {
  /** False for stored-credential reconnects; never launch interactive consent from startup. */
  readonly allowInteractiveAuthorization?: boolean;
  readonly clientMetadataUrl?: string;
  readonly clientName?: string;
  readonly fetchFn?: FetchLike;
  readonly openExternal: (url: string) => Promise<void>;
  readonly preRegisteredClient?: StoredOAuthClientInformation;
  readonly scopes?: readonly string[];
  readonly serverId: string;
  readonly serverUrl: string | URL;
  readonly signal?: AbortSignal;
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
  /** Redirect mismatch or browser consent requires explicit reauthorization, not transport repair. */
  requiresReauthorization(): boolean;
  takePendingAuthorizationCallback(signal: AbortSignal): Promise<URLSearchParams> | undefined;
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
  const { callback, persistedRecords } = await loadOAuthStartupState(
    options.store,
    identity,
    options.signal
  );
  const records = new Map<string, McpOAuthPersistedState>(Object.entries(persistedRecords));
  const loopbackPort = callback.port;
  reportLoopbackListenerBound({
    port: loopbackPort,
    reusedPersistedPort: persistedLoopbackPort(persistedRecords) === loopbackPort,
    server: options.serverId,
  });
  let staleRegistrationDiscarded = false;
  // Providers belong to one connection attempt; this latch never crosses retries.
  let interactiveAuthorizationRequired = false;
  let currentIssuer: string | undefined;
  let currentState: string | undefined;
  const staleDiscoveryByIssuer = new Map<string, OAuthDiscoveryState | undefined>();
  let authorizationCallback: Promise<URLSearchParams> | undefined;
  let closePromise: Promise<McpOAuthCloseProof> | undefined;
  let closed = false;
  let generation = 0;
  const tokenGenerations = new Map<string, number>();
  const tokenFlights = new Map<string, Promise<Response>>();
  let writeTail: Promise<void> = Promise.resolve();
  const persistence = new AbortController();
  let actorAbortListener: ReturnType<typeof addAbortListener> | undefined;

  const assertOpen = (): void => {
    if (closed) {
      throw new Error('MCP OAuth client provider is closed.');
    }
    persistence.signal.throwIfAborted();
  };

  const persist = (): Promise<void> => {
    const next = writeTail.then(async () => {
      persistence.signal.throwIfAborted();
      await options.store.write(identity, Object.fromEntries(records), persistence.signal);
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
    const created = { loopbackPort, updatedAt: Date.now() } satisfies McpOAuthPersistedState;
    records.set(currentIssuer, created);
    return created;
  };

  const replaceCurrentRecord = (patch: Partial<McpOAuthPersistedState>): McpOAuthPersistedState => {
    const record = currentRecord();
    const next = { ...record, ...patch, loopbackPort, updatedAt: Date.now() };
    records.set(currentIssuer as string, next);
    return next;
  };

  const clearCurrentRecordField = (
    field: 'clientInformation' | 'codeVerifier' | 'discoveryState' | 'tokens'
  ): void => {
    const next = { ...currentRecord(), loopbackPort, updatedAt: Date.now() };
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
    persistence.abort();
    actorAbortListener?.[Symbol.dispose]();
    staleDiscoveryByIssuer.clear();
    callback.cancel();
    closePromise = joinCredentialCleanup(
      [
        writeTail,
        options.store.join?.() ?? Promise.resolve(),
        callback.close().then(() => liveProviders.delete(provider)),
      ],
      'MCP OAuth persistence or callback cleanup failed.'
    ).then(() => ({
      callbacksClosed: 1,
      loopbackPortsClosed: 1,
    }));
    return closePromise;
  };

  const clearAllState = async (): Promise<void> => {
    generation += 1;
    callback.cancel();
    tokenFlights.clear();
    await writeTail;
    records.clear();
    staleDiscoveryByIssuer.clear();
    staleRegistrationDiscarded = false;
    interactiveAuthorizationRequired = false;
    currentIssuer = undefined;
    currentState = undefined;
    authorizationCallback = undefined;
    await options.store.clear(identity);
  };

  const takeAuthorizationCallback = (): Promise<URLSearchParams> | undefined => {
    const pending = authorizationCallback;
    authorizationCallback = undefined;
    return pending;
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
      if (stored && persistedClientSupportsRedirect(stored, callback.redirectUrl)) {
        return stored;
      }
      if (stored) {
        // Redirect mismatch requires a new DCR and explicit reconnect.
        staleRegistrationDiscarded = true;
        reportStaleDynamicClientRegistration(currentIssuer);
        clearCurrentRecordField('clientInformation');
        await persistCurrentRecord();
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
      const issuer =
        currentIssuer ?? (records.size === 1 ? records.keys().next().value : undefined);
      const discoveryState = issuer === undefined ? undefined : records.get(issuer)?.discoveryState;
      if (
        issuer !== undefined &&
        staleDiscoveryByIssuer.has(issuer) &&
        staleDiscoveryByIssuer.get(issuer) === discoveryState
      ) {
        return;
      }
      if (issuer !== undefined && discoveryState !== undefined) {
        currentIssuer = issuer;
      }
      return discoveryState;
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
      if (options.allowInteractiveAuthorization !== true) {
        interactiveAuthorizationRequired = true;
        throw new McpLifecycleFailure('authentication', 'mcp-authentication-required');
      }
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
    requiresReauthorization() {
      return staleRegistrationDiscarded || interactiveAuthorizationRequired;
    },
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
      const issuer = ctx?.issuer ?? tokens.issuer;
      if (issuer === undefined) {
        throw new Error('MCP OAuth tokens have no issuer.');
      }
      currentIssuer = issuer;
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
      staleDiscoveryByIssuer.delete(issuer);
    },
    state() {
      assertOpen();
      currentState = randomBytes(32).toString('base64url');
      return currentState;
    },
    takePendingAuthorizationCallback(signal) {
      const pending = takeAuthorizationCallback();
      if (pending === undefined) {
        return;
      }
      const wrapped = new Promise<URLSearchParams>((resolve, reject) => {
        let settled = false;
        const settle = (action: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener('abort', rejectCancellation);
          action();
        };
        const rejectCancellation = (): void => {
          settle(() => {
            callback.cancel();
            reject(new Error('MCP OAuth authorization callback was cancelled.'));
          });
        };
        signal.addEventListener('abort', rejectCancellation, { once: true });
        if (signal.aborted) {
          rejectCancellation();
        }
        void pending.then(
          (params) => settle(() => resolve(params)),
          (error: unknown) => settle(() => reject(error))
        );
      });
      void wrapped.catch(() => undefined);
      return wrapped;
    },
    async tokens(ctx) {
      if (ctx) {
        currentIssuer = ctx.issuer;
      }
      const issuer =
        currentIssuer ?? (records.size === 1 ? records.keys().next().value : undefined);
      const tokens = issuer === undefined ? undefined : records.get(issuer)?.tokens;
      if (ctx === undefined && issuer !== undefined && tokens !== undefined) {
        staleDiscoveryByIssuer.set(issuer, records.get(issuer)?.discoveryState);
      }
      return tokens;
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
  };
  if (options.signal) {
    actorAbortListener = addAbortListener(options.signal, () => {
      generation += 1;
      tokenGenerations.clear();
      persistence.abort(options.signal?.reason);
      callback.cancel();
    });
    if (options.signal.aborted) {
      await provider.close();
      options.signal.throwIfAborted();
    }
  }
  liveProviders.add(provider);
  return provider;
}
/** Clears every live MCP OAuth provider and encrypted MCP OAuth store. */
export async function purgeMcpOAuthRuntimeState(): Promise<void> {
  await joinCredentialCleanup(
    [...liveProviders].map(async (provider) => await provider.disconnect()),
    'MCP OAuth reset completed with failures.',
    () => [...encryptedStores].map(async (store) => await store.clearAll())
  );
}
