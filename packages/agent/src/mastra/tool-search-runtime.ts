import type { ToolDiscoveryAdapter } from '@brainstrike/assistant-contract';
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
import { MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context';
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

type ToolSearchStepArgs = Parameters<ToolSearchProcessor['processInputStep']>[0];
type ToolSearchStepResult = Awaited<ReturnType<ToolSearchProcessor['processInputStep']>>;
type SearchTool = ToolSearchStepResult['tools']['search_tools'];
type CatalogTool = ReturnType<typeof createDeferredToolCatalog>;
type DiscoveryStepResult = Omit<ToolSearchStepResult, 'tools'> & {
  tools: ToolSearchStepResult['tools'] & { [LIST_AVAILABLE_TOOLS_ID]: CatalogTool };
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
  return `Search deferred capabilities${familiesClause}, including MCP tools. Returns at most 3 ranked matches, not a complete inventory. For available tools use list_available_tools; to load a listed tool, query its exact name. Matches load automatically and are callable on your next step in this same response.`;
}

/**
 * The model-facing sentence in a successful `search_tools` result. Mastra's
 * own copy says the match is "available on your next turn"; in chat
 * vocabulary a turn is a user message, and on 2026-09-02 a live run took it
 * that way: the loaded definition was in the very next step, yet the model
 * ended its reply with "I'll create the Linear issue once the ticket
 * integration finishes loading" (finishReason `stop`, no call ever sent).
 * Brainstrike owns this executor, so the sentence is Brainstrike's.
 */
function describeLoadedSearchResult(
  loadedToolNames: readonly string[],
  catalogSize: number
): string {
  return `Found and loaded ${loadedToolNames.length} tool(s): ${loadedToolNames.join(', ')}. These are ranked matches, not the complete catalog of ${catalogSize} eligible deferred tools. Use list_available_tools to enumerate available capabilities; a tool absent from these matches may still be available. Loaded matches are callable on your next step in this same response: use them when needed and do not end your reply to wait for loading.`;
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
  readonly loadedNames: readonly string[];
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
  const loadedNames: string[] = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') {
      return;
    }
    const { name, score } = result as { readonly name?: unknown; readonly score?: unknown };
    if (typeof name !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
      return;
    }
    rankedResults.push({ score, toolId: toolNameMap.get(name) ?? name });
    loadedNames.push(name);
  }
  return { loadedNames, rankedResults };
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

  const descriptors = Object.getOwnPropertyDescriptors(searchTool);
  const descriptionDescriptor = descriptors.description;
  const executeDescriptor = descriptors.execute;
  descriptors.description = {
    configurable: descriptionDescriptor?.configurable ?? true,
    enumerable: descriptionDescriptor?.enumerable ?? true,
    value: description,
    writable:
      descriptionDescriptor && 'writable' in descriptionDescriptor
        ? descriptionDescriptor.writable
        : true,
  };
  descriptors.execute = {
    configurable: executeDescriptor?.configurable ?? true,
    enumerable: executeDescriptor?.enumerable ?? true,
    value: async (...args: Parameters<typeof execute>) => {
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
      logger.info('Mastra tool discovery search loaded tools', {
        code: 'mastra_tool_discovery_search_loaded',
        queryLength: query.length,
        rankedResults: searchResult.rankedResults,
        stepNumber,
      });
      // The names come from the parse above (the same object readSearchResult
      // validated), not from a second cast. Only the sentence changes; the
      // ranked list is returned untouched.
      const loadedResult = result as Extract<
        Awaited<ReturnType<typeof execute>>,
        { readonly results: unknown }
      >;
      return {
        ...loadedResult,
        message: describeLoadedSearchResult(searchResult.loadedNames, catalogSize),
      };
    },
    writable:
      executeDescriptor && 'writable' in executeDescriptor ? executeDescriptor.writable : true,
  };
  const clone = Object.create(Object.getPrototypeOf(searchTool)) as object;
  return Object.defineProperties(clone, descriptors) as SearchTool;
}

function createPersistedStepArgs(
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
  private readonly loadPersistedMessages: (() => Promise<readonly MastraDBMessage[]>) | undefined;
  private readonly model: ToolSearchStepArgs['model'];
  private readonly onToolsLoaded: ((tools: ToolsInput) => void) | undefined;
  private readonly previousLoadedByThread = new Map<string, ReadonlySet<string>>();
  private readonly searchObservers = new Set<ToolDiscoverySearchObserver>();
  private readonly searchToolDescription: string;
  private readonly toolNameMap: ReadonlyMap<string, string>;

  constructor(options: {
    readonly deferredTools: ToolsInput;
    readonly loadPersistedMessages?: () => Promise<readonly MastraDBMessage[]>;
    readonly model: ToolSearchStepArgs['model'];
    readonly onToolsLoaded?: (tools: ToolsInput) => void;
    readonly toolNameMap: ReadonlyMap<string, string>;
  }) {
    this.delegate = new ToolSearchProcessor({
      search: { autoLoad: true, topK: 3 },
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
      const persistedMessages = await this.loadPersistedMessages();
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
          toolId !== 'load_tool' &&
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
      const tools = { ...result.tools, [LIST_AVAILABLE_TOOLS_ID]: this.catalogTool };

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
