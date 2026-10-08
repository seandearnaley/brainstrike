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

import type { McpHostPort, NativeToolExecutionBudget } from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_EXECUTION_BUDGETS, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { resolveTokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
import type { MastraDBMessage, ToolsInput } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
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
import { resolveToolGuardBudget } from '../../tools/resolve-tool-guard-budget';
import {
  createToolExecutionDurations,
  type ToolExecutionDurations,
} from '../../tools/tool-execution-durations';
import {
  applyLiveApprovalGate,
  createApprovalGate,
  type RuntimeApprovalGate,
} from '../approval-gate';
import { createMastraAgentError } from '../mastra-agent-error';
import {
  createMcpAppToolAdmissionCapability,
  type McpAppToolAdmissionCapability,
} from '../mcp-app-tool-call';
import type { McpDiscoverySkip } from '../mcp-discovery-diagnostics';
import { createMcpRuntimeClient, type McpRuntimeClient } from '../mcp-runtime-client';
import { collectCombinedTools } from '../mcp-tool-loader';
import { type PermissionGateSummary, summarizePermissionGate } from '../permission-gate-run-events';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionAskToolMetadata,
  type PermissionToolGateSnapshot,
} from '../permission-tool-gate';
import { filterToolsForPlanMode, resolveSuspendToolsForRun } from '../plan-mode-tool-gate';
import { ProjectionSafeToolCallFilter } from '../projection-safe-tool-call-filter';
import type { ResolvedRuntimeConfiguration } from '../runtime-configuration';
import { createRunTokenDiagnostics, type RunTokenDiagnostics } from '../token-measurement';
import type { ModelOutputProjectionObserver } from '../tool-model-output';
import { applyToolModelOutputProjections, wouldTruncateMcpModelOutput } from '../tool-model-output';
import {
  applyToolOutputArtifactSettlement,
  type ToolOutputArtifactSettlementStore,
} from '../tool-output-artifact-settlement';
import { sanitizeToolName, sanitizeTools } from '../tool-sanitizer';
import {
  BrainstrikeToolSearchProcessor,
  isHostedProviderRuntime,
  resolveHostedToolDiscoveryAdapter,
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
 * The gate recorded each `'ask'` tool in `askTools`; `applyLiveApprovalGate`
 * (approval-gate.ts) then clones the ones that stay with the FUNCTION-form
 * per-tool `requireApproval` (only the ask tool suspends; allowed tools run
 * free). This function only decides whether those ask tools may STAY:
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

  // Each ask tool gets the function-form per-tool requireApproval flag and will
  // suspend ONLY when actually called. Logged so the gated tools are observable.
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
  /** The leg's remembered live grant (`liveDecisions.remembered`), read per call. */
  readonly remembered: () => PermissionToolGateSnapshot | undefined;
  readonly toolNameMap: Map<string, string>;
}

/**
 * Assemble the FINAL tool map the Agent receives: plan-mode filter → permission
 * gate → suspend-storage gate → live approval gate. The plan/permission/suspend
 * conditionals live in one cohesive place. Each stage only omits tools (the
 * live gate clones); see the inline invariants in `composeRuntimeToolMap`.
 */
function resolveGatedToolMap(params: GatedToolMapParams): {
  readonly approvalGate: RuntimeApprovalGate;
  readonly gatedTools: ToolsInput;
  readonly askTools: ResolvedAskTools['askTools'];
  readonly permissionGate: PermissionGateSummary | null;
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
  // The live gate (approval-gate.ts): every ask tool that STAYS is cloned with
  // the function-form per-tool flag, evaluated by Mastra on each call against
  // this ask set and the leg's remembered grant.
  const approvalGate = createApprovalGate({
    askTools,
    permissionEnforced: params.permissionSnapshot !== undefined,
    remembered: params.remembered,
    toolNameMap: params.toolNameMap,
  });
  const liveGatedTools = applyLiveApprovalGate(
    askResolvedTools,
    new Set(askTools.keys()),
    approvalGate
  );
  // Fail-safe: a tool that pauses via suspend() cannot resume without workflow
  // storage, so omit the suspending tools when storage is absent (never run one
  // that would wedge the run — no-silent-fallbacks).
  const gatedTools = resolveSuspendToolsForRun(
    liveGatedTools,
    params.hasStorage,
    params.toolNameMap,
    logger
  );
  // Debug-pack evidence of the gate this Agent is built with: the KEPT ask set
  // (what the live gate suspends), denials, and any storage fail-safe omissions.
  const permissionGate = summarizePermissionGate({
    deniedTools: gateResult.deniedTools,
    gatedAskTools: gateResult.askTools,
    keptAskTools: askTools,
    snapshot: params.permissionSnapshot,
  });
  return { approvalGate, askTools, gatedTools, permissionGate };
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

export async function prepareHostedToolDiscovery(params: {
  eligibleTools: ToolsInput;
  localToolIds: ReadonlySet<string>;
  modelName: string;
  persistedDiscoveryMessages?: (
    requestContext?: RequestContext
  ) => Promise<readonly MastraDBMessage[]>;
  toolOutputObserver?: ModelOutputProjectionObserver;
  provider: ResolvedRuntimeConfiguration['provider'];
  resolvedToolResultBudget: ScaledToolResultBudget;
  toolNameMap: ReadonlyMap<string, string>;
}): Promise<{
  discoverySurface?: ToolDiscoverySurface;
  modelProjectedTools: ToolsInput;
  tokenDiagnostics: RunTokenDiagnostics;
  toolSearchProcessor?: BrainstrikeToolSearchProcessor;
}> {
  const discoveryAdapter = resolveHostedToolDiscoveryAdapter(params.provider, params.modelName);

  const discoverySurface = discoveryAdapter
    ? resolveToolDiscoverySurface({
        adapter: discoveryAdapter,
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
  const recordModelOutput = (toolId: string, output: unknown): void => {
    tokenDiagnostics.recordModelOutput(toolId, output);
    params.toolOutputObserver?.(toolId, output);
  };
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
  /** The leg's remembered live grant (`liveDecisions.remembered`), read per call. */
  remembered: () => PermissionToolGateSnapshot | undefined;
  resolvedToolResultBudget: ScaledToolResultBudget;
  toolOutputArtifactStore: ToolOutputArtifactSettlementStore | undefined;
  workspaceSkills: WorkspaceSkills | undefined;
}

export interface RuntimeToolMapResult {
  /** The live approval gate the ask tools' function-form flags forward to. */
  approvalGate: RuntimeApprovalGate;
  /** Post-settlement tool map — the discovery/projection phase's input. */
  artifactSettledTools: ToolsInput;
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  /** Post-lifecycle-hook, pre-permission map; children re-gate it independently. */
  hookedTools: ToolsInput;
  /** Apps admission surface captured only after ordinary runtime admission. */
  mcpAppToolAdmission: McpAppToolAdmissionCapability;
  mcpClient: McpRuntimeClient | undefined;
  /**
   * Every MCP server that contributed ZERO tools to this run (BST-1602). Empty
   * when discovery was healthy. Carried, never swallowed: the run answers with
   * a materially reduced tool surface and the user is owed that fact.
   */
  mcpDiscoverySkips: readonly McpDiscoverySkip[];
  /**
   * The resolved permission gate, minted as `permission.gate.resolved` on the
   * fresh-turn prelude. Null when no policy snapshot gated this run.
   */
  permissionGate: PermissionGateSummary | null;
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
  // Intentional guard on every native and MCP tool execution, so a single slow
  // tool cannot freeze the assistant stream. The budget is PER CALL (BST-1777):
  // a tool that declares an execution budget is granted what its own contract
  // promises the model, resolved from that call's input; every other tool —
  // including every MCP tool — keeps the global default.
  // Per-runtime, which is per request. The guard is the only layer that sees
  // real execution time; an approval-gated call's stream timestamps span the
  // human wait instead (see tool-execution-durations.ts).
  const budgetFor = (toolId: string): NativeToolExecutionBudget | undefined => {
    // Declared budgets belong to LOCAL tools only. An MCP tool's original name
    // is whatever its server chose, so matching it against the native catalog
    // would let a third-party tool named like a native one inherit a 600s budget.
    if (!sanitizedLocalToolIds.has(toolId)) {
      return;
    }
    const canonicalId = toolNameMap.get(toolId);
    return canonicalId === undefined ? undefined : NATIVE_TOOL_EXECUTION_BUDGETS.get(canonicalId);
  };
  const toolExecutionDurations = createToolExecutionDurations();
  const guardedTools = applyToolGuards(combinedTools, {
    declaredMaxMs: (toolId) => budgetFor(toolId)?.maxMs,
    durations: toolExecutionDurations,
    logger,
    timeoutMs: (toolId) => (args) =>
      resolveToolGuardBudget({
        budget: budgetFor(toolId),
        defaultGuardMs: resilienceConfig.toolTimeoutMs,
        input: args[0],
      }),
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
  // tool from the map the model sees; 'ask' records the tool in `askTools` and
  // the live gate (approval-gate.ts) clones it with the FUNCTION-form per-tool
  // `requireApproval`, which Mastra evaluates on every call, so it suspends
  // ONLY when that tool is actually called and no remembered grant allows it —
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
  const { approvalGate, gatedTools, askTools, permissionGate } = resolveGatedToolMap({
    hasStorage: params.hasStorage,
    hookedTools,
    permissionSnapshot: params.permissionSnapshot,
    planModeActive: params.planModeActive,
    remembered: params.remembered,
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
    approvalGate,
    artifactSettledTools,
    askTools,
    // Children retain the same lifecycle hooks before their independent permission gate.
    hookedTools,
    mcpAppToolAdmission,
    mcpClient,
    mcpDiscoverySkips,
    permissionGate,
    resilienceConfig,
    sanitizedLocalToolIds,
    // Children select a strict subset of these sanitized IDs; they never rename
    // tools. Current personas cannot delegate, so they advertise no delegation hint.
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
