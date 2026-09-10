/**
 * The runtime tool pipeline: everything between the caller-supplied local tool
 * map and the final model-projected tool map the Agent receives. Extracted from
 * `createMastraAgentRuntime` (BST-742).
 *
 * ORDER IS LOAD-BEARING (docs/agents/assistant-runtime.md, "Raw/model
 * tool-output split"):
 *   skills-merge → sanitize/discover → timeout guard → lifecycle hooks →
 *   plan/permission/suspend gates → provider-native swap → artifact
 *   settlement → model-output projection.
 * `composeRuntimeToolMap` owns the first phase (through artifact settlement);
 * `prepareHostedToolDiscovery` owns the discovery + model-projection phase and
 * runs after the caller has resolved the language model.
 */

import type { McpHostPort } from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_ID, resolveToolDiscoveryAdapter } from '@brainstrike/assistant-contract';
import {
  findProviderDefinition,
  resolveTokenMeasurementCapability,
} from '@brainstrike/assistant-contract/provider-registry';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
import type { MastraDBMessage, ToolsInput } from '@mastra/core/agent';
import type { WorkspaceSkills } from '@mastra/core/skills';
import {
  type AssistantResilienceConfig,
  resolveAssistantResilienceConfig,
} from '../../config/resilience-config';
import type { McpConfig } from '../../mcp/config';
import type { McpTaskTrackingCapability } from '../../mcp/task-tracking';
import { createListingOnlyModel } from '../../providers/listing-only-model';
import { applyProviderNativeWebSearch } from '../../providers/native-web-search';
import type { ProviderAuthInput } from '../../providers/provider-auth-input';
import { createAssistantSkillTools } from '../../skills/skill-tools';
import type { ScaledToolResultBudget } from '../../stream/tool-output-limits';
import { applyToolGuards } from '../../tools/guard-tool-execution';
import type { AgentHookRunner } from '../../tools/hook-runner';
import { applyToolHooks } from '../../tools/hook-tool-wrap';
import {
  createToolExecutionDurations,
  type ToolExecutionDurations,
} from '../../tools/tool-execution-durations';
import { createMastraAgentError } from '../mastra-agent-error';
import {
  createMcpAppToolAdmissionCapability,
  type McpAppToolAdmissionCapability,
} from '../mcp-app-tool-call';
import type { McpDiscoverySkip } from '../mcp-discovery-diagnostics';
import { createMcpRuntimeClient, type McpRuntimeClient } from '../mcp-runtime-client';
import { collectCombinedTools } from '../mcp-tool-loader';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionAskToolMetadata,
  type PermissionToolGateSnapshot,
} from '../permission-tool-gate';
import { filterToolsForPlanMode, resolveSuspendToolsForRun } from '../plan-mode-tool-gate';
import { ProjectionSafeToolCallFilter } from '../projection-safe-tool-call-filter';
import type { ResolvedRuntimeConfiguration } from '../runtime-configuration';
import { createRunTokenDiagnostics, type RunTokenDiagnostics } from '../token-measurement';
import { applyToolModelOutputProjections, wouldTruncateMcpModelOutput } from '../tool-model-output';
import {
  applyToolOutputArtifactSettlement,
  type ToolOutputArtifactSettlementStore,
} from '../tool-output-artifact-settlement';
import { sanitizeToolName, sanitizeTools } from '../tool-sanitizer';
import {
  BrainstrikeToolSearchProcessor,
  resolveToolDiscoverySurface,
  type ToolDiscoverySurface,
} from '../tool-search-runtime';

const logger = createLogger('MastraAgent');

interface ResolvedAskTools {
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  tools: ToolsInput;
}

/**
 * Reconcile the gate result with whether the run can suspend-then-resume for
 * approval (i.e. whether Mastra workflow storage is configured).
 *
 * The gate already marked each `'ask'` tool with the PER-TOOL `requireApproval`
 * flag (only the ask tool suspends; allowed tools run free). This function only
 * decides whether those ask tools may STAY:
 * - With storage: keep them (their per-tool flag suspends on call) and carry
 *   `askTools` for the approval-pause risk hint. Logged so the gate is observable.
 * - Without storage: the resume path (`streamMastraToolApprovalAction`) throws,
 *   so a suspend could never resume. We must NOT run an approval-required tool
 *   unprompted (no-silent-fallbacks), so we fall back to the conservative
 *   FAIL-SAFE — OMIT the `'ask'` tools from the map (logged) and return an empty
 *   `askTools`, exactly as the engine did before per-call approval landed.
 */
function resolveAskToolsForRun(
  gateResult: {
    tools: ToolsInput;
    askToolIds: ReadonlySet<string>;
    askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  },
  canSuspendForApproval: boolean
): ResolvedAskTools {
  if (gateResult.askToolIds.size === 0) {
    return { askTools: gateResult.askTools, tools: gateResult.tools };
  }

  if (!canSuspendForApproval) {
    const reducedTools: Record<string, unknown> = {};
    for (const [sanitizedId, tool] of Object.entries(gateResult.tools)) {
      if (gateResult.askToolIds.has(sanitizedId)) {
        const meta = gateResult.askTools.get(sanitizedId);
        logger.warn(
          "Tool gated to 'ask' but no storage to suspend for approval; omitting (fail-safe)",
          {
            code: 'permission_tool_gate_ask_omitted_no_storage',
            riskCategory: meta?.riskCategory,
            sanitizedId,
            tool: meta?.originalName ?? sanitizedId,
          }
        );
        continue;
      }
      reducedTools[sanitizedId] = tool;
    }
    return { askTools: new Map(), tools: reducedTools as ToolsInput };
  }

  // Each ask tool carries the per-tool requireApproval flag and will suspend ONLY
  // when actually called. Logged so the gated tools are observable.
  logger.info('Permission policy requires per-call approval for ask tools', {
    askToolCount: gateResult.askToolIds.size,
    askTools: Array.from(gateResult.askTools.values()).map((meta) => ({
      riskCategory: meta.riskCategory,
      tool: meta.originalName,
    })),
    code: 'permission_tool_gate_require_approval',
  });
  return { askTools: gateResult.askTools, tools: gateResult.tools };
}

interface GatedToolMapParams {
  readonly hasStorage: boolean;
  readonly hookedTools: ToolsInput;
  readonly permissionSnapshot: PermissionToolGateSnapshot | undefined;
  readonly planModeActive: boolean;
  readonly toolNameMap: Map<string, string>;
}

/**
 * Assemble the FINAL tool map the Agent receives: plan-mode filter → permission
 * gate → suspend-storage gate. The plan/permission/suspend conditionals live in
 * one cohesive place. Each stage only omits tools; see the inline invariants in
 * `composeRuntimeToolMap`.
 */
function resolveGatedToolMap(params: GatedToolMapParams): {
  readonly gatedTools: ToolsInput;
  readonly askTools: ResolvedAskTools['askTools'];
} {
  const planFilteredTools = params.planModeActive
    ? filterToolsForPlanMode(
        params.hookedTools,
        params.toolNameMap,
        params.permissionSnapshot?.riskByTool ?? buildNativeToolRiskMap(),
        logger
      )
    : params.hookedTools;

  const gateResult = filterToolsByPermissionWithMetadata(
    planFilteredTools,
    params.permissionSnapshot,
    params.toolNameMap,
    logger
  );
  const { tools: askResolvedTools, askTools } = resolveAskToolsForRun(
    gateResult,
    params.hasStorage
  );
  // Fail-safe: a tool that pauses via suspend() cannot resume without workflow
  // storage, so omit the suspending tools when storage is absent (never run one
  // that would wedge the run — no-silent-fallbacks).
  const gatedTools = resolveSuspendToolsForRun(
    askResolvedTools,
    params.hasStorage,
    params.toolNameMap,
    logger
  );
  return { askTools, gatedTools };
}

/**
 * Fold the skill tools into the local tool map (skills engine present) — a
 * caller-supplied tool with a colliding id wins, loudly. Returns the original
 * map untouched when no engine is attached.
 */
function mergeSkillToolsIntoLocalTools(
  localTools: ToolsInput | undefined,
  workspaceSkills: WorkspaceSkills | undefined
): ToolsInput | undefined {
  if (!workspaceSkills) {
    return localTools;
  }
  const skillTools = createAssistantSkillTools(workspaceSkills);
  for (const skillToolId of Object.keys(skillTools)) {
    if (localTools && skillToolId in localTools) {
      logger.error('Local tool id collides with a reserved skill tool id; keeping the local tool', {
        toolId: skillToolId,
      });
    }
  }
  return { ...skillTools, ...localTools } as ToolsInput;
}

function applyRuntimeToolHooks(params: {
  durations: ToolExecutionDurations;
  guardedTools: ToolsInput;
  hookRunner: AgentHookRunner | undefined;
  toolNameMap: ReadonlyMap<string, string>;
}): ToolsInput {
  if (!params.hookRunner) {
    return params.guardedTools;
  }
  return applyToolHooks(params.guardedTools, {
    // A PreToolUse BLOCK returns without reaching the guard, so the hook layer
    // records that short-circuit itself — otherwise the consumer falls back to
    // a timestamp gap that includes the approval wait.
    durations: params.durations,
    hookRunner: params.hookRunner,
    logger,
    toolNameMap: params.toolNameMap,
  });
}

export function resolveEligibleArtifactReaderName(
  tools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>
): string {
  const names = Object.keys(tools).filter(
    (id) => toolNameMap.get(id) === NATIVE_TOOL_ID.readToolOutputArtifact
  );
  const name = names[0];
  if (names.length !== 1 || !name) {
    throw new Error('Durable tool output requires one eligible artifact reader.');
  }
  return name;
}

function settleRuntimeToolOutputs(params: {
  requireExecutionThreadId?: boolean;
  getDelegationToolNames: (() => readonly string[]) | undefined;
  inlineMaxSerializedCharsByToolName: ReadonlyMap<string, number> | undefined;
  store: ToolOutputArtifactSettlementStore | undefined;
  toolNameMap: ReadonlyMap<string, string>;
  tools: ToolsInput;
  mcpToolNames: ReadonlySet<string>;
  resolvedToolResultBudget: ScaledToolResultBudget;
}): ToolsInput {
  if (!params.store) {
    return params.tools;
  }
  return applyToolOutputArtifactSettlement(params.tools, {
    ...(params.requireExecutionThreadId ? { requireExecutionThreadId: true } : {}),
    ...(params.getDelegationToolNames
      ? { getDelegationToolNames: params.getDelegationToolNames }
      : {}),
    ...(params.inlineMaxSerializedCharsByToolName
      ? { inlineMaxSerializedCharsByToolName: params.inlineMaxSerializedCharsByToolName }
      : {}),
    getReaderToolName: () => resolveEligibleArtifactReaderName(params.tools, params.toolNameMap),
    store: params.store,
    toolNameMap: params.toolNameMap,
    wouldTruncateModelOutput: (toolName, output) =>
      params.mcpToolNames.has(toolName) &&
      wouldTruncateMcpModelOutput(toolName, output, params.resolvedToolResultBudget),
  });
}

// `load_tool` is reserved since BST-1667: manual loading exposes Mastra's
// exact-selection meta-tool on every discovery step.
const MASTRA_CATALOG_META_TOOL_IDS = new Set(['search_tools', 'load_tool', 'list_available_tools']);

function assertCatalogMetaToolNamesAvailable(params: {
  eligibleTools: ToolsInput;
  toolNameMap: ReadonlyMap<string, string>;
}): void {
  for (const registeredToolId of Object.keys(params.eligibleTools)) {
    const originalToolId = params.toolNameMap.get(registeredToolId) ?? registeredToolId;
    const sanitizedToolId = sanitizeToolName(originalToolId);
    if (!MASTRA_CATALOG_META_TOOL_IDS.has(sanitizedToolId)) {
      continue;
    }
    throw createMastraAgentError('mastra_agent_tool_name_collision', {
      context: {
        originalToolId,
        reservedToolId: sanitizedToolId,
        sanitizedToolId,
      },
      detail: `Tool ${originalToolId} sanitizes to reserved catalog meta-tool id ${sanitizedToolId}`,
    });
  }
}

function isHostedProviderRuntime(provider: ResolvedRuntimeConfiguration['provider']): boolean {
  // Registry-derived (BST-1349) with FAIL-OPEN polarity (PR #2513 review,
  // finding 4): only the known local runtimes opt out of the hosted path, so
  // an unknown id or a future runtime value keeps the pre-BST-1349 hosted
  // default. Guarded lookup: an out-of-registry id must not TypeError.
  const runtime = findProviderDefinition(provider)?.runtime;
  return runtime !== 'local' && runtime !== 'browser';
}

export async function prepareHostedToolDiscovery(params: {
  eligibleTools: ToolsInput;
  localToolIds: ReadonlySet<string>;
  modelName: string;
  persistedDiscoveryMessages?: () => Promise<readonly MastraDBMessage[]>;
  provider: ResolvedRuntimeConfiguration['provider'];
  resolvedToolResultBudget: ScaledToolResultBudget;
  toolNameMap: ReadonlyMap<string, string>;
}): Promise<{
  discoverySurface?: ToolDiscoverySurface;
  modelProjectedTools: ToolsInput;
  tokenDiagnostics: RunTokenDiagnostics;
  toolSearchProcessor?: BrainstrikeToolSearchProcessor;
}> {
  const isHosted = isHostedProviderRuntime(params.provider);
  const discoveryResolution = isHosted
    ? resolveToolDiscoveryAdapter({
        modelId: params.modelName,
        provider: params.provider,
        requestedAdapter: 'mastra-catalog-search',
      })
    : undefined;
  if (discoveryResolution?.status === 'unsupported') {
    throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
      context: {
        phase: 'adapter-resolution',
        provider: params.provider,
        reason: discoveryResolution.reason,
        requestedAdapter: 'mastra-catalog-search',
      },
      detail: `Mastra catalog discovery is unsupported for ${params.provider}/${params.modelName}: ${discoveryResolution.reason}`,
    });
  }

  const discoverySurface = discoveryResolution
    ? resolveToolDiscoverySurface({
        adapter: discoveryResolution.adapter,
        eligibleTools: params.eligibleTools,
        localToolIds: params.localToolIds,
        toolNameMap: params.toolNameMap,
      })
    : undefined;
  const hasDeferredTools = Boolean(
    discoverySurface && Object.keys(discoverySurface.deferredTools).length > 0
  );
  if (hasDeferredTools) {
    assertCatalogMetaToolNamesAvailable(params);
  }
  const initialTools = discoverySurface?.coreTools ?? params.eligibleTools;
  const tokenDiagnostics = await createRunTokenDiagnostics({
    capability: resolveTokenMeasurementCapability(params.provider, params.modelName),
    resolvedToolResultBudget: params.resolvedToolResultBudget,
    tools: initialTools,
  });
  const recordModelOutput = (toolId: string, output: unknown): void =>
    tokenDiagnostics.recordModelOutput(toolId, output);
  const modelProjectedTools = applyToolModelOutputProjections(
    initialTools,
    params.toolNameMap,
    recordModelOutput,
    params.resolvedToolResultBudget
  );
  const modelProjectedDeferredTools =
    hasDeferredTools && discoverySurface
      ? applyToolModelOutputProjections(
          discoverySurface.deferredTools,
          params.toolNameMap,
          recordModelOutput,
          params.resolvedToolResultBudget
        )
      : undefined;
  const toolSearchProcessor = modelProjectedDeferredTools
    ? new BrainstrikeToolSearchProcessor({
        deferredTools: modelProjectedDeferredTools,
        ...(params.persistedDiscoveryMessages
          ? { loadPersistedMessages: params.persistedDiscoveryMessages }
          : {}),
        // This field is required by ProcessInputStepArgs but is never consulted
        // by Mastra's context-store parser. Use the existing fail-loud inert
        // model so any future accidental invocation cannot perform inference.
        model: createListingOnlyModel(),
        onToolsLoaded: (tools) => tokenDiagnostics.recordAdditionalToolDefinitions(tools),
        toolNameMap: params.toolNameMap,
      })
    : undefined;

  if (discoverySurface) {
    logger.info('Mastra tool discovery surface selected', {
      adapter: discoverySurface.metadata.adapter,
      code: 'mastra_tool_discovery_surface',
      coreToolIds: discoverySurface.metadata.coreToolIds,
      deferredToolIds: discoverySurface.metadata.deferredToolIds,
      eligibleToolIds: discoverySurface.metadata.eligibleToolIds,
    });
  }

  return {
    ...(discoverySurface ? { discoverySurface } : {}),
    modelProjectedTools,
    tokenDiagnostics,
    ...(toolSearchProcessor ? { toolSearchProcessor } : {}),
  };
}

export function createToolHistoryFilter(
  provider: ResolvedRuntimeConfiguration['provider'],
  toolNameMap: ReadonlyMap<string, string>
): ProjectionSafeToolCallFilter | undefined {
  if (!isHostedProviderRuntime(provider)) {
    return;
  }
  return new ProjectionSafeToolCallFilter({ toolNameMap });
}

export interface RuntimeToolMapParams {
  /**
   * The run's resolved ProviderAuthInput (BST-1352): consumed by the
   * provider-native web-search swap so its second SDK client is built through
   * the same auth seam as the chat model (never from a bare key).
   */
  auth: ProviderAuthInput | undefined;
  getDelegationToolNames: (() => readonly string[]) | undefined;
  hasStorage: boolean;
  hookRunner: AgentHookRunner | undefined;
  inlineMaxSerializedCharsByToolName: ReadonlyMap<string, number> | undefined;
  localTools: ToolsInput | undefined;
  mcpConfig: McpConfig | undefined;
  mcpHost: McpHostPort | undefined;
  /** Host-owned MCP Tasks tracking; absent makes a task result a hard error. */
  mcpTaskTracking: McpTaskTrackingCapability | undefined;
  mcpTimeoutMs: number | undefined;
  permissionSnapshot: PermissionToolGateSnapshot | undefined;
  planModeActive: boolean;
  preserveExecuteBackedWebSearch: boolean | undefined;
  provider: ResolvedRuntimeConfiguration['provider'];
  resolvedToolResultBudget: ScaledToolResultBudget;
  toolOutputArtifactStore: ToolOutputArtifactSettlementStore | undefined;
  workspaceSkills: WorkspaceSkills | undefined;
}

export interface RuntimeToolMapResult {
  /** Post-settlement tool map — the discovery/projection phase's input. */
  artifactSettledTools: ToolsInput;
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  /** Pre-permission-gate map; persona subagents re-gate it independently. */
  guardedTools: ToolsInput;
  /** Apps admission surface captured only after ordinary runtime admission. */
  mcpAppToolAdmission: McpAppToolAdmissionCapability;
  mcpClient: McpRuntimeClient | undefined;
  /**
   * Every MCP server that contributed ZERO tools to this run (BST-1602). Empty
   * when discovery was healthy. Carried, never swallowed: the run answers with
   * a materially reduced tool surface and the user is owed that fact.
   */
  mcpDiscoverySkips: readonly McpDiscoverySkip[];
  resilienceConfig: AssistantResilienceConfig;
  sanitizedLocalToolIds: ReadonlySet<string>;
  /** Apply the same settlement policy to an independently gated child tool map. */
  settleChildToolOutputs: (tools: ToolsInput, budget: ScaledToolResultBudget) => ToolsInput;
  /** Real per-call execution time, written by the guard wrapper. */
  toolExecutionDurations: ToolExecutionDurations;
  toolNameMap: Map<string, string>;
}

/**
 * Phase 1 of the tool pipeline: compose the gated, settled tool map from the
 * caller-supplied local tools + MCP discovery. The returned `mcpClient`'s
 * ownership stays with the caller (it is disconnected on later init failure and
 * by the runtime's `dispose`).
 */
export async function composeRuntimeToolMap(
  params: RuntimeToolMapParams
): Promise<RuntimeToolMapResult> {
  // Resolved first: the MCP task settlement wait is capped under the same
  // guard ceiling applyToolGuards enforces below.
  const resilienceConfig = resolveAssistantResilienceConfig();
  const mcpClient = await createMcpRuntimeClient({
    config: params.mcpConfig,
    ...(params.mcpHost ? { host: params.mcpHost } : {}),
    ...(params.mcpTaskTracking
      ? {
          mcpTaskTracking: params.mcpTaskTracking,
          toolTimeoutMs: resilienceConfig.toolTimeoutMs,
        }
      : {}),
  });

  // Agent Skills (desktop-injected engine): fold Mastra's canonical
  // skill/skill_read/skill_search tools into the LOCAL tool map BEFORE
  // sanitize/guards/hooks/plan-mode/permission — never via the Agent-level
  // `skills` option, whose auto-added tools would bypass that whole pipeline
  // (the adoption blocker recorded in docs/agents/workspace-context.md).
  // Excluded for the built-in local provider (mirrors the task-list/plan-mode
  // local gating: the 2B on-device model's context budget cannot afford skill
  // payloads).
  const localToolsWithSkills = mergeSkillToolsIntoLocalTools(
    params.localTools,
    params.provider === 'local' ? undefined : params.workspaceSkills
  );

  const toolNameMap = new Map<string, string>();
  const sanitizedLocalTools = sanitizeTools(localToolsWithSkills, toolNameMap);
  const sanitizedLocalToolIds = new Set(Object.keys(sanitizedLocalTools ?? {}));
  const { mcpDiscoverySkips, tools: combinedTools } = await collectCombinedTools({
    durableArtifactSettlement: Boolean(params.toolOutputArtifactStore),
    mcpClient,
    // The injected host snapshot is the sole server/configuration authority.
    // Legacy serialized config is only meaningful on the no-host path above.
    mcpConfig: params.mcpHost ? undefined : params.mcpConfig,
    sanitizedLocalTools,
    scaledDefaultTokens: params.resolvedToolResultBudget.transportResultTokens,
    timeoutOverrideMs: params.mcpTimeoutMs,
    toolNameMap,
  });
  // Collection adds only MCP entries to the already-sanitized local registry.
  // Capture that provenance before provider controls can change the final map.
  const mcpToolNames = new Set(
    Object.keys(combinedTools)
      .filter((id) => !sanitizedLocalToolIds.has(id))
      .map((id) => {
        const original = toolNameMap.get(id);
        if (!original) {
          throw new Error(`Collected MCP tool ${id} is missing its original name.`);
        }
        return original;
      })
  );
  // Intentional global guard: every native and MCP tool execution shares this
  // ceiling so a single slow tool cannot freeze the assistant stream.
  // Per-runtime, which is per request. The guard is the only layer that sees
  // real execution time; an approval-gated call's stream timestamps span the
  // human wait instead (see tool-execution-durations.ts).
  const toolExecutionDurations = createToolExecutionDurations();
  const guardedTools = applyToolGuards(combinedTools, {
    durations: toolExecutionDurations,
    logger,
    timeoutMs: resilienceConfig.toolTimeoutMs,
  });

  // Tool-lifecycle hooks (desktop): compose OUTSIDE the guard, BEFORE the
  // permission gate. A PreToolUse hook can BLOCK an already-permitted tool but
  // can never widen access — permission runs downstream of `execute`, so a hook
  // only ever sees a tool the policy already allowed (hooks REFINE, never widen).
  const hookedTools = applyRuntimeToolHooks({
    durations: toolExecutionDurations,
    guardedTools,
    hookRunner: params.hookRunner,
    toolNameMap,
  });

  // Permission gate: filter the tool map by the user's policy BEFORE the Agent
  // is constructed (the Agent is immutable after `new Agent`). 'deny' omits the
  // tool from the map the model sees; 'ask' KEEPS a CLONE of the tool carrying
  // Mastra's PER-TOOL `requireApproval: true` (and records its id in `askTools`)
  // so Mastra suspends for approval ONLY when that tool is actually called —
  // allowed read/mcp tools in the same run still run free. We do NOT force the
  // run-wide requireToolApproval (see permission-tool-gate.ts + streamMastraAgent).
  // When no policy is threaded the map is returned unchanged (production-default)
  // with an empty askTools.
  //
  // Plan mode (opt-in, per-request; NEVER for the built-in local provider):
  // constrain the tool map to read/mcp + the suspending tools (submitPlan/
  // askUser) and omit every edit/execute tool, BEFORE the permission gate (a
  // dropped mutation tool is dropped regardless of allow/ask/deny). The risk map
  // is the authoritative static registry classification (never client-supplied).
  const { gatedTools, askTools } = resolveGatedToolMap({
    hasStorage: params.hasStorage,
    hookedTools,
    permissionSnapshot: params.permissionSnapshot,
    planModeActive: params.planModeActive,
    toolNameMap,
  });
  const mcpAppToolAdmission = createMcpAppToolAdmissionCapability({
    askTools,
    ...(params.permissionSnapshot?.defaultRisk
      ? { defaultRisk: params.permissionSnapshot.defaultRisk }
      : {}),
    ...(params.permissionSnapshot?.riskByTool
      ? { riskByTool: params.permissionSnapshot.riskByTool }
      : {}),
    toolNameMap,
    tools: gatedTools,
  });

  // Provider-native web search (v1: anthropic/openai only). Runs AFTER the gate
  // so it uses the gate's authoritative decision — swap the web-search entry to
  // the provider-executed tool ONLY when it resolved to `allow`; on `ask`/`deny`
  // the execute-backed Tavily tool stays (a provider-native tool has no execute
  // and cannot be approval-gated). Guarded to supported providers, so every other
  // caller/path is unchanged (see native-web-search.ts).
  const finalTools = applyProviderNativeWebSearch({
    askTools,
    auth: params.auth,
    logger,
    preserveExecuteBackedWebSearch: params.preserveExecuteBackedWebSearch,
    provider: params.provider,
    toolNameMap,
    tools: gatedTools,
  });
  const artifactSettledTools = settleRuntimeToolOutputs({
    getDelegationToolNames: params.getDelegationToolNames,
    inlineMaxSerializedCharsByToolName: params.inlineMaxSerializedCharsByToolName,
    mcpToolNames,
    resolvedToolResultBudget: params.resolvedToolResultBudget,
    store: params.toolOutputArtifactStore,
    toolNameMap,
    tools: finalTools,
  });

  return {
    artifactSettledTools,
    askTools,
    guardedTools,
    mcpAppToolAdmission,
    mcpClient,
    mcpDiscoverySkips,
    resilienceConfig,
    sanitizedLocalToolIds,
    settleChildToolOutputs: (tools, budget) =>
      settleRuntimeToolOutputs({
        getDelegationToolNames: undefined,
        inlineMaxSerializedCharsByToolName: params.inlineMaxSerializedCharsByToolName,
        mcpToolNames,
        requireExecutionThreadId: true,
        resolvedToolResultBudget: budget,
        store: params.toolOutputArtifactStore,
        toolNameMap,
        tools,
      }),
    toolExecutionDurations,
    toolNameMap,
  };
}
