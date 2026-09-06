/**
 * Option intake for the explicit HTTP MCP client: validates caller-supplied
 * options and normalizes them once into the per-client configuration the client
 * runs on — capability runtime, header-preserving fetch bridge, the
 * client-scoped registered-extension dispatch ledger, and interactive OAuth.
 */
import type {
  AuthProvider,
  ClientOptions,
  OAuthClientProvider,
} from '@modelcontextprotocol/client';
import {
  composeMcpTransportCapabilities,
  type McpClientCapabilityOptions,
  type McpClientCapabilityRuntime,
} from './client-capabilities';
import type { McpClientExtensionRegistry } from './client-extension-registry';
import {
  createMcpResponseCacheStore,
  normalizeMcpCachePartition,
  normalizeMcpListMaxPages,
} from './client-policy';
import type { McpProtocol } from './config';
import type {
  ExplicitHttpMcpAuthorizationCallbackSource,
  ExplicitHttpMcpFetch,
  ExplicitHttpMcpLifecycle,
  ExplicitHttpMcpTransport,
  ExplicitHttpMcpUnexpectedCloseObserver,
} from './explicit-http-client-types';
import {
  type McpClientInfo,
  resolveMcpClientInfo,
  validateNonEmptyMcpOption,
} from './explicit-mcp-client-core';
import {
  assertOAuthHeaderCompatibility,
  createInteractiveOAuthCompletion,
  type InteractiveOAuthCompletion,
  normalizeOAuthStepUpOptions,
} from './interactive-oauth-completion';
import {
  createHeaderPreservingFetch,
  RegisteredExtensionDispatchLedger,
} from './registered-extension-dispatch';
import {
  type McpServerFeatureEventDiagnosticSink,
  resolveMcpServerFeatureEventDiagnosticSink,
} from './server-feature-events';

export interface ExplicitHttpMcpClientOptions {
  authorizationCallbackSource?: ExplicitHttpMcpAuthorizationCallbackSource;
  authorizationCallbackTimeoutMs?: number;
  authProvider?: AuthProvider | OAuthClientProvider;
  cachePartition?: ClientOptions['cachePartition'];
  clientCapabilities?: McpClientCapabilityOptions;
  clientInfo?: McpClientInfo;
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  extensionRegistry?: McpClientExtensionRegistry;
  fetch?: ExplicitHttpMcpFetch;
  headers?: Readonly<Record<string, string>>;
  inputRequired?: ClientOptions['inputRequired'];
  lifecycle?: ExplicitHttpMcpLifecycle;
  listMaxPages?: ClientOptions['listMaxPages'];
  maxStepUpRetries?: number;
  name: string;
  onInsufficientScope?: 'reauthorize' | 'throw';
  onServerFeatureEventError?: McpServerFeatureEventDiagnosticSink;
  onUnexpectedClose?: ExplicitHttpMcpUnexpectedCloseObserver;
  protocol?: McpProtocol;
  responseCacheStore?: ClientOptions['responseCacheStore'];
  transport: ExplicitHttpMcpTransport;
  url: string | URL;
}

export interface NormalizedHttpClientOptions {
  authProvider?: AuthProvider | OAuthClientProvider;
  cachePartition?: ClientOptions['cachePartition'];
  capabilityRuntime: McpClientCapabilityRuntime;
  clientInfo: McpClientInfo;
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  extensionDispatchLedger: RegisteredExtensionDispatchLedger;
  extensionRegistry?: McpClientExtensionRegistry;
  fetch: ExplicitHttpMcpFetch;
  inputRequired: NonNullable<ClientOptions['inputRequired']>;
  interactiveOAuth?: InteractiveOAuthCompletion;
  lifecycle: ExplicitHttpMcpLifecycle;
  listMaxPages: number;
  maxStepUpRetries?: number;
  onInsufficientScope?: 'reauthorize' | 'throw';
  onServerFeatureEventError: McpServerFeatureEventDiagnosticSink;
  onUnexpectedClose?: ExplicitHttpMcpUnexpectedCloseObserver;
  protocol: McpProtocol;
  responseCacheStore: NonNullable<ClientOptions['responseCacheStore']>;
  serverName: string;
  transport: ExplicitHttpMcpTransport;
  url: URL;
}

function validateLifecycle(value: unknown, clientName: string): ExplicitHttpMcpLifecycle {
  const lifecycle = value ?? 'client-owned';
  if (lifecycle !== 'client-owned' && lifecycle !== 'host-owned') {
    throw new Error(
      `MCP client "${clientName}": lifecycle must be "client-owned" or "host-owned" (got "${String(lifecycle)}")`
    );
  }
  return lifecycle;
}

function validateUnexpectedCloseObserver(
  value: unknown,
  clientName: string
): ExplicitHttpMcpUnexpectedCloseObserver | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'function') {
    throw new Error(`MCP client "${clientName}": onUnexpectedClose must be a function`);
  }
  return value as ExplicitHttpMcpUnexpectedCloseObserver;
}

export function normalizeExplicitHttpClientOptions(
  options: ExplicitHttpMcpClientOptions
): NormalizedHttpClientOptions {
  const name = validateNonEmptyMcpOption(options.name, 'MCP client name');
  const interactiveOAuth = createInteractiveOAuthCompletion(name, options);
  const onUnexpectedClose = validateUnexpectedCloseObserver(options.onUnexpectedClose, name);
  const protocol = options.protocol ?? 'legacy';
  if (options.transport === 'sse' && protocol !== 'legacy') {
    throw new Error(
      `MCP client "${name}": legacy SSE transport requires protocol "legacy" (got "${protocol}")`
    );
  }
  const clientInfo = resolveMcpClientInfo(name, options.clientInfo);

  const url = new URL(options.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP HTTP URL must use http: or https:');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('MCP HTTP URL must not include credentials');
  }

  const baseFetch: ExplicitHttpMcpFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const cachePartition = normalizeMcpCachePartition(
    options.cachePartition,
    options.responseCacheStore !== undefined
  );
  assertOAuthHeaderCompatibility(name, options.authProvider, options.headers);
  const scopeStepUp = normalizeOAuthStepUpOptions(options);
  const extensionDispatchLedger = new RegisteredExtensionDispatchLedger();
  const capabilityConfiguration = composeMcpTransportCapabilities({
    ...(options.clientCapabilities ? { clientCapabilities: options.clientCapabilities } : {}),
    ...(options.inputRequired ? { inputRequired: options.inputRequired } : {}),
  });
  return {
    ...(options.authProvider ? { authProvider: options.authProvider } : {}),
    ...(cachePartition === undefined ? {} : { cachePartition }),
    capabilityRuntime: capabilityConfiguration.runtime,
    clientInfo,
    ...(options.defaultCacheTtlMs === undefined
      ? {}
      : { defaultCacheTtlMs: options.defaultCacheTtlMs }),
    extensionDispatchLedger,
    ...(options.extensionRegistry ? { extensionRegistry: options.extensionRegistry } : {}),
    fetch: createHeaderPreservingFetch(
      baseFetch,
      options.headers,
      options.extensionRegistry,
      () => interactiveOAuth?.getAuthorizationSignal(),
      extensionDispatchLedger
    ),
    inputRequired: capabilityConfiguration.inputRequired,
    ...(interactiveOAuth ? { interactiveOAuth } : {}),
    lifecycle: validateLifecycle(options.lifecycle, name),
    listMaxPages: normalizeMcpListMaxPages(options.listMaxPages),
    onServerFeatureEventError: resolveMcpServerFeatureEventDiagnosticSink(
      options.onServerFeatureEventError,
      name
    ),
    ...scopeStepUp,
    ...(onUnexpectedClose ? { onUnexpectedClose } : {}),
    protocol,
    responseCacheStore: createMcpResponseCacheStore(options.responseCacheStore),
    serverName: name,
    transport: options.transport,
    url,
  };
}
