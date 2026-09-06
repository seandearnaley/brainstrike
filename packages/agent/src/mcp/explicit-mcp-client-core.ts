/**
 * The option-intake and SDK-client construction steps that the explicit stdio
 * and HTTP MCP clients perform identically: non-empty option validation,
 * default client info, the catalog kind union, and building one SDK `Client`
 * with its capability lease and feature-event handlers installed.
 */
import { Client, type ClientOptions } from '@modelcontextprotocol/client';
import type { McpClientCapabilityLease, McpClientCapabilityRuntime } from './client-capabilities';
import type { McpClientExtensionRegistry } from './client-extension-registry';
import { type McpProtocol, toMcpVersionNegotiation } from './config';
import type { McpServerFeatureEventRegistry } from './server-feature-events';

const DEFAULT_CLIENT_VERSION = '0.1.0';

export type McpCatalogKind = 'prompts' | 'resource-templates' | 'resources' | 'tools';

export interface McpClientInfo {
  name: string;
  version: string;
}

export function validateNonEmptyMcpOption(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value;
}

/**
 * Resolves the advertised client info, defaulting to a Brainstrike-namespaced
 * identity derived from the configured server name.
 */
export function resolveMcpClientInfo(
  serverName: string,
  clientInfo: McpClientInfo | undefined
): McpClientInfo {
  const resolved = clientInfo ?? {
    name: `brainstrike-${serverName}`,
    version: DEFAULT_CLIENT_VERSION,
  };
  validateNonEmptyMcpOption(resolved.name, 'MCP client info name');
  validateNonEmptyMcpOption(resolved.version, 'MCP client info version');
  return { ...resolved };
}

export interface ExplicitMcpSdkClientOptions {
  cachePartition?: ClientOptions['cachePartition'];
  capabilityRuntime: McpClientCapabilityRuntime;
  clientInfo: McpClientInfo;
  defaultCacheTtlMs?: ClientOptions['defaultCacheTtlMs'];
  extensionRegistry?: McpClientExtensionRegistry;
  inputRequired: NonNullable<ClientOptions['inputRequired']>;
  listMaxPages: number;
  protocol: McpProtocol;
  responseCacheStore: NonNullable<ClientOptions['responseCacheStore']>;
  serverName: string;
}

export interface ExplicitMcpSdkClient {
  capabilityLease: McpClientCapabilityLease;
  client: Client;
}

/**
 * Builds the SDK client for one connection: advertised capabilities (including
 * host-owned extensions), the capability lease this connection owns, and the
 * server feature-event handlers. The caller still owns transport construction.
 */
export function createExplicitMcpSdkClient(
  options: ExplicitMcpSdkClientOptions,
  featureEvents: McpServerFeatureEventRegistry
): ExplicitMcpSdkClient {
  const extensions = options.extensionRegistry?.toClientExtensionCapabilities();
  const capabilities = {
    ...options.capabilityRuntime.capabilities,
    ...(extensions ? { extensions } : {}),
  };
  const clientOptions = {
    capabilities,
    enforceStrictCapabilities: true,
    inputRequired: options.inputRequired,
    listMaxPages: options.listMaxPages,
    versionNegotiation: toMcpVersionNegotiation(options.protocol),
    ...(options.cachePartition === undefined ? {} : { cachePartition: options.cachePartition }),
    ...(options.defaultCacheTtlMs === undefined
      ? {}
      : { defaultCacheTtlMs: options.defaultCacheTtlMs }),
    responseCacheStore: options.responseCacheStore,
  } satisfies ClientOptions;
  const client = new Client(options.clientInfo, clientOptions);
  const capabilityLease = options.capabilityRuntime.install(client, options.serverName);
  featureEvents.install(client);
  return { capabilityLease, client };
}
