/**
 * Persona → child-`Agent` factory (subagent personas, T2).
 *
 * Builds Mastra supervisor "subagents" from persona DATA. Each returned child is
 * a plain `new Agent({...})` whose tool map is a permission-gated SUBSET of the
 * parent's already-guarded tool map — so per-tool timeout + structured
 * `GuardedToolError` inherit for free (D4). Durable host budgets enable lazy
 * native descendants with explicit shared memory; native delegation owns each
 * fresh child thread and the root host validates its ancestry and limits.
 *
 * Permission composition (D3): the persona's candidate map passes through the
 * SAME `filterToolsByPermissionWithMetadata` gate as the parent. Ask tools need
 * native storage and the complete durable child-decision host capability. A persona whose
 * post-gate map is empty is NOT registered (no useless delegation tool).
 */

import {
  DELEGATION_LIMITS,
  deriveEffectiveInputBudget,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import {
  type AssistantPersonaDefinition,
  assertPersonaToolScope,
  delegationDescriptionForPersona,
  supportsWorkerPersonaProvider,
} from '@brainstrike/assistant-contract/personas';
import type { ProviderId } from '@brainstrike/assistant-contract/provider-registry';
import { Agent, type AgentExecutionOptions, type ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraMemory } from '@mastra/core/memory';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import {
  resolveToolResultBudgetForModel,
  type ScaledToolResultBudget,
} from '../stream/tool-output-limits';
import type { RuntimeData } from '../types';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import { personasAtDelegationDepth } from './delegated-persona-snapshots';
import {
  createDelegatedSystemContextProcessor,
  type DelegatedSystemContextSource,
  readDelegatedHistoryScope,
} from './delegated-system-context';
import {
  createDelegatedWorkBudget,
  DelegatedWorkQueue,
  queueDelegatedTools,
  resolveDelegatedWorkBudget,
} from './delegated-work-budget';
import { ASSISTANT_MAX_PROCESSOR_RETRIES, buildAssistantErrorProcessors } from './error-processors';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionToolGateLogger,
  type PermissionToolGateSnapshot,
} from './permission-tool-gate';
import { resolveSuspendToolsForRun } from './plan-mode-tool-gate';
import { createResponseBoundaryProcessor } from './response-boundary-processor';
import { buildToolLoopOptions } from './runtime-assembly/stream-options';
import {
  createToolHistoryFilter,
  prepareHostedToolDiscovery,
} from './runtime-assembly/tool-pipeline';
import {
  applyToolModelOutputProjections,
  type ModelOutputProjectionObserver,
} from './tool-model-output';

export interface PersonaSubAgentBuildResult {
  readonly artifactReaderDelegationTools: readonly string[];
  /** 'agent-<personaId>' → personaId, for the stream mapper (D9). */
  readonly delegationToolPersonas: ReadonlyMap<string, string>;
  /** Persona id → resolved persona (for delegation caps + instructions). */
  readonly personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  /** Persona id → constructed child Agent; keys of `agents` config are persona ids. */
  readonly subAgents: Record<string, Agent>;
}

export type DelegatedExecutionOptions = Pick<
  AgentExecutionOptions,
  'delegation' | 'hooks' | 'abortSignal'
> & { workQueue?: DelegatedWorkQueue };

export interface BuildPersonaSubAgentsParams {
  readonly conversationBinding?: DelegatedConversationBinding;
  readonly delegatedExecutionOptions?: DelegatedExecutionOptions | undefined;
  readonly delegatedPersonaSnapshots?: readonly AssistantPersonaDefinition[] | undefined;
  readonly depth?: number;
  readonly getDelegatedSystemContext?: DelegatedSystemContextSource;
  /** Parent's post-guard, post-lifecycle-hook tool map (keyed by sanitized id), RAW — not yet
   * model-output-projected. Each child projects its own selected subset
   * against its own resolved budget (see {@link resolvedToolResultBudget}). */
  readonly guardedTools: ToolsInput;
  readonly hasStorage?: boolean;
  /** Parent's resolved model instance (D5 — children reuse it). */
  readonly languageModel: MastraModelConfig;
  readonly localToolIds?: ReadonlySet<string>;
  readonly logger: PermissionToolGateLogger;
  readonly memory?: MastraMemory | undefined;
  readonly modelName?: string;
  readonly permissionSnapshot: PermissionToolGateSnapshot | undefined;
  readonly personas: readonly AssistantPersonaDefinition[];
  /**
   * The PARENT run's normalized provider, used to build the child's error
   * processors. A pinned persona overrides it with its own provider.
   */
  readonly provider: string;
  /**
   * The PARENT run's resolved tool-result budget (BST-1206). Un-pinned
   * personas project their tools against this. A pinned persona instead
   * resolves its OWN budget from `persona.model`'s provider/window — see
   * {@link resolvePinnedModel}'s doc comment for why a pin must never
   * silently reuse an unrelated budget.
   */
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  /**
   * Resolve a pinned persona's model (`persona.model` is set) into a concrete
   * model instance. Provided by the runtime layer, which owns provider/key
   * resolution. A pinned persona is SKIPPED with a visible warn when the
   * resolver is absent or throws — it never silently falls back to the parent
   * model (the author pinned for a reason: cost, capability, or locality).
   * The SAME reasoning extends to its tool-result budget (BST-1206 review):
   * a pin that resolves a model but keeps the parent's budget would size
   * every tool result for the WRONG model's context window.
   */
  readonly resolvePinnedModel?: (persona: AssistantPersonaDefinition) => MastraModelConfig;
  readonly resumeMemory?: MastraMemory | undefined;
  readonly rootMemoryContext?: RuntimeData['memory'];
  readonly settleChildToolOutputs?: (
    tools: ToolsInput,
    budget: ScaledToolResultBudget
  ) => ToolsInput;
  /** sanitizedId → originalName (the parent's map). */
  readonly toolNameMap: ReadonlyMap<string, string>;
  /** Forwarded to `applyToolModelOutputProjections` for every child (BST-1196
   * subagent telemetry attribution — see its call site in agent-runtime.ts). */
  readonly toolOutputObserver?: ModelOutputProjectionObserver;
  readonly turnPersistenceProcessor?: (InputProcessor & OutputProcessor) | undefined;
  readonly workspaceSkills?: RuntimeData['workspaceSkills'];
}

/**
 * The wrap-up instruction a child receives on its reserved final step.
 *
 * Exported so the paired specs can assert the child's LAST prompt actually
 * carried it — a summary the child produced without seeing this would be
 * ungrounded, which is worse than the empty result this replaces.
 */
export const CHILD_WRAP_UP_FEEDBACK =
  'You are at your step limit and this is your final turn — no further tool calls will run. ' +
  'Using ONLY what you already found above, write your summary now: what you looked for, ' +
  'what you found, and the concrete file paths. If you covered only part of the task, say ' +
  'exactly which part you covered and which you did not.';

/**
 * Reserve a child's LAST step for its summary, using Mastra's own
 * `onIterationComplete` hook (docs/subagents.md).
 *
 * A child cut off mid-tool-loop returns `text: ''`, which reaches the supervisor
 * as a successful-but-empty delegation (BST-1410). Mastra's documented remedy is
 * to return `{ continue: false, feedback }` from this hook: core appends the
 * feedback to the child's own message list and grants exactly one more model
 * call before stopping ("the model may get one final turn for a text response
 * that incorporates the feedback").
 *
 * IN-LOOP is the whole point, and why this replaced a bolt-on second
 * `agent.stream()` call. Riding the child's own loop means the summary turn
 * inherits its abort signal, its usage accounting, its memory scoping, and its
 * gathered context for free, and — critically — it is spent from the persona's
 * DECLARED step budget rather than added on top of it. A child with
 * `maxSteps: 8` still costs at most eight model calls.
 *
 * Core only injects the feedback when the model intended to continue (it checks
 * `stepResult.isContinued`), so a child that already answered is never
 * interrupted and a child that stopped on its own is left alone. That gate is
 * the ONLY completion signal this policy relies on.
 *
 * It deliberately does NOT look at the step's `text` (review of #2596). Claude
 * and GPT routinely narrate alongside a tool call ("Let me check the packages
 * directory..."), so text is non-empty on an ordinary tool-looping step.
 * Treating that as "already answering" suppressed the reserve, let the child
 * spend its last step on another tool, and then handed the parent the PREAMBLE
 * as the analysis — non-empty, so the no-answer path never fired either. That is
 * BST-1410 again in a plausible disguise, on exactly the models this targets.
 */
export function buildChildIterationPolicy(): NonNullable<
  AgentExecutionOptions['onIterationComplete']
> {
  return ({ iteration, maxIterations }) => {
    if (typeof maxIterations !== 'number' || maxIterations < 2) {
      // Nothing to reserve: a one-step child has no earlier step to spend on
      // tools, so forcing a wrap-up would consume its only turn.
      return;
    }
    // Fire on the step BEFORE the cap so the reserved turn still fits inside it.
    if (iteration < maxIterations - 1) {
      return;
    }
    return { continue: false, feedback: CHILD_WRAP_UP_FEEDBACK };
  };
}

function buildOriginalToSanitized(
  toolNameMap: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  const reverse = new Map<string, string>();
  for (const [sanitizedId, originalName] of toolNameMap) {
    reverse.set(originalName, sanitizedId);
  }
  return reverse;
}

/**
 * Select the persona's candidate tools from the parent's guarded map. A persona
 * tool id absent from the run's registry is SKIPPED-with-log (tool availability
 * is runtime-dependent, e.g. webSearch behind enabledNativeToolIds), never an
 * error.
 */
function selectCandidateTools(
  persona: AssistantPersonaDefinition,
  guardedTools: ToolsInput,
  originalToSanitized: ReadonlyMap<string, string>,
  logger: PermissionToolGateLogger
): { candidate: ToolsInput; candidateNameMap: Map<string, string> } {
  const candidate: Record<string, unknown> = {};
  const candidateNameMap = new Map<string, string>();
  const selectedIds =
    persona.mode === 'worker' && persona.allowedToolIds[0] === '*'
      ? [...originalToSanitized.keys()].filter((id) => id !== NATIVE_TOOL_ID.manageTaskList)
      : persona.allowedToolIds;
  for (const originalName of selectedIds) {
    const sanitizedId = originalToSanitized.get(originalName);
    if (!(sanitizedId && sanitizedId in guardedTools)) {
      logger.info('Persona tool not available in this run; skipping', {
        code: 'subagent_persona_tool_missing',
        personaId: persona.id,
        tool: originalName,
      });
      continue;
    }
    candidate[sanitizedId] = (guardedTools as Record<string, unknown>)[sanitizedId];
    candidateNameMap.set(sanitizedId, originalName);
  }
  return { candidate: candidate as ToolsInput, candidateNameMap };
}

function buildChildInstructions(
  persona: AssistantPersonaDefinition,
  toolOriginalNames: readonly string[]
): string {
  if (persona.mode === 'worker' || toolOriginalNames.length === 0) {
    return persona.instructions;
  }
  return `${persona.instructions}\n\nAvailable tools: ${toolOriginalNames.join(', ')}.`;
}

/**
 * Resolve the model a persona child runs on. Un-pinned personas reuse the
 * parent's model (D5). A pinned persona resolves through `resolvePinnedModel`;
 * when that is absent or throws, the persona is skipped (null) with a warn —
 * never a silent parent-model fallback.
 */
function resolvePersonaModel(
  persona: AssistantPersonaDefinition,
  params: BuildPersonaSubAgentsParams
): MastraModelConfig | null {
  if (!persona.model) {
    return params.languageModel;
  }
  if (!params.resolvePinnedModel) {
    params.logger.warn('Persona pins a model but no pin resolver is available; skipping persona', {
      code: 'subagent_persona_pin_unresolvable',
      modelId: persona.model.modelId,
      personaId: persona.id,
      provider: persona.model.provider,
    });
    return null;
  }
  try {
    return params.resolvePinnedModel(persona);
  } catch (error) {
    params.logger.warn('Persona model pin failed to resolve; skipping persona', {
      code: 'subagent_persona_pin_unresolvable',
      detail: error instanceof Error ? error.message : String(error),
      modelId: persona.model.modelId,
      personaId: persona.id,
      provider: persona.model.provider,
    });
    return null;
  }
}

/**
 * Resolve the tool-result budget a persona child's tools should be projected
 * against (BST-1206 review, P2). Un-pinned personas inherit the parent's
 * resolved budget (they run on the parent's model). A pinned persona resolves
 * its OWN budget from `persona.model`'s provider/window — reusing the
 * parent's would size every tool result for the wrong model's context
 * window, exactly the bug this fixes.
 *
 * `resolveToolResultBudgetForModel` itself no longer throws for an unknown
 * provider/model id (BST-1206 follow-up review): it falls back to the anchor
 * (or the shared Ollama/LM Studio declaration) with a visible log, so a pin
 * to a model absent from the static catalog still gets a sensible budget
 * instead of losing the persona entirely. This try/catch now only guards a
 * genuine registry misconfiguration (e.g. a registered entry with an invalid
 * `contextWindow`, which `resolveScaledToolResultBudget` itself rejects) —
 * mirroring `resolvePersonaModel`'s skip-with-warn contract for that
 * narrower case, never a silent fallback to the parent's budget.
 */
function resolvePersonaToolResultBudget(
  persona: AssistantPersonaDefinition,
  params: BuildPersonaSubAgentsParams
): ScaledToolResultBudget | null {
  if (!persona.model) {
    return params.resolvedToolResultBudget;
  }
  try {
    return resolveToolResultBudgetForModel(
      persona.model.provider as ProviderId,
      persona.model.modelId
    );
  } catch (error) {
    params.logger.warn('Persona model pin has no resolvable tool-result budget; skipping persona', {
      code: 'subagent_persona_pin_budget_unresolvable',
      detail: error instanceof Error ? error.message : String(error),
      modelId: persona.model.modelId,
      personaId: persona.id,
      provider: persona.model.provider,
    });
    return null;
  }
}

/**
 * Build persona child Agents for the parent supervisor.
 */
function buildChildProcessors(params: BuildPersonaSubAgentsParams): {
  inputProcessors?: InputProcessor[];
  outputProcessors?: OutputProcessor[];
} {
  const inputProcessors: InputProcessor[] = [];
  if (params.getDelegatedSystemContext || params.hasStorage) {
    inputProcessors.push(createDelegatedSystemContextProcessor(params.getDelegatedSystemContext));
  }
  if (params.conversationBinding) {
    inputProcessors.push(params.conversationBinding.inputProcessor);
  }
  if (params.turnPersistenceProcessor) {
    inputProcessors.push(params.turnPersistenceProcessor);
  }
  return {
    ...(inputProcessors.length > 0 ? { inputProcessors } : {}),
    // Core 1.64 combines configured, channel and memory output processors.
    // The boundary and optional persistence processors preserve memory defaults.
    outputProcessors: [
      createResponseBoundaryProcessor(),
      ...(params.turnPersistenceProcessor ? [params.turnPersistenceProcessor] : []),
    ],
  };
}

function canSuspendPersonaTools(params: BuildPersonaSubAgentsParams): boolean {
  // Native per-tool approval is available only with the complete durable
  // host boundary. Storage alone cannot authorize or isolate child decisions.
  const binding = params.conversationBinding;
  return Boolean(
    params.hasStorage &&
      binding?.bindRun &&
      binding.claimToolAction &&
      binding.finishToolActions &&
      binding.prepareToolAction &&
      binding.releaseUnexecutedToolAction &&
      binding.resolveToolAction
  );
}

function isWorkerAvailable(
  persona: AssistantPersonaDefinition,
  params: BuildPersonaSubAgentsParams,
  canSuspend: boolean
): boolean {
  if (persona.mode !== 'worker') {
    return true;
  }
  const provider = persona.model?.provider ?? params.provider;
  const code = canSuspend
    ? supportsWorkerPersonaProvider(provider)
      ? (persona.model?.modelId ?? params.modelName) && params.localToolIds
        ? undefined
        : 'subagent_worker_catalog_unavailable'
      : 'subagent_worker_local_model_unavailable'
    : 'subagent_worker_host_unavailable';
  if (!code) {
    return true;
  }
  params.logger.warn(
    'Worker requires hosted discovery, its catalog and complete durable child control; not registering',
    {
      code,
      personaId: persona.id,
      provider,
    }
  );
  return false;
}

async function prepareWorkerToolSurface(
  params: BuildPersonaSubAgentsParams,
  persona: AssistantPersonaDefinition,
  tools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>,
  budget: ScaledToolResultBudget
): Promise<{ tools: ToolsInput; inputProcessors: InputProcessor[] }> {
  const modelName = persona.model?.modelId ?? params.modelName;
  if (!(modelName && params.localToolIds)) {
    throw new Error('Worker requires the resolved host model and tool catalog.');
  }
  const provider = (persona.model?.provider ?? params.provider) as ProviderId;
  const resumeMemory = params.resumeMemory;
  const discovery = await prepareHostedToolDiscovery({
    eligibleTools: tools,
    ...(resumeMemory
      ? {
          persistedDiscoveryMessages: async (requestContext) => {
            const child = readDelegatedHistoryScope(
              requestContext,
              params.rootMemoryContext?.threadId
            );
            // Mastra's embedded runtime owns this scope; middleware-only reserved
            // keys are absent here. Its native child resource may differ from the
            // parent's. Never recall parent history during catalog introspection.
            if (!child) {
              return [];
            }
            const recalled = await resumeMemory.recall({
              perPage: false,
              resourceId: child.resourceId,
              threadId: child.threadId,
            });
            return recalled.messages;
          },
        }
      : {}),
    ...(params.toolOutputObserver ? { toolOutputObserver: params.toolOutputObserver } : {}),
    localToolIds: params.localToolIds,
    modelName,
    provider,
    resolvedToolResultBudget: budget,
    toolNameMap,
  });
  // Reuse canonical skills, provider compatibility and token limiting, with no
  // parent-thread memory/compaction lookup. Mastra owns this child's context store.
  const hasSkillControls = [
    NATIVE_TOOL_ID.skill,
    NATIVE_TOOL_ID.skillRead,
    NATIVE_TOOL_ID.skillSearch,
  ].every((id) =>
    Array.from(toolNameMap).some(([key, name]) => name === id && Object.hasOwn(tools, key))
  );
  const loop = buildToolLoopOptions(
    {
      provider,
      ...(params.workspaceSkills && hasSkillControls
        ? { workspaceSkills: params.workspaceSkills }
        : {}),
      agentLoop: { inputTokenLimit: deriveEffectiveInputBudget(budget.contextWindow) },
    },
    discovery.toolSearchProcessor,
    createToolHistoryFilter(provider, toolNameMap)
  );
  return {
    inputProcessors: (loop.inputProcessors ?? []) as InputProcessor[],
    tools: discovery.modelProjectedTools,
  };
}

const MAX_CHILD_TOOL_CALL_CONCURRENCY = 8;

async function createConfiguredChild({
  params,
  persona,
  childModel,
  keptOriginalNames,
  childNameMap,
  settledChildTools,
  rawChildTools,
  childToolResultBudget,
}: {
  params: BuildPersonaSubAgentsParams;
  persona: AssistantPersonaDefinition;
  childModel: MastraModelConfig;
  keptOriginalNames: readonly string[];
  childNameMap: ReadonlyMap<string, string>;
  settledChildTools: ToolsInput;
  rawChildTools: ToolsInput;
  childToolResultBudget: ScaledToolResultBudget;
}): Promise<Agent> {
  const queue = resolveDelegatedWorkBudget(
    params.conversationBinding?.budget,
    params.delegatedExecutionOptions?.workQueue
  )?.queue;
  const queuedChildTools = queue
    ? queueDelegatedTools(
        settledChildTools,
        queue,
        () => params.delegatedExecutionOptions?.abortSignal
      )
    : settledChildTools;
  const workerSurface =
    persona.mode === 'worker'
      ? await prepareWorkerToolSurface(
          params,
          persona,
          queuedChildTools,
          childNameMap,
          childToolResultBudget
        )
      : undefined;
  const projectedChildTools =
    workerSurface?.tools ??
    applyToolModelOutputProjections(
      queuedChildTools,
      childNameMap,
      params.toolOutputObserver,
      childToolResultBudget
    );
  const childProcessors = buildChildProcessors(params);

  // The child agent id MUST equal the persona id: Mastra sets
  // `DelegationStartContext.primitiveId = agent.id`, and the delegation caps
  // (subagent-delegation.ts) resolve the persona by that id.
  // Children get the SAME error-processor layer as the parent (review of
  // #2596). Without it a child has no `PrefillErrorHandler`, and the wrap-up
  // turn is exactly when it would be needed: Mastra appends the feedback as an
  // ASSISTANT message, so the child's next request ends on an assistant turn —
  // the assistant-prefill shape that processor exists to recover from. A child
  // that fails precisely when its summary is due would reintroduce BST-1410
  // through the mechanism meant to fix it. Resolved against the child's OWN
  // provider so a pinned persona is handled on its own terms.
  const childErrorProcessors = buildAssistantErrorProcessors(
    persona.model?.provider ?? params.provider
  );
  const depth = params.depth ?? 1;
  const childModelName = persona.model?.modelId ?? params.modelName;
  let descendants: Promise<PersonaSubAgentBuildResult> | undefined;
  return new Agent({
    ...(params.memory ? { memory: params.memory } : {}),
    ...(params.conversationBinding?.budget &&
    params.delegatedExecutionOptions &&
    depth < DELEGATION_LIMITS.maxDepth
      ? {
          agents: async () => {
            descendants ??= buildPersonaSubAgents({
              ...params,
              depth: depth + 1,
              guardedTools: rawChildTools,
              languageModel: childModel,
              provider: persona.model?.provider ?? params.provider,
              toolNameMap: childNameMap,
              ...(childModelName ? { modelName: childModelName } : {}),
              resolvedToolResultBudget: childToolResultBudget,
            });
            return (await descendants).subAgents;
          },
        }
      : {}),
    // Carried on the CHILD so it applies when Mastra invokes the delegation
    // internally: `Agent.stream()` deep-merges `defaultOptions` with the
    // per-call options the delegation tool passes, and that call sets
    // `maxSteps` but never `onIterationComplete`.
    defaultOptions: ({ requestContext }) => {
      const durable = resolveDelegatedWorkBudget(
        params.conversationBinding?.budget,
        params.delegatedExecutionOptions?.workQueue
      );
      const work = durable
        ? createDelegatedWorkBudget(
            durable.budget,
            durable.queue,
            params.delegatedExecutionOptions?.abortSignal
          )
        : undefined;
      const childSignal = requestContext
        ? params.conversationBinding?.getAbortSignal?.(requestContext)
        : undefined;
      return {
        ...(childSignal ? { abortSignal: childSignal } : {}),
        ...(params.delegatedExecutionOptions?.delegation
          ? { delegation: params.delegatedExecutionOptions.delegation }
          : {}),
        ...(params.delegatedExecutionOptions?.hooks
          ? { hooks: params.delegatedExecutionOptions.hooks }
          : {}),
        onIterationComplete: buildChildIterationPolicy(),
        toolCallConcurrency: {
          limit: MAX_CHILD_TOOL_CALL_CONCURRENCY,
          strategy: 'called' as const,
        },
        ...(work
          ? {
              errorProcessors: [work.processor, ...(childErrorProcessors ?? [])],
              inputProcessors: [
                ...(childProcessors.inputProcessors ?? []),
                ...(workerSurface?.inputProcessors ?? []),
                work.processor,
              ],
              onError: () => work.release(),
              onFinish: () => work.release(),
              outputProcessors: [...(childProcessors.outputProcessors ?? []), work.processor],
            }
          : {}),
      };
    },
    // Mastra turns this into the `agent-<id>` tool description, the only
    // thing the supervisor reads when sizing a delegation — so it carries the
    // DERIVED step budget rather than the persona's bare prose.
    description: delegationDescriptionForPersona(persona),
    id: persona.id,
    instructions: buildChildInstructions(persona, keptOriginalNames),
    ...childProcessors,
    ...(workerSurface
      ? {
          inputProcessors: [
            ...(childProcessors.inputProcessors ?? []),
            ...workerSurface.inputProcessors,
          ],
        }
      : {}),
    // Any `errorProcessors` flips Mastra's processor-retry default, so the
    // pinned budget travels with them exactly as it does on the parent.
    ...(childErrorProcessors
      ? {
          errorProcessors: childErrorProcessors,
          maxProcessorRetries: ASSISTANT_MAX_PROCESSOR_RETRIES,
        }
      : {}),
    model: childModel,
    name: persona.label,
    tools: queue
      ? {
          ...projectedChildTools,
          ...queueDelegatedTools(
            Object.fromEntries(
              Object.entries(projectedChildTools).filter(([name]) => !(name in queuedChildTools))
            ),
            queue,
            () => params.delegatedExecutionOptions?.abortSignal
          ),
        }
      : projectedChildTools,
  });
}

function assertAdmittedPersonaRegistered(
  params: BuildPersonaSubAgentsParams,
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>
): void {
  const admittedPersona = params.delegatedPersonaSnapshots?.[(params.depth ?? 1) - 1];
  if (admittedPersona && !personasById.has(admittedPersona.id)) {
    throw new Error(
      `The admitted child '${admittedPersona.id}' cannot resume with the current model or host permissions.`
    );
  }
}

export async function buildPersonaSubAgents(
  params: BuildPersonaSubAgentsParams
): Promise<PersonaSubAgentBuildResult> {
  if (params.delegatedExecutionOptions) {
    params.delegatedExecutionOptions.workQueue ??= new DelegatedWorkQueue();
  }
  const canSuspend = canSuspendPersonaTools(params);
  const originalToSanitized = buildOriginalToSanitized(params.toolNameMap);
  const artifactReaderCapabilities = new Map<string, boolean>();
  const childBuilders: (() => Promise<readonly [string, Agent]>)[] = [];
  const delegationToolPersonas = new Map<string, string>();
  const personasById = new Map<string, AssistantPersonaDefinition>();

  for (const persona of personasAtDelegationDepth(
    params.personas,
    params.delegatedPersonaSnapshots,
    params.depth
  )) {
    // Scope validation precedes permission opt-outs: legacy personas stay
    // read-only, while worker declarations can only narrow the host catalog.
    assertPersonaToolScope(persona);
    if (!isWorkerAvailable(persona, params, canSuspend)) {
      continue;
    }

    const childModel = resolvePersonaModel(persona, params);
    if (childModel === null) {
      continue;
    }

    const { candidate, candidateNameMap } = selectCandidateTools(
      persona,
      params.guardedTools,
      originalToSanitized,
      params.logger
    );

    const gateResult = filterToolsByPermissionWithMetadata(
      candidate,
      params.permissionSnapshot,
      params.toolNameMap,
      params.logger
    );
    const suspendGatedTools = resolveSuspendToolsForRun(
      gateResult.tools,
      canSuspend,
      params.toolNameMap,
      params.logger
    );
    const childTools: Record<string, unknown> = {};
    const keptOriginalNames: string[] = [];
    for (const [sanitizedId, tool] of Object.entries(suspendGatedTools)) {
      if (gateResult.askToolIds.has(sanitizedId) && !canSuspend) {
        params.logger.info('Persona approval requires durable host control; omitting tool', {
          code: 'subagent_ask_tool_omitted',
          personaId: persona.id,
          sanitizedId,
          tool: candidateNameMap.get(sanitizedId) ?? sanitizedId,
        });
        continue;
      }
      childTools[sanitizedId] = tool;
      keptOriginalNames.push(candidateNameMap.get(sanitizedId) ?? sanitizedId);
    }

    if (keptOriginalNames.length === 0) {
      params.logger.warn('Persona has no available tools after gating; not registering', {
        code: 'subagent_persona_empty_toolset',
        personaId: persona.id,
      });
      continue;
    }

    // BST-1206 review (P2): project THIS child's tools against ITS resolved
    // budget — the parent's for an un-pinned persona, the pinned model's own
    // for a pin. Applied here (not once on the parent's map before
    // selection) so a pinned persona never inherits a budget sized for a
    // different model's context window.
    const childToolResultBudget = resolvePersonaToolResultBudget(persona, params);
    if (childToolResultBudget === null) {
      continue;
    }
    const childNameMap = new Map(candidateNameMap);
    const settledChildTools = params.settleChildToolOutputs
      ? params.settleChildToolOutputs(childTools as ToolsInput, childToolResultBudget)
      : (childTools as ToolsInput);
    childBuilders.push(
      async () =>
        [
          persona.id,
          await createConfiguredChild({
            childModel,
            childNameMap,
            childToolResultBudget,
            keptOriginalNames,
            params,
            persona,
            rawChildTools: childTools as ToolsInput,
            settledChildTools,
          }),
        ] as const
    );
    artifactReaderCapabilities.set(
      `agent-${persona.id}`,
      keptOriginalNames.includes(NATIVE_TOOL_ID.readToolOutputArtifact)
    );
    delegationToolPersonas.set(`agent-${persona.id}`, persona.id);
    personasById.set(persona.id, { ...persona, allowedToolIds: keptOriginalNames });
  }

  assertAdmittedPersonaRegistered(params, personasById);
  const subAgents = Object.fromEntries(await Promise.all(childBuilders.map((build) => build())));
  return {
    artifactReaderDelegationTools: Array.from(artifactReaderCapabilities)
      .filter(([, allowed]) => allowed)
      .map(([tool]) => tool),
    delegationToolPersonas,
    personasById,
    subAgents,
  };
}
