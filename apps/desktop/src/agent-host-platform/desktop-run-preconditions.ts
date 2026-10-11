import { isDeepStrictEqual } from 'node:util';
import { buildModelSettingsOption } from '@brainstrike/agent/provider-request';
import type { HostRunIntentRequest } from '@brainstrike/agent-host';
import {
  materializeCliWorkspaceIntent,
  readCliWorkspaceRunInput,
} from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  DESKTOP_NATIVE_TOOLS,
  deriveAgentLoopInputTokenLimit,
  findLlmModelDefinition,
  findProviderDefinition,
  isSupportedProvider,
  listAutoObservationalMemoryCandidates,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW } from '@brainstrike/assistant-contract/context-budget';
import type { z } from 'zod';
import type { DesktopAdmissionReads, DesktopRunSelection } from './desktop-run-admission';
import type { DesktopMemoryVectorSelection } from './memory-vector-selection';
import {
  PlatformClientConfigurationSchema,
  type PlatformModelConfigurationSchema,
} from './platform-wire';

/**
 * A desktop run's preconditions (BST-1930 stage e): the catalog model, the
 * captured intent, the observer the memory settings resolve to, and the
 * memory selection. A run admission and thread/memory/read both start here.
 */
export interface DesktopCatalogSelection {
  readonly definition: NonNullable<ReturnType<typeof findLlmModelDefinition>>;
  readonly model: string;
  readonly provider: SupportedProvider;
}

export function desktopInputTokenLimit(
  definition: DesktopCatalogSelection['definition'],
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  configuration: z.output<typeof PlatformModelConfigurationSchema>
): number {
  const limit =
    intent.agentLoop?.inputTokenLimit ??
    deriveAgentLoopInputTokenLimit(
      definition,
      configuration.provider,
      configuration.modelSettings?.maxOutputTokens
    );
  if (!limit) {
    throw new Error('The selected model has no resolved input token budget');
  }
  return limit;
}

/**
 * Ollama and LM Studio models are discovered live from the local server: the
 * picker offers exactly what the runtime lists, and neither the models table
 * nor the static catalog holds them. A run on one is budgeted at the
 * conservative window the picker declares for every discovered model.
 */
function localRuntimeModelDefinition(model: string): DesktopCatalogSelection['definition'] {
  if (model.length === 0) {
    throw new Error('The selected local runtime model has no id');
  }
  return {
    contextWindow: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW,
    id: model,
    supportsStreaming: true,
    type: 'llm',
    vision: 'unknown',
  };
}

export async function readDesktopCatalogSelection(
  reads: DesktopAdmissionReads,
  modelId: string,
  signal: AbortSignal
): Promise<DesktopCatalogSelection> {
  const separator = modelId.indexOf('::');
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 2);
  if (separator < 1 || !isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported catalog identity');
  }
  if (findProviderDefinition(provider)?.runtime === 'local') {
    return { definition: localRuntimeModelDefinition(model), model, provider };
  }
  // The UI composite is a selection key. The existing catalog owns the pair.
  const row = await reads.catalogModel({ model, provider }, signal);
  if (!row) {
    throw new Error('The selected model is not in the model catalog');
  }
  if (!row.isEnabled) {
    throw new Error('The selected catalog model is disabled');
  }
  if (row.providerId !== provider) {
    throw new Error('The selected model identity does not match its catalog provider');
  }
  const definition = findLlmModelDefinition(provider, model);
  if (!definition) {
    throw new Error('The selected catalog model has no resolved runtime budget');
  }
  return { definition, model, provider };
}

export async function readDesktopIntent(
  request: HostRunIntentRequest,
  catalog: DesktopCatalogSelection,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  readCliOwnerIntent?: DesktopAdmissionReads['cliOwnerIntent']
): Promise<z.output<typeof PlatformClientConfigurationSchema>> {
  const workspaceInput = readCliWorkspaceRunInput(request.configuration);
  if (workspaceInput) {
    if (request.snapshot) {
      const committed = PlatformClientConfigurationSchema.parse(
        request.snapshot.configuration['intent']
      );
      if (!isDeepStrictEqual(committed.cliWorkspace, workspaceInput.workspace)) {
        throw new Error('CLI workspace recovery does not match its committed selection');
      }
      return committed;
    }
    // BST-1943: a subset envelope previously replaced settings with construction defaults.
    if (!readCliOwnerIntent) {
      throw new Error(
        '[ERR_CLI_WORKSPACE_OWNER_INTENT_UNAVAILABLE] CLI workspace reduction requires the existing full intent owner'
      );
    }
    request.signal.throwIfAborted();
    const ownerIntent = await readCliOwnerIntent(request);
    request.signal.throwIfAborted();
    if (ownerIntent === undefined || ownerIntent === null) {
      throw new Error(
        '[ERR_CLI_WORKSPACE_OWNER_INTENT_UNAVAILABLE] The full intent owner supplied no CLI intent'
      );
    }
    return PlatformClientConfigurationSchema.parse(
      materializeCliWorkspaceIntent(
        PlatformClientConfigurationSchema.parse(ownerIntent),
        workspaceInput.workspace
      )
    );
  }
  const captured = request.configuration ?? request.snapshot?.configuration['intent'];
  return PlatformClientConfigurationSchema.parse(
    captured ?? {
      enabledNativeToolIds: DESKTOP_NATIVE_TOOLS.map((tool) => tool.id),
      memoryOptions: {
        lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
        workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
      },
      memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      modelConfiguration: {
        model: catalog.model,
        provider: catalog.provider,
        ...buildModelSettingsOption({ model: catalog.model, provider: catalog.provider }),
      },
      permissionPolicy: (await readPersistedPolicy?.()) ?? {
        policies: DEFAULT_PERMISSION_POLICIES,
        yolo: false,
      },
      workspaceInstructionsPreference: { masterEnabled: true, oversizedOptInByRootId: {} },
    }
  );
}

/** The chat provider's own auto-observer candidates, in preference order (never another provider). */
export function autoObserverCandidates(provider: string): readonly string[] {
  return listAutoObservationalMemoryCandidates({
    chatProvider: provider,
    providersWithKeys: [provider],
  });
}

/**
 * The auto-observer candidates the model catalog has enabled: provider and
 * model rows enabled and the model an LLM, the gate the memory settings
 * dropdown applies (main's resolveEffectiveObservationalMemorySettings).
 */
async function readEnabledObserverCandidates(
  reads: DesktopAdmissionReads,
  candidates: readonly string[],
  signal: AbortSignal
): Promise<ReadonlySet<string>> {
  if (candidates.length === 0) {
    return new Set();
  }
  return new Set(await reads.enabledObservers(candidates, signal));
}

/** A disabled observer resolves no target, so the catalog is read only for an enabled auto one. */
export function readEnabledObservers(
  reads: DesktopAdmissionReads,
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  provider: string,
  signal: AbortSignal
): Promise<ReadonlySet<string>> {
  const observation = intent.memorySettings.observationalMemory;
  return observation.enabled && observation.modelTarget === 'auto'
    ? readEnabledObserverCandidates(reads, autoObserverCandidates(provider), signal)
    : Promise.resolve(new Set());
}

export function resolveDesktopMemorySettings(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  provider: string,
  enabledObservers: ReadonlySet<string>
): {
  memorySettings: z.output<typeof PlatformClientConfigurationSchema>['memorySettings'];
  observerTarget: string | null;
} {
  const observation = intent.memorySettings.observationalMemory;
  // Auto picks the first enabled candidate of the chat provider; none waits, disabled.
  const observerTarget =
    observation.modelTarget === 'auto'
      ? (autoObserverCandidates(provider).find((candidate) => enabledObservers.has(candidate)) ??
        null)
      : observation.modelTarget;
  const memorySettings = {
    ...intent.memorySettings,
    observationalMemory:
      observerTarget === null
        ? { ...observation, enabled: false }
        : { ...observation, modelTarget: observerTarget },
  };
  return { memorySettings, observerTarget };
}

/**
 * The admitted Memory selection. Observations wait when 'auto' resolved no
 * observer, for the reason legacy's settings resolver gives: the chat provider
 * has no auto candidate, or none of its candidates is enabled in the catalog.
 */
export function desktopMemorySelection(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  provider: string,
  settings: z.output<typeof PlatformClientConfigurationSchema>['memorySettings'],
  observerTarget: string | null,
  vectors: DesktopMemoryVectorSelection | undefined
): DesktopRunSelection['memory'] {
  const awaiting =
    autoObserverCandidates(provider).length === 0
      ? 'no-hosted-chat-provider'
      : 'model-not-eligible';
  return {
    ...(intent.memorySettings.observationalMemory.enabled && observerTarget === null
      ? { observerAwaiting: awaiting }
      : {}),
    options: intent.memoryOptions,
    settings,
    ...(vectors ? { vectorProfile: vectors.profile } : {}),
  };
}
