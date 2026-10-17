import {
  BrainstrikeToolSearchProcessor,
  createListingOnlyModel,
  createPersistedStepArgs,
  LIST_AVAILABLE_TOOLS_ID,
  resolveHostedToolDiscoveryAdapter,
  resolveToolDiscoverySurface,
} from '@brainstrike/agent/tool-runtime';
import { HOST_META_TOOL_ID } from '@brainstrike/assistant-contract';
import type { ProviderId } from '@brainstrike/assistant-contract/provider-registry';
import type { StateStore } from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve, type ToolExecutionContext } from '@mastra/core/tools';
import { asSchema, type FlexibleSchema } from 'ai';
import { committedRowAddress, committedRunAncestors } from '../committed-identities.js';
import { readHostRow } from '../event-storage.js';
import { executableInputSchema } from '../executable-input-schema.js';
import type { HostTool, HostToolDiscovery } from '../ports.js';
import { committedMemoryTranscript } from './committed-memory-transcript.js';

/** Mastra's fixed meta-tool ids, beside Brainstrike's catalog tool. */
const SEARCH_TOOLS_ID = HOST_META_TOOL_ID.searchTools;
const LOAD_TOOL_ID = HOST_META_TOOL_ID.loadTool;

type HostRunKey = Parameters<HostToolDiscovery['activeTools']>[0];
type DiscoveryTools = Awaited<
  ReturnType<BrainstrikeToolSearchProcessor['processInputStep']>
>['tools'];

/**
 * The committed conversation of a run's branch (its ancestor runs, then the run)
 * in Mastra's stored form (the Memory transcript's own conversion). Discovery
 * reads loads from the same history the model receives: a load an earlier run
 * committed stays loaded, so a model that sees "Already loaded" is offered the
 * tool. A sibling branch never saw that load and starts unloaded.
 */
export async function committedRunMessages(
  store: Pick<StateStore, 'read' | 'root'>,
  resourceId: string,
  run: HostRunKey
): Promise<MastraDBMessage[]> {
  const rows = await Promise.all(
    (await store.read(run.threadId, 0)).map((row) => readHostRow(store, row))
  );
  const branch = new Set([...committedRunAncestors(rows, run.runId), run.runId]);
  const own = new Set(
    rows.flatMap((row) =>
      'runId' in row.event && branch.has(row.event.runId) ? [committedRowAddress(row)] : []
    )
  );
  return committedMemoryTranscript(rows, resourceId).filter((message) => own.has(message.id));
}

/** A discovery tool as Mastra's processor prepares it for one step. */
interface DiscoveryTool<TInput> {
  readonly description: string;
  readonly execute?:
    | ((input: TInput, context: ToolExecutionContext) => Promise<unknown>)
    | undefined;
  readonly id: string;
  readonly inputSchema?: FlexibleSchema<TInput> | undefined;
}

function requireDiscoverySchema<TInput>(tool: DiscoveryTool<TInput>): FlexibleSchema<TInput> {
  if (!tool.inputSchema) {
    throw new Error(`Discovery tool ${tool.id} has no input schema`);
  }
  return tool.inputSchema;
}

/**
 * A Core-dispatched discovery tool: declared once, and each call runs the
 * executor Mastra prepared over the calling run's committed steps.
 */
function discoveryHostTool<TInput>(
  declared: DiscoveryTool<TInput>,
  current: (run: HostRunKey) => Promise<DiscoveryTool<TInput>>
): HostTool {
  return {
    description: declared.description,
    execute: async (input, context) => {
      const tool = await current({ runId: context.runId, threadId: context.threadId });
      const { execute, inputSchema } = tool;
      if (!(execute && inputSchema)) {
        throw new Error(`Discovery tool ${tool.id} has no executor or input schema`);
      }
      const validate = asSchema(executableInputSchema(inputSchema)).validate;
      if (!validate) {
        throw new Error(`Discovery tool ${tool.id} has no input validator`);
      }
      const parsed = await validate(input);
      if (!parsed.success) {
        throw new Error(`Discovery tool ${tool.id} received invalid input`);
      }
      return await execute.call(tool, parsed.value, {
        abortSignal: context.signal,
        observe: noopObserve,
        requestContext: new RequestContext(),
        runId: context.runId,
      });
    },
    identity: `host-tool-discovery:${declared.id}`,
    inputSchema: requireDiscoverySchema(declared),
    risk: 'read',
  };
}

/** A run's admitted tools under its provider and model. */
interface HostDiscoveryCatalog {
  readonly modelId: string;
  readonly provider: ProviderId;
  /** The split reads declarations only, so a descriptor that names no executor qualifies. */
  readonly tools: Readonly<
    Record<string, Pick<HostTool, 'description' | 'mcpBinding' | 'permissionToolId'>>
  >;
}

/** The legacy hosted split; undefined for a local runtime or when nothing defers. */
function hostDiscoverySplit(catalog: HostDiscoveryCatalog) {
  const adapter = resolveHostedToolDiscoveryAdapter(catalog.provider, catalog.modelId);
  if (!adapter) {
    return;
  }
  const entries = Object.entries(catalog.tools);
  const toolNameMap = new Map(entries.map(([name, tool]) => [name, tool.permissionToolId ?? name]));
  const surface = resolveToolDiscoverySurface({
    adapter,
    // Declarations only: the catalog ranks names and descriptions; Core executes.
    eligibleTools: Object.fromEntries(
      entries.map(([name, tool]) => [name, createTool({ description: tool.description, id: name })])
    ),
    localToolIds: new Set(entries.flatMap(([name, tool]) => (tool.mcpBinding ? [] : [name]))),
    toolNameMap,
  });
  return Object.keys(surface.deferredTools).length > 0 ? { surface, toolNameMap } : undefined;
}

/**
 * Whether a run's admission defers these tools behind hosted discovery, so
 * its instructions teach discovery (legacy `toolDiscoveryEnabled`).
 */
export function hostToolDiscoveryEnabled(catalog: HostDiscoveryCatalog): boolean {
  return hostDiscoverySplit(catalog) !== undefined;
}

/**
 * The legacy hosted discovery (`prepareHostedToolDiscovery`) over a run's
 * admitted tools: the same eager/deferred split, the same Brainstrike shell
 * around Mastra's processor, and its loaded set derived from the run's branch's
 * committed messages. Undefined for a local runtime or when nothing defers.
 */
export async function createHostToolDiscovery(
  options: HostDiscoveryCatalog & {
    readonly readRunMessages: (run: HostRunKey) => Promise<readonly MastraDBMessage[]>;
  }
): Promise<
  | { readonly discovery: HostToolDiscovery; readonly tools: Readonly<Record<string, HostTool>> }
  | undefined
> {
  const split = hostDiscoverySplit(options);
  if (!split) {
    return;
  }
  const { surface, toolNameMap } = split;
  // As legacy: required by the step arguments, never consulted by the context store.
  const model = createListingOnlyModel();
  const processor = new BrainstrikeToolSearchProcessor({
    deferredTools: surface.deferredTools,
    model,
    toolNameMap,
  });
  const step = async (run: HostRunKey): Promise<DiscoveryTools> =>
    (
      await processor.processInputStep({
        ...createPersistedStepArgs(await options.readRunMessages(run), model, undefined),
        tools: surface.coreTools,
      })
    ).tools;
  // The declarations (descriptions, schemas) of a run that loaded nothing yet.
  const initial = (
    await processor.processInputStep({
      ...createPersistedStepArgs([], model, undefined),
      tools: surface.coreTools,
    })
  ).tools;
  const tools: Record<string, HostTool> = {
    [LIST_AVAILABLE_TOOLS_ID]: discoveryHostTool(
      initial[LIST_AVAILABLE_TOOLS_ID],
      async (run) => (await step(run))[LIST_AVAILABLE_TOOLS_ID]
    ),
    [LOAD_TOOL_ID]: discoveryHostTool(
      initial[LOAD_TOOL_ID],
      async (run) => (await step(run))[LOAD_TOOL_ID]
    ),
    [SEARCH_TOOLS_ID]: discoveryHostTool(
      initial[SEARCH_TOOLS_ID],
      async (run) => (await step(run))[SEARCH_TOOLS_ID]
    ),
  };
  return {
    discovery: {
      activeTools: async (run) => Object.keys(await step(run)),
      toolIds: new Set(Object.keys(tools)),
    },
    tools,
  };
}
