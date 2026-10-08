import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
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
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { z } from 'zod';
import { createHostCapabilities } from './capabilities.js';
import { getGlobalHooksPath } from './hooks/config.js';
import { createHostRunHooks } from './hooks/host-run-hooks.js';
import { createCliMcpHost } from './mcp/cli-mcp-host.js';
import {
  createSharedNativeHostTools,
  forgetSharedNativeToolThread,
  ReadWorkspaceFileCursorRegistry,
} from './native-tools/index.js';
import { createStandaloneHumanTools, STANDALONE_HUMAN_TOOL_IDS } from './standalone-human-tools.js';

/** The shared native tools a standalone host runs over its launch roots. */
const STANDALONE_WORKSPACE_TOOL_IDS = [
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.readWorkspaceDirectory,
  NATIVE_TOOL_ID.writeWorkspaceFile,
  NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
  NATIVE_TOOL_ID.deleteWorkspaceFile,
  NATIVE_TOOL_ID.renameWorkspaceFile,
  NATIVE_TOOL_ID.manageTaskList,
  NATIVE_TOOL_ID.manageCanvas,
] as const;
const STANDALONE_NATIVE_TOOL_IDS = [...STANDALONE_HUMAN_TOOL_IDS, ...STANDALONE_WORKSPACE_TOOL_IDS];

const standaloneCapabilities = {
  browserOAuth: 'unavailable',
  configuredMcp: 'unavailable',
  localInference: 'unavailable',
  mcpAppUi: 'text',
  nativeTools: { available: STANDALONE_NATIVE_TOOL_IDS, remaining: 'unavailable' },
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

/**
 * The launch roots this host was started with (`--workspace`, cwd by default).
 * The launch option owns their identity: a root's id is its canonical path.
 */
async function standaloneWorkspaceRoots(
  paths: readonly string[] | undefined
): Promise<RuntimeWorkspaceRoot[]> {
  if (!paths) {
    throw new Error('A standalone host requires its launch workspace roots');
  }
  const roots: RuntimeWorkspaceRoot[] = [];
  for (const path of paths) {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error('A standalone workspace root must be a directory');
    }
    if (roots.some((root) => root.rootId === canonical)) {
      throw new Error('A standalone workspace root was given twice');
    }
    roots.push({
      displayName: basename(canonical) || canonical,
      path: canonical,
      rootId: canonical,
    });
  }
  return roots;
}

/** What this standalone host can do, for the model. */
function standaloneSystemPrompt(
  roots: readonly RuntimeWorkspaceRoot[],
  configuredMcp: boolean
): string {
  const mcpTools = configuredMcp ? ', and the configured MCP servers (text Apps only)' : '';
  const unavailableMcp = configuredMcp ? 'MCP Tasks' : 'configured MCP/Tasks';
  return `This standalone host supports the canonical askUser and submitPlan tools, workspace file read, write, string-replace, delete, rename and directory listing, the task list and canvases${mcpTools}. Its workspace roots: ${roots.map((root) => root.path).join(', ')}. Search and shell tools, ${unavailableMcp}, Skills/workspace instructions, browser OAuth, local inference and vector Memory are unavailable. Use an existing desktop host for those capabilities.`;
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
  const workspaceRoots = await standaloneWorkspaceRoots(platformOptions?.workspaceRoots);
  // One host-lifetime registry; its handles are scoped to their thread.
  const readFileCursorRegistry = new ReadWorkspaceFileCursorRegistry();
  const host = await createHostCapabilities({
    env: process.env,
    launch: platformOptions,
    startup,
  });
  // Configured MCP servers run in this host's own MCP runtime (Tasks off for now).
  const mcpConfig = platformOptions?.mcpConfig;
  const mcp = mcpConfig
    ? await createCliMcpHost({ configPath: mcpConfig.path, credentials: host.credentials, startup })
    : undefined;
  if (mcp) {
    await startup.register(async () => {
      await mcp.close();
    });
  }
  const capabilities = mcp
    ? { ...standaloneCapabilities, configuredMcp: 'available' }
    : standaloneCapabilities;
  const system = standaloneSystemPrompt(workspaceRoots, mcp !== undefined);
  return createProductionHostPlatform({
    auth: host.auth,
    close: async () => {
      // MCP cleanup can still write OAuth records through the credential store.
      await mcp?.close();
      await host.close();
    },
    forgetThread: (threadId) => forgetSharedNativeToolThread(threadId, readFileCursorRegistry),
    ...(mcp ? { mcp: mcp.mcp } : {}),
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
        enabledNativeToolIds: STANDALONE_NATIVE_TOOL_IDS,
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
      if (
        request.snapshot &&
        !isDeepStrictEqual(request.snapshot.configuration['workspaceRoots'], workspaceRoots)
      ) {
        throw new Error("Captured run workspace roots differ from this host's launch roots");
      }
      const resolvedToolResultBudget = resolveScaledToolResultBudget(
        catalog.definition.contextWindow
      );
      const bindings = createStandaloneHumanTools(resolvedToolResultBudget);
      const workspaceTools = createSharedNativeHostTools({
        ids: STANDALONE_WORKSPACE_TOOL_IDS,
        readFileCursorRegistry,
        resolvedToolResultBudget,
        runtime: { ...configuration, workspaceRoots },
      });
      const toolTimeoutMs = resolveAssistantResilienceConfig().toolTimeoutMs;
      // Global hooks run as configured; a launch root's project file stays
      // untrusted (and is reported, not run) until the host owns its approval.
      const hooks = createHostRunHooks({
        globalPath: getGlobalHooksPath(),
        maxHookTimeoutMs: toolTimeoutMs,
        roots: workspaceRoots.map(({ path, rootId }) => ({ absPath: path, rootId })),
        sessionId: request.threadId,
      });
      return {
        configuration,
        durableConfiguration: {
          capabilities,
          intent,
          workspaceRoots: workspaceRoots.map(({ displayName, path, rootId }) => ({
            displayName,
            path,
            rootId,
          })),
        },
        ...(hooks ? { hooks } : {}),
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
        system,
        tools: { ...bindings.tools, ...workspaceTools },
        toolTimeoutMs,
      };
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    // The standalone host has no private desktop client: subscription auth refuses.
    resolveProviderAuth: (provider) => host.auth.resolveProviderAuth(provider, undefined),
    resolveWorkspaceRoot: async ({ rootId }) => {
      const root = workspaceRoots.find((candidate) => candidate.rootId === rootId);
      if (!root) {
        throw new Error("The workspace root is not one of this host's launch roots");
      }
      return root.path;
    },
    startup,
  });
}
