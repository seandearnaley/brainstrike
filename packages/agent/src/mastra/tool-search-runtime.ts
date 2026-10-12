import {
  resolveToolDiscoveryAdapter,
  type ToolDiscoveryAdapter,
} from '@brainstrike/assistant-contract';
import {
  findProviderDefinition,
  type ProviderId,
} from '@brainstrike/assistant-contract/provider-registry';
import {
  isNativeToolId,
  isSkillNativeToolId,
  NATIVE_TOOL_DEFAULTS,
  NATIVE_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
import { type MastraDBMessage, MessageList, type ToolsInput } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { MASTRA_THREAD_ID_KEY, type RequestContext } from '@mastra/core/request-context';
import type { Tool } from '@mastra/core/tools';
import { describeAvailableDeferredCapabilityFamilies } from './deferred-capability-families';
import { createDeferredToolCatalog, LIST_AVAILABLE_TOOLS_ID } from './deferred-tool-catalog';
import { createMastraAgentError } from './mastra-agent-error';

const logger = createLogger('MastraToolDiscovery');

export interface ToolDiscoveryMetadata {
  readonly adapter: ToolDiscoveryAdapter;
  readonly coreToolIds: readonly string[];
  readonly deferredToolIds: readonly string[];
  readonly eligibleToolIds: readonly string[];
}

export interface ToolDiscoverySurface {
  readonly coreTools: ToolsInput;
  readonly deferredTools: ToolsInput;
  readonly metadata: ToolDiscoveryMetadata;
}

interface ResolveToolDiscoverySurfaceOptions {
  readonly adapter: ToolDiscoveryAdapter;
  readonly eligibleTools: ToolsInput;
  readonly localToolIds: ReadonlySet<string>;
  readonly toolNameMap: ReadonlyMap<string, string>;
}

/**
 * Split the already-authorized tool map into the provider's initial surface and
 * Mastra's searchable catalog. This function never widens eligibility: it runs
 * after capability, plan, permission, approval-storage, hook, and projection
 * gates have finished.
 *
 * Known native loading tiers are authoritative. MCP tools are deferred because
 * they were added after the local registry was sanitized. Unknown caller-owned
 * local tools remain eager; Brainstrike has no trustworthy loading metadata for
 * them, so silently classifying them as deferred would change extension behavior.
 */
export function resolveToolDiscoverySurface(
  options: ResolveToolDiscoverySurfaceOptions
): ToolDiscoverySurface {
  const coreTools: Record<string, ToolsInput[string]> = {};
  const deferredTools: Record<string, ToolsInput[string]> = {};
  const coreToolIds: string[] = [];
  const deferredToolIds: string[] = [];
  const eligibleToolIds: string[] = [];

  const eligibleEntries = Object.entries(options.eligibleTools).sort(([left], [right]) => {
    const leftOriginal = options.toolNameMap.get(left) ?? left;
    const rightOriginal = options.toolNameMap.get(right) ?? right;
    return leftOriginal.localeCompare(rightOriginal);
  });
  for (const [sanitizedId, tool] of eligibleEntries) {
    const originalId = options.toolNameMap.get(sanitizedId);
    if (!originalId) {
      throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
        context: { phase: 'partition', sanitizedId },
        detail: `eligible tool "${sanitizedId}" is missing its original-name mapping`,
      });
    }

    eligibleToolIds.push(originalId);
    // Existing provider-defined tools (currently native web search) must stay
    // on the initial surface. Their provider-owned id/type pair is executable
    // metadata, not a normal function schema that ToolSearchProcessor can
    // safely rename or reactivate. Provider-native discovery remains a later
    // slice; keeping this tiny surface eager preserves today's capability.
    const isProviderDefinedTool =
      originalId === WEB_SEARCH_TOOL_ID &&
      tool !== null &&
      typeof tool === 'object' &&
      (tool as { readonly type?: unknown }).type === 'provider';
    // SkillsProcessor advertises the canonical skill tools as immediately
    // callable progressive-disclosure controls. Keep those three eager; hiding
    // them behind search_tools would make Mastra's own injected instructions
    // point at unavailable tools.
    // Artifact continuations are also direct runtime instructions. Keep the
    // authorized reader callable without a separate discovery round trip.
    const isArtifactReader = originalId === NATIVE_TOOL_ID.readToolOutputArtifact;
    const isDeferredNative =
      !(isProviderDefinedTool || isArtifactReader) &&
      isNativeToolId(originalId) &&
      !isSkillNativeToolId(originalId) &&
      NATIVE_TOOL_DEFAULTS[originalId].loadingTier !== 'critical';
    const isMcpTool = !options.localToolIds.has(sanitizedId);
    if (!isProviderDefinedTool && (isDeferredNative || isMcpTool)) {
      deferredTools[sanitizedId] = tool;
      deferredToolIds.push(originalId);
      continue;
    }

    coreTools[sanitizedId] = tool;
    coreToolIds.push(originalId);
  }

  return {
    coreTools: coreTools as ToolsInput,
    deferredTools: deferredTools as ToolsInput,
    metadata: {
      adapter: options.adapter,
      coreToolIds,
      deferredToolIds,
      eligibleToolIds,
    },
  };
}

export function isHostedProviderRuntime(provider: ProviderId): boolean {
  // Registry-derived (BST-1349) with FAIL-OPEN polarity (PR #2513 review,
  // finding 4): only the known local runtimes opt out of the hosted path, so
  // an unknown id or a future runtime value keeps the pre-BST-1349 hosted
  // default. Guarded lookup: an out-of-registry id must not TypeError.
  const runtime = findProviderDefinition(provider)?.runtime;
  return runtime !== 'local' && runtime !== 'browser';
}

/**
 * A hosted run's discovery adapter: Mastra catalog search, explicitly
 * requested; none for a local or browser runtime. An unsupported resolution
 * fails the run rather than substituting another strategy.
 */
export function resolveHostedToolDiscoveryAdapter(
  provider: ProviderId,
  modelName: string
): ToolDiscoveryAdapter | undefined {
  if (!isHostedProviderRuntime(provider)) {
    return;
  }
  const resolution = resolveToolDiscoveryAdapter({
    modelId: modelName,
    provider,
    requestedAdapter: 'mastra-catalog-search',
  });
  if (resolution.status === 'unsupported') {
    throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
      context: {
        phase: 'adapter-resolution',
        provider,
        reason: resolution.reason,
        requestedAdapter: 'mastra-catalog-search',
      },
      detail: `Mastra catalog discovery is unsupported for ${provider}/${modelName}: ${resolution.reason}`,
    });
  }
  return resolution.adapter;
}

type ToolSearchStepArgs = Parameters<ToolSearchProcessor['processInputStep']>[0];
type ToolSearchStepResult = Awaited<ReturnType<ToolSearchProcessor['processInputStep']>>;
type SearchTool = ToolSearchStepResult['tools']['search_tools'];
/** Mastra's fixed exact-selection meta-tool id (reserved alongside `search_tools`). */
const LOAD_TOOL_ID = 'load_tool';
/**
 * Mastra types `load_tool` as optional because `search.autoLoad: true` omits
 * it. Brainstrike runs manual loading (BST-1667), so the exact-selection
 * control is REQUIRED on every step and its absence is a typed failure.
 */
type LoadTool = NonNullable<ToolSearchStepResult['tools'][typeof LOAD_TOOL_ID]>;
type CatalogTool = ReturnType<typeof createDeferredToolCatalog>;
type DiscoveryStepResult = Omit<ToolSearchStepResult, 'tools'> & {
  tools: Omit<ToolSearchStepResult['tools'], typeof LOAD_TOOL_ID> & {
    [LOAD_TOOL_ID]: LoadTool;
    [LIST_AVAILABLE_TOOLS_ID]: CatalogTool;
  };
};

export interface ToolDiscoverySearchObservation {
  readonly query: string;
  readonly rankedResults: readonly {
    readonly score: number;
    readonly toolId: string;
  }[];
  readonly stepNumber: number | undefined;
}

type ToolDiscoverySearchObserver = (observation: ToolDiscoverySearchObservation) => void;

/**
 * The model-facing description of `search_tools` itself — the OTHER place a
 * model looks to decide whether searching for a capability is worthwhile
 * (review of #2625: this carried a second, stale hand-written list that never
 * mentioned canvas or skill scripts). Derived per run from the ACTUAL deferred
 * set through the same family table as the instructions' discovery line, so
 * the two surfaces cannot disagree and neither can advertise a capability the
 * run cannot load.
 */
function buildSearchToolDescription(
  deferredTools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>
): string {
  const originalIds = new Set(
    Object.keys(deferredTools).map((sanitizedId) => toolNameMap.get(sanitizedId) ?? sanitizedId)
  );
  const families = describeAvailableDeferredCapabilityFamilies(originalIds);
  const familiesClause = families.length > 0 ? ` this run: ${families}` : '';
  return `Search deferred capabilities${familiesClause}, including MCP tools, by keyword. Returns at most 3 ranked matches, not a complete inventory, and does not load them: call load_tool with the exact name(s) to use a match. If you already know a tool's exact name, call load_tool directly instead of searching. For the full inventory use list_available_tools.`;
}

/**
 * The model-facing sentence in a successful `search_tools` result. Mastra's
 * own copy says the match is "available on your next turn"; in chat
 * vocabulary a turn is a user message, and on 2026-09-02 a live run took it
 * that way: the loaded definition was in the very next step, yet the model
 * ended its reply with "I'll create the Linear issue once the ticket
 * integration finishes loading" (finishReason `stop`, no call ever sent).
 * Brainstrike owns this executor, so the sentence is Brainstrike's.
 *
 * Under manual loading (BST-1667) a search is discovery only: the copy follows
 * Mastra's own manual-mode contract (search, then `load_tool`, then use) so
 * every prompt surface — Mastra's injected system line, this sentence, the
 * tool descriptions, and the composed instructions — tells one story.
 */
function describeSearchMatches(matchedToolNames: readonly string[], catalogSize: number): string {
  return `Found ${matchedToolNames.length} ranked match(es): ${matchedToolNames.join(', ')}. These are ranked matches, not the complete catalog of ${catalogSize} eligible deferred tools; use list_available_tools to enumerate. Matches are not loaded yet: call load_tool with the exact name (toolNames for several) and it is callable on your next step in this same response — keep going and call it; do not end your reply to wait for loading.`;
}

/**
 * Same correction for `load_tool`: Mastra's success copy ends "available on
 * your next turn", in both its single form and its batch form ("Loaded: a, b
 * — available on your next turn | Not found: c"). The replacement keys on
 * that phrase, not on `success`: a mixed batch reports `success: false` while
 * genuinely loading the found names, and those ARE callable next step
 * (review of #3049). Copy without the phrase — a plain miss, "Did you mean" —
 * passes through verbatim: there is nothing to call.
 */
const LOAD_TOOL_NEXT_TURN_PATTERN = /\b(?:will be )?available on your next turns?\b/g;
// Kept clause-shaped (no colon) so it also reads inside Mastra's batch
// sentence: "Loaded: a — <clause> | Not found: c".
const LOAD_TOOL_SAME_RESPONSE_CLAUSE =
  'callable on your next step in this same response (keep going and call it now; do not end your reply to wait for loading)';

function describeLoadResult(message: string): string {
  return message.replace(LOAD_TOOL_NEXT_TURN_PATTERN, LOAD_TOOL_SAME_RESPONSE_CLAUSE);
}

function readSearchQuery(args: readonly unknown[]): string | undefined {
  const input = args[0];
  if (!input || typeof input !== 'object') {
    return;
  }
  const query = (input as { readonly query?: unknown }).query;
  return typeof query === 'string' ? query : undefined;
}

interface ParsedSearchResult extends Pick<ToolDiscoverySearchObservation, 'rankedResults'> {
  /** Sanitized ids exactly as the model must call them, in ranked order. */
  readonly matchedNames: readonly string[];
}

function readSearchResult(
  value: unknown,
  toolNameMap: ReadonlyMap<string, string>
): ParsedSearchResult | undefined {
  if (!value || typeof value !== 'object') {
    return;
  }
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return;
  }
  const rankedResults: { score: number; toolId: string }[] = [];
  const matchedNames: string[] = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') {
      return;
    }
    const { name, score } = result as { readonly name?: unknown; readonly score?: unknown };
    if (typeof name !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
      return;
    }
    rankedResults.push({ score, toolId: toolNameMap.get(name) ?? name });
    matchedNames.push(name);
  }
  return { matchedNames, rankedResults };
}

/** The executor type a meta-tool declares, with the optional `undefined` removed. */
type ExecuteOf<T> = T extends { readonly execute?: infer E } ? NonNullable<E> : never;

/**
 * Clone a Mastra meta-tool with a replaced executor (and optionally a replaced
 * description) while preserving every other own property descriptor and the
 * prototype. Mastra's `createTool` returns an object whose executor closes
 * over the step, so the original executor stays reachable — it is only
 * wrapped. Descriptor flags are copied from the original property when it
 * exists; the replacement executor is typed against the tool's own `execute`.
 */
function cloneMetaTool<T extends object>(
  tool: T,
  overrides: { readonly description?: string; readonly execute: ExecuteOf<T> }
): T {
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(tool);
  const executeDescriptor = descriptors['execute'];
  descriptors['execute'] = {
    configurable: executeDescriptor?.configurable ?? true,
    enumerable: executeDescriptor?.enumerable ?? true,
    value: overrides.execute,
    writable:
      executeDescriptor && 'writable' in executeDescriptor ? executeDescriptor.writable : true,
  };
  if (overrides.description !== undefined) {
    const descriptionDescriptor = descriptors['description'];
    descriptors['description'] = {
      configurable: descriptionDescriptor?.configurable ?? true,
      enumerable: descriptionDescriptor?.enumerable ?? true,
      value: overrides.description,
      writable:
        descriptionDescriptor && 'writable' in descriptionDescriptor
          ? descriptionDescriptor.writable
          : true,
    };
  }
  const clone = Object.create(Object.getPrototypeOf(tool)) as object;
  return Object.defineProperties(clone, descriptors) as T;
}

function wrapSearchTelemetry(
  searchTool: SearchTool,
  stepNumber: number | undefined,
  toolNameMap: ReadonlyMap<string, string>,
  notify: ToolDiscoverySearchObserver,
  description: string,
  catalogSize: number
): SearchTool {
  const execute = searchTool.execute;
  if (!execute) {
    throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
      context: { phase: 'search-tool-construction', stepNumber },
      detail: 'Mastra ToolSearchProcessor returned search_tools without an executor',
    });
  }
  return cloneMetaTool(searchTool, {
    description,
    execute: async (...args: Parameters<typeof execute>) => {
      const query = readSearchQuery(args);
      if (query === undefined) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { phase: 'search-query', stepNumber },
          detail: 'search_tools received an invalid query shape',
        });
      }
      const result = await execute(...args);
      const searchResult = readSearchResult(result, toolNameMap);
      if (!searchResult) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { phase: 'search-result', stepNumber },
          detail: 'search_tools returned an invalid result shape',
        });
      }
      const observation: ToolDiscoverySearchObservation = {
        query,
        rankedResults: searchResult.rankedResults,
        stepNumber,
      };
      notify(observation);
      if (searchResult.rankedResults.length === 0) {
        // Mastra's own "No tools found matching …" copy stays: there is
        // nothing to call, so the same-response sentence would be a lie.
        logger.info('Mastra tool discovery search missed', {
          code: 'mastra_tool_discovery_catalog_miss',
          queryLength: query.length,
          stepNumber,
        });
        return result;
      }
      logger.info('Mastra tool discovery search matched tools', {
        code: 'mastra_tool_discovery_search_matched',
        queryLength: query.length,
        rankedResults: searchResult.rankedResults,
        stepNumber,
      });
      // The names come from the parse above (the same object readSearchResult
      // validated), not from a second cast. Only the sentence changes; the
      // ranked list is returned untouched.
      const matchedResult = result as Extract<
        Awaited<ReturnType<typeof execute>>,
        { readonly results: unknown }
      >;
      return {
        ...matchedResult,
        message: describeSearchMatches(searchResult.matchedNames, catalogSize),
      };
    },
  });
}

function readLoadResult(
  value: unknown
): { readonly message: string; readonly success: boolean } | undefined {
  if (!value || typeof value !== 'object') {
    return;
  }
  const { message, success } = value as { readonly message?: unknown; readonly success?: unknown };
  if (typeof message !== 'string' || typeof success !== 'boolean') {
    return;
  }
  return { message, success };
}

function wrapLoadTool(
  loadTool: LoadTool,
  stepNumber: number | undefined,
  eagerToolIds: ReadonlySet<string>
): LoadTool {
  const execute = loadTool.execute;
  if (!execute) {
    throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
      context: { phase: 'load-tool-construction', stepNumber },
      detail: 'Mastra ToolSearchProcessor returned load_tool without an executor',
    });
  }
  return cloneMetaTool(loadTool, {
    execute: async (...args: Parameters<typeof execute>) => {
      const [input, ...context] = args;
      const requested = [
        ...new Set([...(input.toolNames ?? []), ...(input.toolName ? [input.toolName] : [])]),
      ];
      const eager = requested.filter((name) => eagerToolIds.has(name));
      const deferred = requested.filter((name) => !eagerToolIds.has(name));
      // The current step already authorized these tools; loading must not report
      // them missing merely because Mastra's deferred catalog omits them.
      if (eager.length > 0 && input.toolNames === undefined && deferred.length === 0) {
        return {
          message: `Tool "${input.toolName}" is already available.`,
          success: true,
          toolName: input.toolName,
        };
      }
      const result =
        eager.length === 0
          ? await execute(...args)
          : deferred.length > 0
            ? await execute({ toolNames: deferred }, ...context)
            : { loadedCount: 0, message: '', success: true };

      const loadResult = readLoadResult(result);
      if (!loadResult) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { phase: 'load-result', stepNumber },
          detail: 'load_tool returned an invalid result shape',
        });
      }
      logger.info('Mastra tool discovery load requested', {
        code: 'mastra_tool_discovery_load',
        stepNumber,
        success: loadResult.success,
      });
      // Mastra's deferred `toolName` / `loaded` fields —
      // which its context store parses to derive the loaded set — are
      // returned untouched.
      const loadedResult = result as Extract<
        Awaited<ReturnType<typeof execute>>,
        { success: boolean }
      >;
      return {
        ...loadedResult,
        ...(eager.length > 0
          ? { alreadyLoaded: [...eager, ...(loadedResult.alreadyLoaded ?? [])] }
          : {}),
        message: [
          describeLoadResult(loadResult.message),
          ...(eager.length > 0 ? [`Already available: ${eager.join(', ')}`] : []),
        ]
          .filter(Boolean)
          .join(' | '),
      };
    },
  });
}

/**
 * Step arguments over persisted conversation messages, for Mastra's
 * context-store parser to derive the loaded set (no step has run).
 */
export function createPersistedStepArgs(
  messages: readonly MastraDBMessage[],
  model: ToolSearchStepArgs['model'],
  requestContext: ToolSearchStepArgs['requestContext']
): ToolSearchStepArgs {
  const messageList = new MessageList();
  for (const message of messages) {
    messageList.add(message, 'memory');
  }
  return {
    abort(reason?: string): never {
      throw new Error(reason ?? 'persisted tool discovery hydration aborted');
    },
    messageList,
    messages: messageList.get.all.db(),
    model,
    ...(requestContext ? { requestContext } : {}),
    retryCount: 0,
    state: {},
    stepNumber: 0,
    steps: [],
    systemMessages: [],
    tools: {},
  };
}

/**
 * Brainstrike-owned fail-loud shell around Mastra's processor. The searchable
 * catalog is already post-gate, so no Mastra filter hook is used (Mastra treats
 * filter exceptions as a silent rejection). Context-derived state stays the
 * durable source of truth and any mid-run loaded-set shrink is surfaced.
 */
export class BrainstrikeToolSearchProcessor {
  readonly description = 'Searches the post-gate Brainstrike tool catalog';
  readonly id = 'tool-search';
  readonly name = 'Brainstrike Tool Search Processor';
  private readonly delegate: ToolSearchProcessor;
  private readonly catalogSize: number;
  private readonly catalogTool: CatalogTool;
  private readonly loadPersistedMessages:
    | ((requestContext?: RequestContext) => Promise<readonly MastraDBMessage[]>)
    | undefined;
  private readonly model: ToolSearchStepArgs['model'];
  private readonly onToolsLoaded: ((tools: ToolsInput) => void) | undefined;
  private readonly previousLoadedByThread = new Map<string, ReadonlySet<string>>();
  private readonly searchObservers = new Set<ToolDiscoverySearchObserver>();
  private readonly searchToolDescription: string;
  private readonly toolNameMap: ReadonlyMap<string, string>;

  constructor(options: {
    readonly deferredTools: ToolsInput;
    readonly loadPersistedMessages?: (
      requestContext?: RequestContext
    ) => Promise<readonly MastraDBMessage[]>;
    readonly model: ToolSearchStepArgs['model'];
    readonly onToolsLoaded?: (tools: ToolsInput) => void;
    readonly toolNameMap: ReadonlyMap<string, string>;
  }) {
    this.delegate = new ToolSearchProcessor({
      // Manual loading is Mastra's default and the only mode that exposes
      // `load_tool`, the SDK's exact-name selection control. `autoLoad: true`
      // withheld it, and BST-1628 then re-implemented exact selection inside
      // BM25 search through a pnpm patch (retired by BST-1667).
      search: { autoLoad: false, topK: 3 },
      storage: 'context',
      tools: options.deferredTools as Record<string, Tool>,
    });
    this.catalogSize = Object.keys(options.deferredTools).length;
    this.catalogTool = createDeferredToolCatalog(options.deferredTools, options.toolNameMap);
    this.loadPersistedMessages = options.loadPersistedMessages;
    this.model = options.model;
    this.onToolsLoaded = options.onToolsLoaded;
    this.searchToolDescription = buildSearchToolDescription(
      options.deferredTools,
      options.toolNameMap
    );
    this.toolNameMap = new Map(options.toolNameMap);
  }

  subscribeSearchObservations(observer: ToolDiscoverySearchObserver): () => void {
    this.searchObservers.add(observer);
    return () => {
      this.searchObservers.delete(observer);
    };
  }

  private notifySearchObservers(observation: ToolDiscoverySearchObservation): void {
    for (const observer of this.searchObservers) {
      try {
        observer(observation);
      } catch {
        logger.warn('Mastra tool discovery observer failed', {
          code: 'mastra_tool_discovery_observer_failure',
        });
      }
    }
  }

  private trackLoadedTools(
    threadId: string | undefined,
    loadedSanitizedIds: readonly string[],
    tools: ToolSearchStepResult['tools']
  ): void {
    // Mastra's declared result shape names only its meta tools, while runtime
    // keys also include every loaded catalog tool discovered via Object.keys.
    const toolsById = tools as unknown as Record<string, ToolsInput[string]>;
    if (!threadId) {
      if (this.onToolsLoaded && loadedSanitizedIds.length > 0) {
        // Without a thread key there is no safe cross-step de-duplication key;
        // measure the full loaded set for this anonymous step.
        this.onToolsLoaded(
          Object.fromEntries(
            loadedSanitizedIds.map((toolId) => [toolId, toolsById[toolId]])
          ) as ToolsInput
        );
      }
      return;
    }

    const previous = this.previousLoadedByThread.get(threadId);
    const current = new Set(loadedSanitizedIds);
    const invalidated = previous
      ? Array.from(previous).filter((toolId) => !current.has(toolId))
      : [];
    if (invalidated.length > 0) {
      throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
        context: {
          invalidatedToolIds: invalidated.map((toolId) => this.toolNameMap.get(toolId) ?? toolId),
          phase: 'context-trimming',
          threadId,
        },
        detail: 'context trimming invalidated loaded tool state during the active runtime',
      });
    }
    const newlyLoadedIds = previous
      ? loadedSanitizedIds.filter((toolId) => !previous.has(toolId))
      : loadedSanitizedIds;
    if (newlyLoadedIds.length > 0) {
      const newlyLoadedTools = Object.fromEntries(
        newlyLoadedIds.map((toolId) => [toolId, toolsById[toolId]])
      ) as ToolsInput;
      this.onToolsLoaded?.(newlyLoadedTools);
    }
    this.previousLoadedByThread.set(threadId, current);
  }

  async getLoadedToolsForRequestContext(
    args?: Parameters<ToolSearchProcessor['getLoadedToolsForRequestContext']>[0]
  ): Promise<Record<string, Tool>> {
    try {
      const loadedTools = await this.delegate.getLoadedToolsForRequestContext(args);
      if (args?.stepArgs || Object.keys(loadedTools).length > 0 || !this.loadPersistedMessages) {
        return loadedTools;
      }

      // Approval/suspension resume rebuilds the Agent and executes the paused
      // tool before processInputStep runs. A fresh context-backed processor has
      // no supplemental in-memory set, so rehydrate from the durable thread
      // messages and let Mastra's own context-store parser resolve loaded ids.
      const persistedMessages = await this.loadPersistedMessages(args?.requestContext);
      if (persistedMessages.length === 0) {
        return loadedTools;
      }
      return await this.delegate.getLoadedToolsForRequestContext({
        ...args,
        stepArgs: createPersistedStepArgs(persistedMessages, this.model, args?.requestContext),
      });
    } catch (error) {
      throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
        cause: error,
        context: { phase: 'resume-loaded-tools' },
        detail: error instanceof Error ? error.message : 'loaded-tool resume failed',
      });
    }
  }

  async processInputStep(args: ToolSearchStepArgs): Promise<DiscoveryStepResult> {
    try {
      const result = await this.delegate.processInputStep(args);
      const baseToolIds = new Set(Object.keys(args.tools ?? {}));
      const loadedSanitizedIds = Object.keys(result.tools).filter(
        (toolId) =>
          toolId !== 'search_tools' &&
          toolId !== LOAD_TOOL_ID &&
          toolId !== LIST_AVAILABLE_TOOLS_ID &&
          !baseToolIds.has(toolId)
      );
      const loadedToolIds = loadedSanitizedIds.map((toolId) => {
        const originalId = this.toolNameMap.get(toolId);
        if (!originalId) {
          throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
            context: { phase: 'loaded-tool-mapping', sanitizedId: toolId },
            detail: 'loaded tool is missing its original-name mapping',
          });
        }
        return originalId;
      });
      const threadIdValue = args.requestContext?.get(MASTRA_THREAD_ID_KEY);
      if (
        threadIdValue !== undefined &&
        (typeof threadIdValue !== 'string' || threadIdValue.trim().length === 0)
      ) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { phase: 'context-trimming' },
          detail: 'Mastra tool discovery received an invalid thread id from request context',
        });
      }
      const threadId = typeof threadIdValue === 'string' ? threadIdValue : undefined;
      this.trackLoadedTools(threadId, loadedSanitizedIds, result.tools);
      const loadTool = result.tools[LOAD_TOOL_ID];
      if (!loadTool) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { phase: 'load-tool-construction', stepNumber: args.stepNumber },
          detail: 'Mastra ToolSearchProcessor returned no load_tool; manual loading requires it',
        });
      }
      const tools = {
        ...result.tools,
        [LOAD_TOOL_ID]: wrapLoadTool(loadTool, args.stepNumber, baseToolIds),
        [LIST_AVAILABLE_TOOLS_ID]: this.catalogTool,
      };

      logger.info('Mastra tool discovery step prepared', {
        activeDefinitionCount: Object.keys(tools).length,
        code: 'mastra_tool_discovery_step',
        loadedToolIds,
        stepNumber: args.stepNumber,
      });
      tools.search_tools = wrapSearchTelemetry(
        result.tools.search_tools,
        args.stepNumber,
        this.toolNameMap,
        (observation) => {
          this.notifySearchObservers(observation);
        },
        this.searchToolDescription,
        this.catalogSize
      );
      return { ...result, tools };
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'mastra_agent_tool_discovery_failure'
      ) {
        throw error;
      }
      logger.error('Mastra tool discovery processor failed', {
        code: 'mastra_tool_discovery_processor_failure',
        error: error instanceof Error ? error.message : String(error),
        stepNumber: args.stepNumber,
      });
      throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
        cause: error,
        context: { phase: 'process-input-step', stepNumber: args.stepNumber },
        detail: error instanceof Error ? error.message : 'tool discovery processor failed',
      });
    }
  }
}
