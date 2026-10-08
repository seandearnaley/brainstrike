import { isDeepStrictEqual } from 'node:util';
import { buildModelSettingsOption } from '@brainstrike/agent/provider-request';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import {
  DEFAULT_AGENT_MAX_STEPS,
  resolveAssistantResilienceConfig,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  createProductionHostPlatform,
  type HostPlatform,
  type HostPlatformLaunchOptions,
  type HostStartupContext,
  type ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import {
  readCliWorkspaceRunInput,
  STANDALONE_WORKSPACE_CAPABILITY_ERROR,
} from '@brainstrike/agent-host/standalone-workspace-input';
import {
  CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  deriveAgentLoopInputTokenLimit,
  findLlmModelDefinition,
  findProviderDefinition,
  isSupportedProvider,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { z } from 'zod';
import { createHostCapabilities } from './capabilities.js';
import { createStandaloneHumanTools, STANDALONE_HUMAN_TOOL_IDS } from './standalone-human-tools.js';

const capabilities = {
  browserOAuth: 'unavailable',
  configuredMcp: 'unavailable',
  localInference: 'unavailable',
  mcpAppUi: 'text',
  nativeTools: { available: [...STANDALONE_HUMAN_TOOL_IDS], remaining: 'unavailable' },
  skills: 'unavailable',
  tasks: 'unavailable',
  vectorMemory: 'unavailable',
  workspaceInstructions: 'unavailable',
};

function selection(modelId: string) {
  const separator = modelId.indexOf('::');
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 2);
  if (separator < 1 || !model || !isSupportedProvider(provider)) {
    throw new Error('Standalone --model requires an explicit canonical provider::model');
  }
  const source = findProviderDefinition(provider);
  if (source?.runtime === 'browser' || source?.runtime === 'local') {
    throw new Error(
      'The selected provider requires an unavailable headless local-runtime capability'
    );
  }
  const definition = findLlmModelDefinition(provider, model);
  if (!definition) {
    throw new Error('The selected model has no canonical runtime catalog definition');
  }
  return { definition, model, provider };
}

/** Root and its canonical writer have already been acquired by startAgentHost. */
export async function createHostPlatform(
  options: HostStartOptions,
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
  if (options.root !== startup.store.root) {
    throw new Error('Standalone platform must borrow its acquired canonical Root');
  }
  const host = await createHostCapabilities({
    env: process.env,
    launch: platformOptions,
    startup,
  });
  return createProductionHostPlatform({
    auth: host.auth,
    close: () => host.close(),
    readConfiguration: async (request): Promise<ProductionHostRunConfiguration> => {
      request.signal.throwIfAborted();
      if (readCliWorkspaceRunInput(request.configuration)) {
        throw new Error(
          `[${STANDALONE_WORKSPACE_CAPABILITY_ERROR}] Standalone workspace input requires the existing profile/catalog and pinned workspace service capabilities`
        );
      }
      const catalog = selection(request.modelId);
      const selected: RuntimeData = { model: catalog.model, provider: catalog.provider };
      const modelSettings = buildModelSettingsOption(selected).modelSettings;
      const configuration: RuntimeData = {
        ...selected,
        ...(modelSettings ? { modelSettings } : {}),
      };
      const inputTokenLimit = deriveAgentLoopInputTokenLimit(
        catalog.definition,
        catalog.provider,
        configuration.modelSettings?.maxOutputTokens
      );
      if (!inputTokenLimit) {
        throw new Error('The selected model has no canonical input token budget');
      }
      // Coordinator-approved stateless CLI policy: explicit selection is separate
      // from Main's saved enabled-model preference. Existing hosts keep their owner.
      const intent = z.record(z.string(), z.json()).parse({
        agentLoop: { inputTokenLimit, maxSteps: DEFAULT_AGENT_MAX_STEPS },
        enabledNativeToolIds: STANDALONE_HUMAN_TOOL_IDS,
        memoryOptions: {
          lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
          workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
        },
        memorySettings: CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
        modelConfiguration: configuration,
        permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
        workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
      });
      const captured = request.configuration ?? request.snapshot?.configuration['intent'];
      if (
        request.snapshot &&
        (captured === undefined ||
          !isDeepStrictEqual(request.snapshot.configuration['capabilities'], capabilities))
      ) {
        throw new Error('Captured run has no compatible standalone platform capabilities');
      }
      if (captured !== undefined && !isDeepStrictEqual(captured, intent)) {
        throw new Error(
          'Captured run intent requires capabilities unavailable on this standalone host'
        );
      }
      const resolvedToolResultBudget = resolveScaledToolResultBudget(
        catalog.definition.contextWindow
      );
      const bindings = createStandaloneHumanTools(resolvedToolResultBudget);
      return {
        configuration,
        durableConfiguration: { capabilities, intent },
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
        memory: {
          native: {
            options: {
              lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
              observationalMemory: false,
              semanticRecall: false,
              workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
            },
          },
          // Core already commits the final prepared request accounting before this observer.
          recordPrompt: async () => undefined,
          resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        },
        providerRequestContext: {
          inputTokenLimit,
          provider: catalog.provider,
          runtimeData: configuration,
        },
        resolvedToolResultBudget,
        system:
          'This standalone host supports the canonical askUser and submitPlan native tools. Other native tools, configured MCP/Tasks, Skills/workspace instructions, browser OAuth, local inference and vector Memory are unavailable. Use an existing desktop host for those capabilities.',
        tools: bindings.tools,
        toolTimeoutMs: resolveAssistantResilienceConfig().toolTimeoutMs,
      };
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    // The standalone host has no private desktop client: subscription auth refuses.
    resolveProviderAuth: (provider) => host.auth.resolveProviderAuth(provider, undefined),
    startup,
  });
}
