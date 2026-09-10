/**
 * Mastra stream-option assembly (BST-1649 split from `agent-streaming.ts`):
 * the per-call option builders (`buildModelSettingsOption`,
 * `buildGenerationProviderOptionsOption`, `buildAssistantStreamMessageIdOption`,
 * `buildToolLoopOptions`), the unsupported-direct-option guard, and
 * `buildStreamOptions` — the single builder the three attempt legs
 * (initial/approval/resume) in `agent-streaming.ts` share.
 *
 * `buildStreamOptions` reproduces the exact spread each leg built inline
 * before this split (see `runtime-assembly/__tests__/stream-options.spec.ts`
 * for the per-leg parity proof), with one deliberate asymmetry: the RESUME
 * leg never carries `requireToolApproval`, even if a caller passes one — see
 * the docblock above `streamMastraToolResumeAction` in `agent-streaming.ts`
 * ("Does NOT pass requireToolApproval — that is approval-specific").
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md.
 */
import {
  getLlmModelDefinition,
  listProviderLlmModels,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { AgentMemoryOption, DelegationConfig } from '@mastra/core/agent';
import { SkillsProcessor } from '@mastra/core/processors';
import type { ToolHooks } from '@mastra/core/tools';
import { getDefaultModel } from '../../providers/provider-factory';
import type { RuntimeData } from '../../types';
import type { MastraAgentRuntime, MastraAgentRuntimeOptions } from '../agent-runtime';
import { buildBedrockMessageHygieneInputProcessor } from '../bedrock-message-hygiene';
import { buildCompactionOverlayInputProcessor } from '../compaction-overlay-processor';
import { buildProviderHistoryCompatInputProcessor } from '../error-processors';
import { createMastraAgentError } from '../mastra-agent-error';
import { buildOpenAIDuplicateItemCompatInputProcessor } from '../openai-duplicate-item-compat';
import { buildOpenAIToolSearchHistoryCompatInputProcessor } from '../openai-tool-search-history-compat';
import { ProjectionAwareTokenLimiter } from '../projection-aware-token-limiter';
import type { ProjectionSafeToolCallFilter } from '../projection-safe-tool-call-filter';
import { createDelegationConfig, type DelegationOutcomeCapture } from '../subagent-delegation';
import type { DelegationUsageCapture } from '../tool-lifecycle-processors';
import { buildToolProjectionRewriteInputProcessor } from '../tool-projection-rewrite-processor';
import type { BrainstrikeToolSearchProcessor } from '../tool-search-runtime';
import { createAssistantMessageIdGenerator } from './assistant-message-id';

const logger = createLogger('MastraAgent');

/**
 * Per-call approval decision, matching Mastra's `RequireToolApproval` union
 * (`boolean | (ctx) => boolean`). The function form gates approval per tool call;
 * the resume leg uses it to exempt Mastra-internal tools (see
 * {@link resolveResumeApprovalGate}).
 */
export type ApprovalGate = boolean | ((ctx: { toolName: string }) => boolean);

export interface BrainstrikeAgentStreamOptions {
  abortSignal?: AbortSignal;
  delegation?: DelegationConfig;
  // biome-ignore lint/style/useNamingConvention: Mastra's public stream option.
  experimental_generateMessageId?: () => string;
  hooks?: ToolHooks;
  inputProcessors?: unknown[];
  maxSteps?: number;
  memory?: AgentMemoryOption;
  modelSettings?: RuntimeData['modelSettings'];
  providerOptions?: RuntimeData['providerOptions'];
  requireToolApproval?: ApprovalGate;
}

/**
 * Default OpenRouter output window when the client sent no explicit
 * `modelSettings.maxOutputTokens` (BST-1170). Reasoning tokens are output
 * tokens on OpenRouter, so the window is sized for the reasoning state the
 * request actually carries: an active-reasoning request on a catalogued model
 * with a vendor-documented completion window reserves that window; everything
 * else keeps the coding ceiling. Undeclared routes have no recorded facts and
 * keep the ceiling — the base contract, not a per-model guess.
 */
function resolveOpenRouterBackstopMaxOutputTokens(runtimeData: RuntimeData): number {
  const modelId = runtimeData.model?.trim() || getDefaultModel('openrouter');
  const definition = listProviderLlmModels('openrouter').find(({ id }) => id === modelId);
  if (!definition) {
    return resolveOpenRouterCodingMaxOutputTokens();
  }
  const reasoning = runtimeData.providerOptions?.openrouter?.reasoning;
  const explicitEffort = reasoning?.enabled === false ? 'none' : reasoning?.effort;
  return resolveOpenRouterOutputWindow(
    definition,
    resolveOpenRouterReasoningActive(definition, explicitEffort)
  );
}

export function buildModelSettingsOption(
  runtimeData: RuntimeData | undefined
): Pick<BrainstrikeAgentStreamOptions, 'modelSettings'> {
  let modelSettings = runtimeData?.modelSettings;
  if (runtimeData?.provider === 'openrouter') {
    modelSettings = {
      maxOutputTokens: resolveOpenRouterBackstopMaxOutputTokens(runtimeData),
      ...modelSettings,
    };
  } else if (runtimeData?.provider === 'local') {
    const modelId = runtimeData.model?.trim() || getDefaultModel('local');
    const definition = getLlmModelDefinition('local', modelId);
    if (definition.maxOutputTokens === undefined) {
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { model: modelId, provider: 'local' },
        detail: `Local model ${modelId} has no maxOutputTokens registry budget`,
      });
    }
    modelSettings = {
      maxOutputTokens: definition.maxOutputTokens,
      ...modelSettings,
    };
  }
  return modelSettings ? { modelSettings } : {};
}

/**
 * Keep Brainstrike's local-server transport settings out of Mastra generation
 * options. Mastra namespaces compatible-provider options by the model id's
 * first segment, so forwarding `providerOptions.ollama` or `.lmstudio` would
 * serialize `baseUrl` and `apiToken` into the chat-completions request body.
 */
export function buildGenerationProviderOptionsOption(
  runtimeData: RuntimeData | undefined
): Pick<BrainstrikeAgentStreamOptions, 'providerOptions'> {
  const providerOptions = runtimeData?.providerOptions;
  if (!providerOptions) {
    return {};
  }
  if (providerOptions.ollama === undefined && providerOptions.lmstudio === undefined) {
    return { providerOptions };
  }

  const generationProviderOptions = Object.fromEntries(
    Object.entries(providerOptions).filter(
      ([namespace]) => namespace !== 'ollama' && namespace !== 'lmstudio'
    )
  ) as NonNullable<RuntimeData['providerOptions']>;
  if (Object.keys(generationProviderOptions).length === 0) {
    return {};
  }
  return { providerOptions: generationProviderOptions };
}

export function buildAssistantStreamMessageIdOption(runtimeData: RuntimeData | undefined): {
  // biome-ignore lint/style/useNamingConvention: Mastra's public stream option.
  experimental_generateMessageId?: () => string;
} {
  const assistantMessageId = runtimeData?.assistantMessageId;
  if (!assistantMessageId) {
    return {};
  }
  return {
    // The stream and persistence paths each consume their own one-shot
    // generator. Sharing one would make whichever Mastra path runs first force
    // the other to a UUID, breaking visible/persisted identity alignment.
    // biome-ignore lint/style/useNamingConvention: Mastra's public stream option.
    experimental_generateMessageId: createAssistantMessageIdGenerator(assistantMessageId).generate,
  };
}

/**
 * Matches the maximum user-selectable loop limit. The settings UI labels an
 * unset value as the default, so the runtime must not substitute a smaller
 * hidden cap that ends real coding tasks after only a handful of tool calls.
 */
const DEFAULT_AGENT_MAX_STEPS = 100;
const UNSUPPORTED_DIRECT_STREAM_OPTION_KEYS = [
  'activeTools',
  'clientTools',
  'inputProcessors',
  'outputProcessors',
  'prepareStep',
  'structuredOutput',
  'toolChoice',
  'toolsets',
] as const;

export function assertNoUnsupportedDirectStreamOptions(options: MastraAgentRuntimeOptions): void {
  const providedUnsupportedKeys = UNSUPPORTED_DIRECT_STREAM_OPTION_KEYS.filter((key) =>
    Object.hasOwn(options, key)
  );
  if (providedUnsupportedKeys.length === 0) {
    return;
  }

  throw createMastraAgentError('mastra_agent_unsupported_stream_option', {
    context: { unsupportedOptions: providedUnsupportedKeys },
    detail: `Unsupported Mastra stream option(s): ${providedUnsupportedKeys.join(', ')}`,
  });
}

function resolvePositiveIntegerOption(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { fieldName, value },
      detail: `${fieldName} must be a positive finite number`,
    });
  }
  return Math.floor(value);
}

export function buildToolLoopOptions(
  runtimeData: RuntimeData | undefined,
  toolSearchProcessor: BrainstrikeToolSearchProcessor | undefined,
  toolHistoryFilter: ProjectionSafeToolCallFilter | undefined
): Pick<BrainstrikeAgentStreamOptions, 'inputProcessors' | 'maxSteps'> {
  const agentLoop = runtimeData?.agentLoop;
  const maxSteps = resolvePositiveIntegerOption(agentLoop?.maxSteps, 'agentLoop.maxSteps');
  const inputTokenLimit = resolvePositiveIntegerOption(
    agentLoop?.inputTokenLimit,
    'agentLoop.inputTokenLimit'
  );
  // ProviderHistoryCompat's PREEMPTIVE `processLLMRequest` rules (strip
  // foreign/unsupported reasoning before a provider that would reject it — the
  // only place cross-provider reasoning incompatibility is handled) fire ONLY
  // from `inputProcessors`, never `errorProcessors` (verified against the
  // compiled loop). It rides the SAME per-call array as the TokenLimiter so the
  // per-call replacement doesn't drop either; their hooks are disjoint stages,
  // so token trimming is unaffected. Excluded for the local provider.
  const historyCompat = buildProviderHistoryCompatInputProcessor(runtimeData?.provider ?? '');
  const openAIToolSearchHistoryCompat = buildOpenAIToolSearchHistoryCompatInputProcessor(
    runtimeData?.provider ?? ''
  );
  // BST-1354: Converse-API shape rules (no empty text/reasoning blocks,
  // constrained tool-call ids) applied to the REPLAYED prompt only. Runs after
  // the history-compat rewrites so it also cleans whatever they produced.
  const bedrockMessageHygiene = buildBedrockMessageHygieneInputProcessor(
    runtimeData?.provider ?? ''
  );
  // Mastra's sealed-boundary re-key can leave the same assistant response
  // persisted under two message ids; OpenAI rejects any request that carries
  // an item id twice (BST-1095). Runs LAST among the compat processors so it
  // sees the item references the earlier rewrites produced.
  const openAIDuplicateItemCompat = buildOpenAIDuplicateItemCompatInputProcessor(
    runtimeData?.provider ?? ''
  );
  const toolProjectionRewrite = buildToolProjectionRewriteInputProcessor(
    runtimeData?.toolProjectionRewriteLookup,
    runtimeData?.memory?.threadId
  );
  const compactionOverlay = buildCompactionOverlayInputProcessor(
    runtimeData?.compactionOverlayLookup,
    runtimeData?.memory?.threadId
  );
  const tokenLimiter = inputTokenLimit
    ? new ProjectionAwareTokenLimiter({
        limit: inputTokenLimit,
        strategy: 'truncate',
        trimMode: 'contiguous',
      })
    : undefined;
  // Agent Skills metadata injection (progressive disclosure level 1): Mastra's
  // own SkillsProcessor puts the <available_skills> block into the system
  // message each input step. It rides the SAME per-call inputProcessors array
  // as the TokenLimiter (per-call options REPLACE the Agent-config array, so it
  // cannot live on the Agent config) and runs FIRST so the limiter counts the
  // injected block. Excluded for the built-in local provider — mirrors the
  // tool-map gate in createMastraAgentRuntime.
  const skillsProcessor =
    runtimeData?.workspaceSkills && runtimeData.provider !== 'local'
      ? new SkillsProcessor({ skills: runtimeData.workspaceSkills })
      : undefined;
  const inputProcessors: unknown[] = [
    skillsProcessor,
    toolSearchProcessor,
    toolHistoryFilter,
    toolProjectionRewrite,
    // Adjacent for readability only: processInputStep always runs before the
    // rewrite processor's processLLMRequest, independent of array position.
    compactionOverlay,
    historyCompat,
    openAIToolSearchHistoryCompat,
    openAIDuplicateItemCompat,
    bedrockMessageHygiene,
    tokenLimiter,
  ].filter((processor): processor is NonNullable<typeof processor> => processor !== undefined);

  return {
    maxSteps: maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
    ...(inputProcessors.length > 0 ? { inputProcessors } : {}),
  };
}

/** Which of the three stream legs a {@link buildStreamOptions} call is for. */
export type StreamOptionsLeg = 'approval' | 'initial' | 'resume';

export interface BuildStreamOptionsParams {
  abortSignal: AbortSignal;
  /** Same lifetime as `delegationUsage`; folded into the delegation config. */
  delegationOutcomes: DelegationOutcomeCapture | undefined;
  delegationUsage: DelegationUsageCapture | undefined;
  leg: StreamOptionsLeg;
  memoryOption: AgentMemoryOption | undefined;
  /**
   * Ignored on the `resume` leg regardless of what is passed — resume never
   * legitimately computes one (Mastra's per-leg re-check has its own rider,
   * see `createToolResumeTurnAttempt`), and the suppression is structural
   * here rather than left to every call site remembering to omit it. Required
   * (not `?`) so every leg passes it explicitly, matching the sibling
   * `delegationOutcomes`/`delegationUsage`/`memoryOption` fields.
   */
  requireToolApproval: ApprovalGate | undefined;
  runId?: string;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
  toolCallId?: string;
}

/**
 * The single option builder the three attempt legs
 * (`createInitialTurnAttempt`, `createToolApprovalTurnAttempt`,
 * `createToolResumeTurnAttempt` in `agent-streaming.ts`) share. Legs differ
 * only in whether `runId`/`toolCallId` are set and whether
 * `requireToolApproval` is carried at all (see {@link BuildStreamOptionsParams}).
 */
export function buildStreamOptions(
  params: BuildStreamOptionsParams
): BrainstrikeAgentStreamOptions & { runId?: string; toolCallId?: string } {
  const {
    abortSignal,
    delegationOutcomes,
    delegationUsage,
    leg,
    memoryOption,
    requireToolApproval,
    runId,
    runtime,
    runtimeData,
    toolCallId,
  } = params;

  return {
    ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
    abortSignal,
    ...(runtime.delegatedTurnPersistence
      ? { hooks: runtime.delegatedTurnPersistence.hooks(abortSignal) }
      : {}),
    ...(runId === undefined ? {} : { runId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...buildAssistantStreamMessageIdOption(runtimeData),
    ...(memoryOption ? { memory: memoryOption } : {}),
    ...buildModelSettingsOption(runtimeData),
    ...buildGenerationProviderOptionsOption(runtimeData),
    // Delegation safety rails: per-run caps + maxSteps clamp + unknown-persona
    // rejection (only when the run has registered personas).
    ...(delegationUsage
      ? {
          delegation: createDelegationConfig({
            abortSignal,
            ...(runtime.conversationBinding
              ? { conversationBinding: runtime.conversationBinding }
              : {}),
            ...(delegationOutcomes ? { delegationOutcomes } : {}),
            logger,
            onChildUsage: delegationUsage.onChildUsage,
            personasById: runtime.personasById,
            turnPersistence: runtime.delegatedTurnPersistence,
          }),
        }
      : {}),
    // See BuildStreamOptionsParams.requireToolApproval: resume never carries
    // this key, even if one is passed.
    ...(leg === 'resume' || requireToolApproval === undefined ? {} : { requireToolApproval }),
  };
}
