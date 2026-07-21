import type { ToolDiscoveryAdapter } from '@brainstrike/assistant-contract';
import {
  isNativeToolId,
  isSkillNativeToolId,
  NATIVE_TOOL_DEFAULTS,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/utils';
import { type MastraDBMessage, MessageList, type ToolsInput } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context';
import type { Tool } from '@mastra/core/tools';
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
    const isDeferredNative =
      !isProviderDefinedTool &&
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

function readSearchResult(value: unknown): { readonly resultCount: number } | undefined {
  if (!value || typeof value !== 'object') {
    return;
  }
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return;
  }
  return { resultCount: results.length };
}

function wrapSearchTelemetry(searchTool: SearchTool, stepNumber: number | undefined): SearchTool {
  const execute = searchTool.execute;
  if (!execute) {
    throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
      context: { phase: 'search-tool-construction', stepNumber },
      detail: 'Mastra ToolSearchProcessor returned search_tools without an executor',
    });
  }

  return {
    ...searchTool,
    execute: async (...args: Parameters<typeof execute>) => {
      const result = await execute(...args);
      const searchResult = readSearchResult(result);
      if (!searchResult) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { phase: 'search-result', stepNumber },
          detail: 'search_tools returned an invalid result shape',
        });
      }
      if (searchResult.resultCount === 0) {
        logger.info('Mastra tool discovery search missed', {
          code: 'mastra_tool_discovery_catalog_miss',
          stepNumber,
        });
        return result;
      }
      logger.info('Mastra tool discovery search loaded tools', {
        code: 'mastra_tool_discovery_search_loaded',
        loadedToolCount: searchResult.resultCount,
        stepNumber,
      });
      return result;
    },
  };
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
  private readonly loadPersistedMessages: (() => Promise<readonly MastraDBMessage[]>) | undefined;
  private readonly model: ToolSearchStepArgs['model'];
  private readonly previousLoadedByThread = new Map<string, ReadonlySet<string>>();
  private readonly toolNameMap: ReadonlyMap<string, string>;

  constructor(options: {
    readonly deferredTools: ToolsInput;
    readonly loadPersistedMessages?: () => Promise<readonly MastraDBMessage[]>;
    readonly model: ToolSearchStepArgs['model'];
    readonly toolNameMap: ReadonlyMap<string, string>;
  }) {
    this.delegate = new ToolSearchProcessor({
      search: { autoLoad: true, topK: 3 },
      storage: 'context',
      tools: options.deferredTools as Record<string, Tool>,
    });
    this.loadPersistedMessages = options.loadPersistedMessages;
    this.model = options.model;
    this.toolNameMap = options.toolNameMap;
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

  async processInputStep(args: ToolSearchStepArgs): Promise<ToolSearchStepResult> {
    try {
      const result = await this.delegate.processInputStep(args);
      const baseToolIds = new Set(Object.keys(args.tools ?? {}));
      const loadedSanitizedIds = Object.keys(result.tools).filter(
        (toolId) => toolId !== 'search_tools' && toolId !== 'load_tool' && !baseToolIds.has(toolId)
      );
      const loadedToolIds = loadedSanitizedIds.map(
        (toolId) => this.toolNameMap.get(toolId) ?? toolId
      );
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
      if (threadId) {
        const previous = this.previousLoadedByThread.get(threadId);
        const current = new Set(loadedSanitizedIds);
        const invalidated = previous
          ? Array.from(previous).filter((toolId) => !current.has(toolId))
          : [];
        if (invalidated.length > 0) {
          throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
            context: {
              invalidatedToolIds: invalidated.map(
                (toolId) => this.toolNameMap.get(toolId) ?? toolId
              ),
              phase: 'context-trimming',
              threadId,
            },
            detail: 'context trimming invalidated loaded tool state during the active runtime',
          });
        }
        this.previousLoadedByThread.set(threadId, current);
      }

      logger.info('Mastra tool discovery step prepared', {
        activeDefinitionCount: Object.keys(result.tools).length,
        code: 'mastra_tool_discovery_step',
        loadedToolIds,
        stepNumber: args.stepNumber,
      });
      result.tools.search_tools = wrapSearchTelemetry(result.tools.search_tools, args.stepNumber);
      return result;
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
