import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildModelSettingsOption } from '@brainstrike/agent/provider-request';
import {
  createAwsCredentialChain,
  type ProviderAuthInput,
  type RuntimeData,
} from '@brainstrike/agent/provider-runtime';
import {
  DEFAULT_AGENT_MAX_STEPS,
  resolveAssistantResilienceConfig,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  deriveAgentLoopInputTokenLimit,
  findLlmModelDefinition,
  findProviderDefinition,
  isSupportedProvider,
  providerEnvKeys,
  resolveHostedProviderCredential,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { z } from 'zod';
import { createFileCredentialBackend } from './adapters/file-credentials.js';
import {
  createKeyringCredentialStore,
  createKeyringSecretsService,
} from './adapters/keyring-credentials.js';
import { createKeyringCredentialBackend } from './adapters/keyring-native-worker.js';
import type { HostPlatformLaunchOptions } from './platform-launch-options.js';
import type { HostPlatform } from './ports.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from './production-platform.js';
import type { HostStartupContext } from './runtime.js';

const capabilities = {
  browserOAuth: 'unavailable',
  configuredMcp: 'unavailable',
  localInference: 'unavailable',
  mcpAppUi: 'text',
  nativeTools: 'unavailable',
  skills: 'unavailable',
  tasks: 'unavailable',
  vectorMemory: 'unavailable',
  workspaceInstructions: 'unavailable',
} as const;

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
export function createHostPlatform(
  options: HostStartOptions,
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
  if (options.root !== startup.store.root) {
    throw new Error('Standalone platform must borrow its acquired canonical Root');
  }
  let credentials: ReturnType<typeof createKeyringCredentialStore> | undefined;
  let closing = false;
  const secrets = () => {
    if (closing) {
      throw new Error('Standalone credential authority is closing');
    }
    const credentialSelection = platformOptions?.credentialStore;
    if (!credentialSelection) {
      throw new Error(
        'Standalone keyring reads require an explicitly selected credential service; file fallback is not automatic'
      );
    }
    const service =
      credentialSelection.kind === 'file'
        ? resolve(credentialSelection.path)
        : credentialSelection.service;
    credentials ??= createKeyringCredentialStore({
      backend:
        credentialSelection.kind === 'file'
          ? createFileCredentialBackend(service)
          : createKeyringCredentialBackend(service),
      service,
    });
    return createKeyringSecretsService({
      accountForProvider: (provider) => provider,
      credentials,
      providerForAccount: (account) => (isSupportedProvider(account) ? account : undefined),
    });
  };
  const resolveAuth = async (provider: string): Promise<ProviderAuthInput | undefined> => {
    if (!isSupportedProvider(provider)) {
      throw new Error('Unsupported provider credential request');
    }
    const resolved = await resolveHostedProviderCredential({
      envKeyNames: providerEnvKeys(provider),
      envSources: [process.env],
      readCredential: () => secrets().getCredential(provider),
    });
    if (resolved.secretReadError !== undefined) {
      throw resolved.secretReadError;
    }
    if (!(resolved.credential && resolved.source)) {
      throw new Error('The selected provider has no configured credential');
    }
    return providerAuthInputFromCredential(
      provider,
      { ...resolved.credential, source: resolved.source },
      {
        awsCredentialChain: createAwsCredentialChain,
        env: process.env,
      }
    );
  };
  return createProductionHostPlatform({
    close: async () => {
      closing = true;
      await credentials?.close();
    },
    readConfiguration: async (request): Promise<ProductionHostRunConfiguration> => {
      request.signal.throwIfAborted();
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
        enabledNativeToolIds: [],
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
        resolvedToolResultBudget: resolveScaledToolResultBudget(catalog.definition.contextWindow),
        system:
          'This standalone host has no native tools, configured MCP/Tasks, Skills/workspace instructions, browser OAuth, local inference or vector Memory capabilities. Use an existing desktop host for those capabilities.',
        tools: {},
        toolTimeoutMs: resolveAssistantResilienceConfig().toolTimeoutMs,
      };
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: resolveAuth,
    startup,
  });
}
