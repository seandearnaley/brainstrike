import { NATIVE_TOOL_ID, type NativeToolId } from './native-tool-catalog.js';
import type { PermissionDecision } from './permission-policy.js';
import {
  getProviderDefinition,
  listProviderLlmModels,
  type NativeToolSearchCapability,
  type ProviderId,
} from './provider-registry.js';

export type NativeToolDiscoveryNamespace =
  | 'artifacts'
  | 'context'
  | 'embeddings'
  | 'semantics'
  | 'skills'
  | 'web'
  | 'workspace';

export interface NativeToolDiscoveryNamespaceDefinition {
  readonly summary: string;
  readonly toolIds: readonly NativeToolId[];
}

/**
 * Provider-facing deferred groups. Each namespace stays below ten functions so
 * native provider search receives enough semantic detail without reintroducing
 * the complete tool-schema payload.
 */
export const NATIVE_TOOL_DISCOVERY_NAMESPACES = {
  artifacts: {
    summary: 'Continue reading durable oversized tool results by opaque cursor.',
    toolIds: [NATIVE_TOOL_ID.readToolOutputArtifact],
  },
  context: {
    summary: 'Inspect and update workspace context, directory, and Tapestry selections.',
    toolIds: [
      NATIVE_TOOL_ID.listWorkspaceContext,
      NATIVE_TOOL_ID.readWorkspaceContext,
      NATIVE_TOOL_ID.readWorkspaceDirectory,
      NATIVE_TOOL_ID.updateWorkspaceContextSelection,
      NATIVE_TOOL_ID.updateWorkspaceTapestrySelections,
    ],
  },
  embeddings: {
    summary: 'Inspect and query configured embedding spaces.',
    toolIds: [NATIVE_TOOL_ID.listEmbeddingSpaces, NATIVE_TOOL_ID.queryEmbeddingSpace],
  },
  semantics: {
    summary: 'Search indexed code and inspect language-server symbols and diagnostics.',
    toolIds: [
      NATIVE_TOOL_ID.findWorkspaceSymbol,
      NATIVE_TOOL_ID.hybridSearch,
      NATIVE_TOOL_ID.lspInspect,
    ],
  },
  skills: {
    summary: 'Discover, activate, and read installed Agent Skills.',
    toolIds: [NATIVE_TOOL_ID.skill, NATIVE_TOOL_ID.skillRead, NATIVE_TOOL_ID.skillSearch],
  },
  web: {
    summary: 'Search the public web and extract readable page content.',
    toolIds: [NATIVE_TOOL_ID.webExtract, NATIVE_TOOL_ID.webSearch],
  },
  workspace: {
    summary: 'Perform specialist workspace mutations and maintain the agent task list.',
    toolIds: [
      NATIVE_TOOL_ID.deleteWorkspaceFile,
      NATIVE_TOOL_ID.manageTaskList,
      NATIVE_TOOL_ID.renameWorkspaceFile,
      NATIVE_TOOL_ID.writeWorkspaceFile,
    ],
  },
} as const satisfies Record<NativeToolDiscoveryNamespace, NativeToolDiscoveryNamespaceDefinition>;

export type ToolDiscoveryAdapter =
  | 'anthropic-native-search'
  | 'eager-core-only'
  | 'mastra-catalog-search'
  | 'openai-native-search';

export const TOOL_DISCOVERY_FAILURE_CODES = [
  'catalog-miss',
  'host-unavailable',
  'permission-denied',
  'unsupported-adapter',
] as const;

export type ToolDiscoveryFailureCode = (typeof TOOL_DISCOVERY_FAILURE_CODES)[number];

export type ToolDiscoveryAdapterUnsupportedReason =
  | 'dynamic-model-capability-unknown'
  | 'model-lacks-requested-native-search'
  | 'provider-has-no-llm'
  | 'requested-adapter-not-supported'
  | 'unknown-model';

export type ToolDiscoveryAdapterResolution =
  | {
      readonly adapter: ToolDiscoveryAdapter;
      readonly reason?: 'local-discovery-not-enabled';
      readonly status: 'supported';
    }
  | {
      readonly adapter: 'unsupported';
      readonly reason: ToolDiscoveryAdapterUnsupportedReason;
      readonly requestedAdapter?: ToolDiscoveryAdapter;
      readonly status: 'unsupported';
    };

export interface ResolveToolDiscoveryAdapterInput {
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly requestedAdapter?: ToolDiscoveryAdapter;
}

function nativeAdapterForCapability(
  capability: NativeToolSearchCapability | undefined
): ToolDiscoveryAdapter | undefined {
  if (capability === 'anthropic') {
    return 'anthropic-native-search';
  }
  if (capability === 'openai') {
    return 'openai-native-search';
  }
  return;
}

function unsupportedAdapter(
  reason: ToolDiscoveryAdapterUnsupportedReason,
  requestedAdapter?: ToolDiscoveryAdapter
): ToolDiscoveryAdapterResolution {
  return {
    adapter: 'unsupported',
    reason,
    ...(requestedAdapter ? { requestedAdapter } : {}),
    status: 'unsupported',
  };
}

function resolveRequestedAdapter(
  requestedAdapter: ToolDiscoveryAdapter,
  nativeAdapter: ToolDiscoveryAdapter | undefined,
  providerRuntime: ReturnType<typeof getProviderDefinition>['runtime']
): ToolDiscoveryAdapterResolution {
  if (
    requestedAdapter === nativeAdapter ||
    (requestedAdapter === 'eager-core-only' && providerRuntime === 'browser')
  ) {
    return { adapter: requestedAdapter, status: 'supported' };
  }
  if (requestedAdapter === 'mastra-catalog-search' && providerRuntime !== 'browser') {
    return { adapter: requestedAdapter, status: 'supported' };
  }
  const reason = requestedAdapter.endsWith('-native-search')
    ? 'model-lacks-requested-native-search'
    : 'requested-adapter-not-supported';
  return unsupportedAdapter(reason, requestedAdapter);
}

/**
 * Resolve one explicit adapter without substituting a different strategy.
 * Hosted callers explicitly request Mastra catalog search in the live runtime;
 * provider-native selections remain declarative until their later slices.
 */
export function resolveToolDiscoveryAdapter(
  input: ResolveToolDiscoveryAdapterInput
): ToolDiscoveryAdapterResolution {
  const provider = getProviderDefinition(input.provider);
  if (!provider.capabilities.llm) {
    return unsupportedAdapter('provider-has-no-llm', input.requestedAdapter);
  }

  // Mastra catalog search is provider-runtime based, not model-capability
  // based. A caller that supplies a valid hosted model adapter directly (for
  // tests, evals, or an externally discovered model) must not be rejected only
  // because the static registry does not know that model ID. Browser-local
  // remains explicitly unsupported.
  if (input.requestedAdapter === 'mastra-catalog-search') {
    return resolveRequestedAdapter(input.requestedAdapter, undefined, provider.runtime);
  }

  const model = listProviderLlmModels(input.provider).find(({ id }) => id === input.modelId);
  if (!model) {
    if (provider.runtime === 'local') {
      return unsupportedAdapter('dynamic-model-capability-unknown', input.requestedAdapter);
    }
    return unsupportedAdapter('unknown-model', input.requestedAdapter);
  }

  const nativeAdapter = nativeAdapterForCapability(model.nativeToolSearch);
  if (input.requestedAdapter) {
    return resolveRequestedAdapter(input.requestedAdapter, nativeAdapter, provider.runtime);
  }

  if (nativeAdapter) {
    return { adapter: nativeAdapter, status: 'supported' };
  }
  if (provider.runtime === 'browser') {
    return {
      adapter: 'eager-core-only',
      reason: 'local-discovery-not-enabled',
      status: 'supported',
    };
  }
  return { adapter: 'mastra-catalog-search', status: 'supported' };
}

export type ToolDiscoveryPhaseStatus =
  | 'disabled'
  | 'eligible'
  | 'host-unavailable'
  | 'permission-denied';

export interface ResolveToolDiscoveryPhaseAccessInput {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly permission: PermissionDecision;
}

export interface ToolDiscoveryPhaseAccess {
  readonly active: boolean;
  readonly loadable: boolean;
  readonly searchable: boolean;
  readonly status: ToolDiscoveryPhaseStatus;
}

const INELIGIBLE_PHASES = {
  active: false,
  loadable: false,
  searchable: false,
} as const;

/**
 * Admission is deliberately separate from execution authorization. An `ask`
 * tool may be discovered and loaded, but the downstream permission gate still
 * suspends before execution. `enabled` alone never makes a tool active.
 */
export function resolveToolDiscoveryPhaseAccess(
  input: ResolveToolDiscoveryPhaseAccessInput
): ToolDiscoveryPhaseAccess {
  if (!input.enabled) {
    return { ...INELIGIBLE_PHASES, status: 'disabled' };
  }
  if (!input.available) {
    return { ...INELIGIBLE_PHASES, status: 'host-unavailable' };
  }
  if (input.permission === 'deny') {
    return { ...INELIGIBLE_PHASES, status: 'permission-denied' };
  }
  return {
    active: input.loaded,
    loadable: true,
    searchable: true,
    status: 'eligible',
  };
}

/**
 * Ordered seams for the live hosted runtime. Token limiting remains last so it
 * counts skills metadata, loaded definitions, and provider-history normalization.
 */
export const TOOL_DISCOVERY_PIPELINE_ORDER = [
  'capability-and-permission-eligibility',
  'guards-and-lifecycle-hooks',
  'plan-permission-and-suspend-gates',
  'provider-native-web-search',
  'tool-output-settlement-and-projection',
  'skills-metadata-injection',
  'tool-discovery',
  'provider-history-compatibility',
  'projection-aware-token-limiter',
] as const;
