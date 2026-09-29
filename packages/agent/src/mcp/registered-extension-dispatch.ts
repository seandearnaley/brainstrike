import {
  type JSONRPCMessage,
  parseJSONRPCMessage,
  SUBSCRIPTION_ID_META_KEY,
  type Transport,
} from '@modelcontextprotocol/client';
import type { McpClientExtensionRegistry } from './client-extension-registry';

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';
const PROTOCOL_OWNED_HEADERS = new Set([
  'accept',
  'content-type',
  'last-event-id',
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version',
  'mcp-session-id',
]);

type McpHttpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

const SUBSCRIPTIONS_LISTEN_METHOD = 'subscriptions/listen';
const SUBSCRIPTIONS_ACKNOWLEDGED_METHOD = 'notifications/subscriptions/acknowledged';

/**
 * One connection's observation of the server's raw
 * `notifications/subscriptions/acknowledged` payload for a single
 * `subscriptions/listen` request. The SDK settles `McpSubscription.honoredFilter`
 * from the CORE `SubscriptionFilter` schema, which strips every extension field
 * (the Tasks `taskIds` among them), so an extension lease can only learn what the
 * server honored from the raw notification this capture holds.
 */
export interface McpSubscriptionAcknowledgementCapture {
  /** True once the acknowledgement for the claimed listen request was seen. */
  readonly acknowledged: boolean;
  /** Raw `params.notifications` of the acknowledgement, before core stripping. */
  readonly acknowledgement: unknown;
  /** Drops the claim. Idempotent; required once the lease has read the ack. */
  release(): void;
}

class SubscriptionAcknowledgementClaim implements McpSubscriptionAcknowledgementCapture {
  acknowledgement: unknown = undefined;
  acknowledged = false;
  /** The scope map holding this claim once a transport bound it, for release. */
  boundClaims: Map<string, SubscriptionAcknowledgementClaim> | undefined = undefined;
  subscriptionId: string | undefined = undefined;

  constructor(
    readonly filter: object,
    private readonly onRelease: (claim: SubscriptionAcknowledgementClaim) => void
  ) {}

  release(): void {
    this.onRelease(this);
  }
}

function readNotificationSubscriptionId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return;
  }
  const meta = Reflect.get(params, '_meta');
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return;
  }
  const subscriptionId = Reflect.get(meta, SUBSCRIPTION_ID_META_KEY);
  if (typeof subscriptionId === 'string' || typeof subscriptionId === 'number') {
    return String(subscriptionId);
  }
  return;
}

function readListenFilter(params: unknown): object | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return;
  }
  const filter = Reflect.get(params, 'notifications');
  return typeof filter === 'object' && filter !== null ? filter : undefined;
}

/**
 * One transport's ownership slice of a {@link RegisteredExtensionDispatchLedger}.
 * The HTTP client builds its header-preserving fetch once per CLIENT, so the
 * ledger that fetch queries has to outlive every transport the client installs
 * (reconnect, session reset, auth step-up retry all build a new one). Ownership
 * therefore lives here, not on the ledger: closing a transport drops only what
 * that transport recorded, so a sibling transport's in-flight dispatch and its
 * bound subscription claim survive it. Subscription ids are JSON-RPC request
 * ids, which restart on every new connection, so they are unique only per scope.
 */
export interface RegisteredExtensionDispatchScope {
  /**
   * Binds a claimed listen filter to the request id the SDK allocated for it.
   * The SDK passes the caller's filter object through to the transport untouched,
   * so object identity — not ordering — correlates the claim to its request id.
   */
  bindSubscriptionRequest(requestId: string | number, params: unknown): void;
  /** Drops this transport's entries; nothing can answer after its close. */
  clear(): void;
  /** Records the raw acknowledgement payload for a bound listen request. */
  recordSubscriptionAcknowledgement(params: unknown): void;
  releaseDispatchedRequest(requestId: string | number): void;
  trackDispatchedRequest(requestId: string | number): void;
}

/**
 * Registered-extension dispatch state for one client, read by the header bridge
 * and written through a per-transport {@link RegisteredExtensionDispatchScope}.
 * It carries exactly two facts, both only observable at the raw-wire seam the
 * bridge already owns:
 *
 * - the request ids currently in flight through registered dispatch, so a
 *   registered wire method that is also a core method (`tools/call`) is only
 *   treated as an extension request when its id is recorded here; core traffic
 *   on the same connection passes the HTTP bridge untouched;
 * - the raw `notifications/subscriptions/acknowledged` payload for a claimed
 *   `subscriptions/listen` request, which the SDK strips to the core
 *   `SubscriptionFilter` before any consumer can read it.
 */
export class RegisteredExtensionDispatchLedger {
  private readonly claimsByFilter = new Map<object, SubscriptionAcknowledgementClaim>();
  private readonly liveDispatchedRequestIds = new Set<ReadonlySet<string | number>>();

  hasDispatchedRequest(requestId: string | number): boolean {
    for (const dispatchedRequestIds of this.liveDispatchedRequestIds) {
      if (dispatchedRequestIds.has(requestId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Claims the acknowledgement of the `subscriptions/listen` request that will
   * carry `filter` as its `params.notifications`. Claiming precedes the send, so
   * it is client-scoped; the transport that sends the request takes ownership.
   */
  captureSubscriptionAcknowledgement(filter: object): McpSubscriptionAcknowledgementCapture {
    if (this.claimsByFilter.has(filter)) {
      throw new Error('MCP subscription acknowledgement filter is already claimed');
    }
    const claim = new SubscriptionAcknowledgementClaim(filter, (released) => {
      this.claimsByFilter.delete(released.filter);
      if (released.subscriptionId !== undefined) {
        released.boundClaims?.delete(released.subscriptionId);
      }
      released.boundClaims = undefined;
    });
    this.claimsByFilter.set(filter, claim);
    return claim;
  }

  /** Opens the ownership slice for one newly allocated transport. */
  openTransportScope(): RegisteredExtensionDispatchScope {
    const dispatchedRequestIds = new Set<string | number>();
    const claimsBySubscriptionId = new Map<string, SubscriptionAcknowledgementClaim>();
    this.liveDispatchedRequestIds.add(dispatchedRequestIds);
    return {
      bindSubscriptionRequest: (requestId, params) => {
        const filter = readListenFilter(params);
        if (filter === undefined) {
          return;
        }
        const claim = this.claimsByFilter.get(filter);
        if (claim === undefined) {
          return;
        }
        claim.subscriptionId = String(requestId);
        claim.boundClaims = claimsBySubscriptionId;
        claimsBySubscriptionId.set(claim.subscriptionId, claim);
      },
      clear: () => {
        dispatchedRequestIds.clear();
        this.liveDispatchedRequestIds.delete(dispatchedRequestIds);
        for (const claim of claimsBySubscriptionId.values()) {
          this.claimsByFilter.delete(claim.filter);
          claim.boundClaims = undefined;
        }
        claimsBySubscriptionId.clear();
      },
      recordSubscriptionAcknowledgement: (params) => {
        const subscriptionId = readNotificationSubscriptionId(params);
        if (subscriptionId === undefined) {
          return;
        }
        const claim = claimsBySubscriptionId.get(subscriptionId);
        if (claim === undefined || claim.acknowledged) {
          return;
        }
        claim.acknowledged = true;
        claim.acknowledgement = Reflect.get(params as object, 'notifications');
      },
      releaseDispatchedRequest: (requestId) => {
        dispatchedRequestIds.delete(requestId);
      },
      trackDispatchedRequest: (requestId) => {
        // Re-arm after a close so a late dispatch stays visible to the bridge
        // rather than silently degrading to core traffic.
        this.liveDispatchedRequestIds.add(dispatchedRequestIds);
        dispatchedRequestIds.add(requestId);
      },
    };
  }
}

function validateConfiguredHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    const lowerName = name.toLowerCase();
    if (PROTOCOL_OWNED_HEADERS.has(lowerName) || lowerName.startsWith('mcp-param-')) {
      throw new Error(`Configured MCP header "${name}" is protocol-owned`);
    }
  }
}

export function createHeaderPreservingFetch(
  baseFetch: McpHttpFetch,
  headers: Readonly<Record<string, string>> | undefined,
  extensionRegistry: McpClientExtensionRegistry | undefined,
  getAuthorizationSignal?: () => AbortSignal | undefined,
  dispatchLedger?: RegisteredExtensionDispatchLedger
): McpHttpFetch {
  validateConfiguredHeaders(headers);
  const callerHeaders = new Headers(headers);
  return async (url, init) => {
    const mergedHeaders = new Headers(callerHeaders);
    const protocolHeaders = new Headers(init?.headers);
    protocolHeaders.forEach((value, name) => {
      const configuredValue = mergedHeaders.get(name);
      if (configuredValue !== null && configuredValue !== value) {
        throw new Error(
          `Configured MCP header "${name}" conflicts with the transport-required value`
        );
      }
      mergedHeaders.set(name, value);
    });
    const authorizationSignal = getAuthorizationSignal?.();
    const signal = authorizationSignal
      ? init?.signal
        ? AbortSignal.any([init.signal, authorizationSignal])
        : authorizationSignal
      : init?.signal;
    const requestInit = {
      ...init,
      headers: mergedHeaders,
      ...(signal === undefined ? {} : { signal }),
    };
    return baseFetch(
      url,
      applyRegisteredExtensionHttpHeaders(requestInit, extensionRegistry, dispatchLedger)
    );
  };
}

function needsBase64(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return true;
  }
  if (value !== value.trim()) {
    return true;
  }
  for (const character of value) {
    const codeUnit = character.charCodeAt(0);
    if (codeUnit === 0x09 || (codeUnit >= 0x20 && codeUnit <= 0x7e)) {
      continue;
    }
    return true;
  }
  return false;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

/**
 * SEP-2243 field-value encoding, source-linked to upstream SDK commit:
 * https://github.com/modelcontextprotocol/typescript-sdk/commit/70de0c8b569b0d664a56b90be2f141d1d1645880
 * Retire this copy when a released @modelcontextprotocol/client exports it.
 */
export function encodeMcpHeaderValue(value: string): string {
  if (!needsBase64(value)) {
    return value;
  }
  return `${BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${BASE64_SENTINEL_SUFFIX}`;
}

/**
 * A locally abandoned request (timeout, abort) never gets a response; the SDK
 * announces it with notifications/cancelled, which is the only signal this
 * layer sees, so release the pending result type there.
 */
function releaseCancelledResultType(
  message: JSONRPCMessage,
  pendingResultTypes: Map<string | number, string>
): void {
  if ('id' in message || !('method' in message) || message.method !== 'notifications/cancelled') {
    return;
  }
  const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
  if (typeof requestId === 'string' || typeof requestId === 'number') {
    pendingResultTypes.delete(requestId);
  }
}

/**
 * Records the pending extension result type for an outgoing request and reports
 * whether the registry rewrote it (`dispatchedId`), i.e. it is a registered
 * extension request rather than core traffic on a shared wire method.
 */
function trackOutgoingRequest(
  message: JSONRPCMessage,
  outgoing: JSONRPCMessage,
  registry: McpClientExtensionRegistry,
  pendingResultTypes: Map<string | number, string>
): { dispatchedId: string | number | undefined; requestId: string | number | undefined } {
  if (!('id' in message && 'method' in message)) {
    return { dispatchedId: undefined, requestId: undefined };
  }
  const requestId = message.id;
  pendingResultTypes.delete(requestId);
  const extensionResultType = registry.resolveOutgoingResultType(message);
  if (extensionResultType !== undefined) {
    pendingResultTypes.set(requestId, extensionResultType);
  }
  const dispatched = 'method' in outgoing && outgoing.method !== message.method;
  return { dispatchedId: dispatched ? requestId : undefined, requestId };
}

/**
 * Installs a closed registered-extension bridge on a newly allocated, client-owned transport.
 * The SDK sees a non-colliding custom method; only an exact registered contract is rewritten to
 * its official wire method before the transport serializes it.
 */
export function installRegisteredExtensionDispatch<OwnedTransport extends Transport>(
  transport: OwnedTransport,
  registry: McpClientExtensionRegistry | undefined,
  dispatchLedger?: RegisteredExtensionDispatchLedger
): OwnedTransport {
  if (registry === undefined) {
    return transport;
  }
  const dispatchScope = dispatchLedger?.openTransportScope();
  const pendingResultTypes = new Map<string | number, string>();
  const activeMessages = new WeakSet<object>();
  let downstreamOnMessage = transport.onmessage;
  const rewriteIncoming: NonNullable<typeof transport.onmessage> = (incoming, extra) => {
    if (activeMessages.has(incoming)) {
      return;
    }
    const isResponse = 'id' in incoming && ('result' in incoming || 'error' in incoming);
    const responseId = isResponse ? incoming.id : undefined;
    let extensionResultType: string | undefined;
    if (typeof responseId === 'string' || typeof responseId === 'number') {
      extensionResultType = pendingResultTypes.get(responseId);
      pendingResultTypes.delete(responseId);
    }
    if (
      !('id' in incoming) &&
      'method' in incoming &&
      incoming.method === SUBSCRIPTIONS_ACKNOWLEDGED_METHOD
    ) {
      dispatchScope?.recordSubscriptionAcknowledgement(incoming.params);
    }
    if (downstreamOnMessage === undefined) {
      throw new Error('MCP transport received a message before its SDK handler was registered');
    }
    const rewritten = registry.rewriteIncomingMessage(incoming, extensionResultType);
    activeMessages.add(rewritten);
    try {
      downstreamOnMessage(rewritten, extra);
    } finally {
      activeMessages.delete(rewritten);
    }
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => rewriteIncoming,
    set: (next: typeof transport.onmessage) => {
      if (next !== rewriteIncoming) {
        downstreamOnMessage = next;
      }
    },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const outgoing = registry.rewriteOutgoingMessage(message);
    releaseCancelledResultType(message, pendingResultTypes);
    const { dispatchedId, requestId } = trackOutgoingRequest(
      message,
      outgoing,
      registry,
      pendingResultTypes
    );
    if (dispatchedId !== undefined) {
      dispatchScope?.trackDispatchedRequest(dispatchedId);
    }
    if (
      dispatchScope !== undefined &&
      'id' in message &&
      'method' in message &&
      message.method === SUBSCRIPTIONS_LISTEN_METHOD
    ) {
      dispatchScope.bindSubscriptionRequest(message.id, message.params);
    }
    try {
      await send(outgoing, options);
    } catch (error) {
      if (requestId !== undefined) {
        pendingResultTypes.delete(requestId);
      }
      throw error;
    } finally {
      if (dispatchedId !== undefined) {
        dispatchScope?.releaseDispatchedRequest(dispatchedId);
      }
    }
  };
  const close = transport.close.bind(transport);
  transport.close = async () => {
    // Nothing can answer after close; a reconnect must not inherit the map.
    // The ledger can be client-scoped (HTTP builds one fetch for every transport
    // it installs), so drop only what THIS transport recorded.
    pendingResultTypes.clear();
    dispatchScope?.clear();
    await close();
  };
  return transport;
}

function parseRequestBody(body: BodyInit | null | undefined): JSONRPCMessage | undefined {
  if (typeof body !== 'string') {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  try {
    return parseJSONRPCMessage(parsed);
  } catch {
    return;
  }
}

function isRegisteredExtensionMethod(
  registry: McpClientExtensionRegistry,
  method: string,
  requestId: string | number | undefined,
  dispatchLedger: RegisteredExtensionDispatchLedger | undefined
): boolean {
  if (!registry.hasWireRequestMethod(method)) {
    return false;
  }
  if (!registry.sharesCoreWireMethod(method)) {
    return true;
  }
  return requestId !== undefined && dispatchLedger?.hasDispatchedRequest(requestId) === true;
}

/**
 * Adds the extension-defined Mcp-Name standard header after SDK body serialization.
 * Acts only on registered-extension requests: an exclusive extension wire method
 * (body or `Mcp-Method` header), or the core-shared `tools/call` when the body id is
 * in the dispatch ledger. Every other request, including bodiless GET/DELETE and
 * auth retries of core traffic, passes through untouched.
 */
export function applyRegisteredExtensionHttpHeaders(
  init: RequestInit | undefined,
  registry: McpClientExtensionRegistry | undefined,
  dispatchLedger?: RegisteredExtensionDispatchLedger
): RequestInit | undefined {
  if (registry === undefined) {
    return init;
  }
  const headers = new Headers(init?.headers);
  const headerMethod = headers.get('mcp-method');
  const message = parseRequestBody(init?.body);
  const requestId = message && 'id' in message && 'method' in message ? message.id : undefined;
  const candidateBodyMethod = message && 'method' in message ? message.method : undefined;
  const bodyIsRegistered =
    candidateBodyMethod !== undefined &&
    isRegisteredExtensionMethod(registry, candidateBodyMethod, requestId, dispatchLedger);
  const headerIsRegistered =
    headerMethod !== null &&
    isRegisteredExtensionMethod(registry, headerMethod, requestId, dispatchLedger);
  if (!(bodyIsRegistered || headerIsRegistered)) {
    return init;
  }
  if (message === undefined || !('method' in message)) {
    throw new Error('Registered MCP extension request body is missing or invalid');
  }
  const bodyMethod = message.method;
  if (headerMethod !== bodyMethod) {
    throw new Error(
      `Registered MCP extension request method/header mismatch: body=${bodyMethod}, header=${String(headerMethod)}`
    );
  }
  const name = registry.resolveMcpName(bodyMethod, message.params);
  const existingName = headers.get('mcp-name');
  if (name === undefined) {
    if (existingName !== null) {
      throw new Error(
        `Registered MCP extension request has unexpected Mcp-Name header: ${existingName}`
      );
    }
    return init;
  }
  const encodedName = encodeMcpHeaderValue(name);
  if (existingName !== null && existingName !== encodedName) {
    throw new Error(
      `Registered MCP extension request Mcp-Name mismatch: expected=${encodedName}, actual=${existingName}`
    );
  }
  headers.set('mcp-name', encodedName);
  return { ...init, headers };
}
