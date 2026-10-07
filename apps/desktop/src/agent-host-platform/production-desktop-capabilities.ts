import { homedir } from 'node:os';
import {
  createAssistantSkillTools,
  isSupportedProvider,
  type RuntimeData,
  resolveAssistantResilienceConfig,
} from '@brainstrike/agent';
import { collectCombinedTools, createMcpRuntimeClient } from '@brainstrike/agent/mcp-client';
import {
  DEFAULT_AGENT_MAX_STEPS,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  createMcpHostToolAdapter,
  type HostRunAdmissionRequest,
  type HostToolContext,
} from '@brainstrike/agent-host';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  DESKTOP_NATIVE_TOOLS,
  deriveAgentLoopInputTokenLimit,
  findLlmModelDefinition,
  resolveAutoObservationalMemoryModelTarget,
  resolveToolRiskCategory,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-repository';
import { z } from 'zod';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import {
  buildDesktopAssistantTools,
  type DesktopAssistantToolDependencies,
} from '../assistant-server/assistant-tools';
import { deriveAssistantTurnAuthInput } from '../assistant-server/provider-auth-input';
import { prepareRequestSkills } from '../assistant-server/request-skills';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';
import { loadWorkspaceRootsFromDatabase } from '../assistant-server/workspace-roots';
import { getDatabase } from '../db-main';
import { readDesktopMcpHostSnapshot } from '../ipc-mcp';
import { getDesktopMcpHostRuntime } from '../mcp/host-runtime';
import { readProviderCredential } from '../provider-api-key';
import { bindMcpTool } from './adapter-services';
import { readDesktopHostSystemContext } from './desktop-host-context';
import type { DesktopPlatformCapabilities, DesktopPlatformSelection } from './main-platform';
import {
  PlatformClientConfigurationSchema,
  PlatformModelConfigurationSchema,
  platformPermissionPolicy,
} from './platform-wire';

interface DesktopCatalogSelection {
  readonly definition: NonNullable<ReturnType<typeof findLlmModelDefinition>>;
  readonly model: string;
  readonly provider: SupportedProvider;
}

function desktopSystemFields(system: string | undefined): { readonly system?: string } {
  return system === undefined ? {} : { system };
}

function desktopDurableConfiguration(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  observerTarget: string | null,
  system: string | undefined
): DesktopPlatformSelection['durableConfiguration'] {
  return z.record(z.string(), z.json()).parse(
    JSON.parse(
      JSON.stringify({
        intent,
        ...desktopSystemFields(system),
        memoryResolution: {
          observationalMemory: desktopObservationResolution(
            intent.memorySettings.observationalMemory.enabled,
            observerTarget
          ),
          observerTarget,
        },
      })
    )
  );
}

function desktopInputTokenLimit(
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

function desktopObservationResolution(enabled: boolean, observerTarget: string | null): string {
  if (!enabled) {
    return 'disabled';
  }
  return observerTarget === null ? 'waiting-for-eligible-model' : 'resolved';
}
async function readDesktopCatalogSelection(
  db: Awaited<ReturnType<typeof getDatabase>>,
  modelId: string
): Promise<DesktopCatalogSelection> {
  const separator = modelId.indexOf('::');
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 2);
  if (separator < 1 || !isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported catalog identity');
  }
  // The UI composite is a selection key. The existing catalog owns the pair.
  const result = await db.query(
    'SELECT provider_id AS "providerId", is_enabled AS "isEnabled" FROM models WHERE id = $1 AND provider_id = $2',
    [model, provider]
  );
  const row = z
    .strictObject({ isEnabled: z.boolean(), providerId: z.string() })
    .parse(result.rows[0]);
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

async function readDesktopIntent(
  request: HostRunAdmissionRequest,
  catalog: DesktopCatalogSelection,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>
): Promise<z.output<typeof PlatformClientConfigurationSchema>> {
  const captured = request.configuration ?? request.snapshot?.configuration['intent'];
  return PlatformClientConfigurationSchema.parse(
    captured ?? {
      enabledNativeToolIds: DESKTOP_NATIVE_TOOLS.map((tool) => tool.id),
      memoryOptions: {
        lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
        workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
      },
      memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      modelConfiguration: { model: catalog.model, provider: catalog.provider },
      permissionPolicy: (await readPersistedPolicy?.()) ?? {
        policies: DEFAULT_PERMISSION_POLICIES,
        yolo: false,
      },
      workspaceInstructionsPreference: { masterEnabled: true, oversizedOptInByRootId: {} },
    }
  );
}

function resolveDesktopMemorySettings(
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  provider: string
): {
  memorySettings: z.output<typeof PlatformClientConfigurationSchema>['memorySettings'];
  observerTarget: string | null;
} {
  const observation = intent.memorySettings.observationalMemory;
  const observerTarget =
    observation.modelTarget === 'auto'
      ? resolveAutoObservationalMemoryModelTarget({
          chatProvider: provider,
          providersWithKeys: [provider],
        })
      : observation.modelTarget;
  const memorySettings = {
    ...intent.memorySettings,
    observationalMemory:
      observerTarget === null
        ? { ...observation, enabled: false }
        : { ...observation, modelTarget: observerTarget },
  };
  if (
    memorySettings.semanticRecall.enabled ||
    (memorySettings.observationalMemory.enabled &&
      memorySettings.observationalMemory.retrievalMode === 'vector')
  ) {
    throw new Error(
      'This Root is missing the canonical Memory vector capability; the requested Memory settings were preserved.'
    );
  }
  return { memorySettings, observerTarget };
}

async function createDesktopNativeTools(
  db: Awaited<ReturnType<typeof getDatabase>>,
  configuration: z.output<typeof PlatformModelConfigurationSchema>,
  intent: z.output<typeof PlatformClientConfigurationSchema>,
  dependencies: DesktopAssistantToolDependencies,
  budget: ReturnType<typeof resolveScaledToolResultBudget>
): Promise<{
  readonly runtime: RuntimeData;
  readonly tools: Record<string, import('@brainstrike/agent-host').HostTool>;
  readonly workspaceSkills?: import('@brainstrike/agent').ScannedWorkspaceSkills;
}> {
  const roots = await loadWorkspaceRootsFromDatabase(db);
  const focused = roots.find((root) => root.rootId === intent.selectionFolderId);
  if (intent.selectionFolderId && !focused) {
    throw new Error('The selected workspace root is no longer mounted');
  }
  const runtime: RuntimeData = {
    model: configuration.model,
    provider: configuration.provider,
    ...(configuration.modelSettings ? { modelSettings: configuration.modelSettings } : {}),
    ...(configuration.providerOptions ? { providerOptions: configuration.providerOptions } : {}),
    enabledNativeToolIds: intent.enabledNativeToolIds,
    ...(intent.workspaceContext
      ? {
          workspaceContext: JSON.parse(JSON.stringify(intent.workspaceContext)) as NonNullable<
            RuntimeData['workspaceContext']
          >,
        }
      : {}),
    workspaceInstructionsPreference: intent.workspaceInstructionsPreference,
    workspaceRoots: roots,
    ...(focused
      ? {
          selectionFilePaths:
            intent.workspaceContext?.files
              .filter((file) => file.rootId === focused.rootId)
              .map((file) => file.path) ?? [],
          selectionFolderId: focused.rootId,
          workspaceRootPath: focused.path,
        }
      : {}),
    ...(intent.skillsPreference ? { skillsPreference: intent.skillsPreference } : {}),
  };
  const { workspaceSkills } = prepareRequestSkills({
    fs: createSecureSkillsFs([...roots.map((root) => root.path), homedir()]),
    homedir,
    runtimeData: runtime,
  });
  const skillTools = workspaceSkills ? createAssistantSkillTools(workspaceSkills) : {};
  const nativeBindings = Object.fromEntries(
    [
      ...DESKTOP_NATIVE_TOOLS,
      ...Object.keys(skillTools).map(
        (id) => NATIVE_TOOL_REGISTRIES.byId[id as 'skill' | 'skill_read' | 'skill_search']
      ),
    ].map((tool) => [tool.id, { identity: tool.id, risk: resolveToolRiskCategory(tool.defaults) }])
  );
  const build = (context?: HostToolContext) =>
    createAgentHostToolBindings({
      bindings: nativeBindings,
      resolvedToolResultBudget: budget,
      tools: {
        ...buildDesktopAssistantTools(
          {
            ...runtime,
            ...(context
              ? {
                  memory: {
                    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
                    runId: context.runId,
                    threadId: context.threadId,
                  },
                }
              : {}),
          },
          {
            ...dependencies,
            ...(workspaceSkills ? { skillScriptResolver: workspaceSkills } : {}),
            resolvedToolResultBudget: budget,
          }
        ),
        ...skillTools,
      },
    });
  const native = build();
  const tools = Object.fromEntries(
    Object.entries(native.tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (input: unknown, context: HostToolContext): Promise<unknown> => {
          const executor = build(context).tools[name];
          if (!executor || executor.identity !== tool.identity) {
            throw new Error('Native executor changed after admission');
          }
          return executor.execute(input, context);
        },
      },
    ])
  );
  return { runtime, tools, ...(workspaceSkills ? { workspaceSkills } : {}) };
}

/** Lazy borrows: Root/New Thread never waits for indexing or credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopAssistantToolDependencies,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>
): DesktopPlatformCapabilities {
  const policies = new Map<string, PermissionToolGateSnapshot>();
  return {
    readConfiguration: async (request) => {
      const db = await getDatabase();
      request.signal.throwIfAborted();
      const catalog = await readDesktopCatalogSelection(db, request.modelId);
      const { definition } = catalog;
      const intent = await readDesktopIntent(request, catalog, readPersistedPolicy);
      const configuration = PlatformModelConfigurationSchema.parse(intent.modelConfiguration);
      const permissionPolicy = platformPermissionPolicy(intent.permissionPolicy);
      if (configuration.provider !== catalog.provider || configuration.model !== catalog.model) {
        throw new Error('Captured settings do not belong to the selected catalog model');
      }
      const inputTokenLimit = desktopInputTokenLimit(definition, intent, configuration);
      const { memorySettings, observerTarget } = resolveDesktopMemorySettings(
        intent,
        configuration.provider
      );
      const budget = resolveScaledToolResultBudget(definition.contextWindow);
      const native = await createDesktopNativeTools(
        db,
        configuration,
        intent,
        dependencies,
        budget
      );
      const { tools } = native;
      const runtimeMcp = getDesktopMcpHostRuntime();
      const before = await readDesktopMcpHostSnapshot(runtimeMcp);
      request.signal.throwIfAborted();
      const resilience = resolveAssistantResilienceConfig();
      const client = await createMcpRuntimeClient({
        config: undefined,
        host: runtimeMcp.host,
        mcpTaskTracking: runtimeMcp.taskHost,
        toolTimeoutMs: resilience.toolTimeoutMs,
      });
      let adapter: ReturnType<typeof createMcpHostToolAdapter> | undefined;
      let joined: Promise<void> | undefined;
      const close = (): Promise<void> =>
        (joined ??= (async () => {
          const failures: unknown[] = [];
          try {
            await adapter?.close();
          } catch (cause) {
            failures.push(cause);
          }
          try {
            await client?.disconnect();
          } catch (cause) {
            failures.push(cause);
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, 'Desktop borrowed MCP cleanup failed');
          }
          if (policies.get(request.threadId) === permissionPolicy) {
            policies.delete(request.threadId);
          }
        })());
      try {
        const names = new Map<string, string>();
        const collection = await collectCombinedTools({
          durableArtifactSettlement: false,
          mcpClient: client,
          mcpConfig: undefined,
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: budget.transportResultTokens,
          timeoutOverrideMs: undefined,
          toolNameMap: names,
        });
        request.signal.throwIfAborted();
        if (collection.mcpDiscoverySkips.length > 0) {
          throw new Error('Configured MCP tools could not be admitted');
        }
        const after = runtimeMcp.host.snapshot();
        adapter = createMcpHostToolAdapter({
          bindings: Object.fromEntries(
            Object.entries(collection.tools).map(([name, source]) => [
              name,
              bindMcpTool({
                after,
                before,
                canonicalId: names.get(name) ?? name,
                resolvedToolResultBudget: budget,
                runtime: runtimeMcp,
                ...(request.snapshot ? { snapshot: request.snapshot } : {}),
                source,
                toolId: name,
                toolTimeoutMs: resilience.toolTimeoutMs,
              }),
            ])
          ),
          host: runtimeMcp.host,
        });
        for (const [name, tool] of Object.entries(adapter.tools)) {
          if (Object.hasOwn(tools, name)) {
            throw new Error('Native and MCP catalog identities collide');
          }
          tools[name] = tool;
        }
        policies.set(request.threadId, permissionPolicy);
        const system = await readDesktopHostSystemContext({
          inputTokenLimit,
          request,
          runtime: native.runtime,
          tools,
          ...(native.workspaceSkills ? { workspaceSkills: native.workspaceSkills } : {}),
        });
        return {
          close,
          configuration,
          contextWindow: definition.contextWindow,
          durableConfiguration: desktopDurableConfiguration(intent, observerTarget, system),
          inputTokenLimit,
          maxSteps: intent.agentLoop?.maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
          memory: { options: intent.memoryOptions, settings: memorySettings },
          resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
          ...desktopSystemFields(system),
          tools,
          toolTimeoutMs: resilience.toolTimeoutMs,
        };
      } catch (cause) {
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Desktop configuration and cleanup failed');
        }
        throw cause;
      }
    },
    readPermissionPolicy: async (threadId) => {
      const captured = threadId ? policies.get(threadId) : undefined;
      const persisted = await readPersistedPolicy?.();
      return platformPermissionPolicy(
        persisted
          ? {
              ...persisted,
              ...(captured?.sessionGrants ? { sessionGrants: captured.sessionGrants } : {}),
            }
          : (captured ?? { policies: DEFAULT_PERMISSION_POLICIES, yolo: false })
      );
    },
    resolveProviderAuth: async (provider) => {
      if (!isSupportedProvider(provider)) {
        throw new Error('Unsupported provider credential request');
      }
      return deriveAssistantTurnAuthInput({ provider }, await readProviderCredential(provider));
    },
  };
}
