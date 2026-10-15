import type { NativeToolId } from './native-tool-catalog.js';
import type { NativeToolDiscoveryNamespace } from './native-tools/define.js';
import { NATIVE_TOOL_REGISTRIES } from './native-tools/index.js';
import type { PermissionDecision } from './permission-policy.js';
import {
  getProviderDefinition,
  listProviderLlmModels,
  type NativeToolSearchCapability,
  type ProviderId,
} from './provider-registry.js';

export type { NativeToolDiscoveryNamespace };

export interface NativeToolDiscoveryNamespaceDefinition {
  readonly summary: string;
  readonly toolIds: readonly NativeToolId[];
}

const NATIVE_TOOL_DISCOVERY_NAMESPACE_SUMMARIES: Record<NativeToolDiscoveryNamespace, string> = {
  artifacts: 'Continue reading durable oversized tool results by opaque cursor.',
  context: 'Inspect open workspace roots, and read named workspace files and directories.',
  database:
    "Inspect durable diagnostic failures or run read-only SQL over Brainstrike's own local database: assistant run history, edit checkpoints, token usage and cost, queue metrics, and the workspace code index.",
  embeddings: 'Inspect and query configured embedding spaces.',
  execution:
    'Run code the assistant writes inside an OS sandbox: Python with no network access and writes confined to a temporary scratch directory. Use for computation, parsing, and data wrangling.',
  semantics: 'Search indexed code and inspect language-server symbols and diagnostics.',
  sessions: 'Inspect and control persistent workspace command sessions and development servers.',
  skills: 'Discover, activate, read, and run bundled scripts from installed Agent Skills.',
  web: "Search the public web, extract readable page content, and drive the app's embedded browser pane: navigate it and read the live page as text or an accessibility tree.",
  workspace:
    'Perform specialist workspace mutations, manage isolated git worktrees, and maintain Canvas documents or tasks.',
};

/**
 * Provider-facing deferred groups. Each namespace stays below ten functions so
 * native provider search receives enough semantic detail without reintroducing
 * the complete tool-schema payload. Membership is DERIVED from each tool's
 * `discovery.namespace` (`native-tools/definitions/*.ts`); only the summaries
 * are authored here.
 */
export const NATIVE_TOOL_DISCOVERY_NAMESPACES: Record<
  NativeToolDiscoveryNamespace,
  NativeToolDiscoveryNamespaceDefinition
> = Object.fromEntries(
  (Object.keys(NATIVE_TOOL_DISCOVERY_NAMESPACE_SUMMARIES) as NativeToolDiscoveryNamespace[]).map(
    (namespace) => [
      namespace,
      {
        summary: NATIVE_TOOL_DISCOVERY_NAMESPACE_SUMMARIES[namespace],
        toolIds: NATIVE_TOOL_REGISTRIES.discoveryNamespaceToolIds[namespace],
      },
    ]
  )
) as Record<NativeToolDiscoveryNamespace, NativeToolDiscoveryNamespaceDefinition>;

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
 * counts skills metadata, loaded definitions, filtered stale tool history, and
 * provider-history normalization.
 */
export const TOOL_DISCOVERY_PIPELINE_ORDER = [
  'capability-and-permission-eligibility',
  'guards-and-lifecycle-hooks',
  'plan-permission-and-suspend-gates',
  'provider-native-web-search',
  'tool-output-settlement-and-projection',
  'skills-metadata-injection',
  'tool-discovery',
  'projection-safe-tool-history-filter',
  'provider-history-compatibility',
  'projection-aware-token-limiter',
] as const;
