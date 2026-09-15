/**
 * The ROOT's live approval gate, pinned on the tool map the Agent actually
 * executes (BST-1749 review finding: the permission gate no longer makes a
 * kept 'ask' tool suspend by itself — only `applyLiveApprovalGate` does).
 *
 * `resolveGatedToolMap` clones every kept ask tool with the FUNCTION form of
 * Mastra's per-tool `requireApproval`; the provider-native swap, artifact
 * settlement, model projection and the discovery split all run AFTER that
 * clone. A later stage that dropped or rebuilt the clone would let an ask tool
 * execute unprompted. Children are already pinned at their executed map
 * (`build-persona-subagents.spec.ts`, `build-persona-subagents-approval-gate.spec.ts`);
 * this file is the root's equivalent, including the DEFERRED surface a hosted
 * provider loads through tool search (non-critical native tools, every MCP tool).
 *
 * Integration lane: real PGlite storage — without storage the runtime omits
 * every ask tool instead of keeping it (tool-pipeline.ts fail-safe), which
 * would make every assertion here vacuous. No network: construction only.
 */
import {
  buildNativeToolRiskMap,
  DEFAULT_PERMISSION_POLICIES,
  NATIVE_TOOL_ID,
  type PermissionToolGateSnapshot,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import { PGlite } from '@electric-sql/pglite';
import { MessageList } from '@mastra/core/agent';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { MASTRA_THREAD_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMastraAgentRuntime, type MastraAgentRuntime } from '../mastra/agent-runtime';
import { sanitizeToolName } from '../mastra/tool-sanitizer';
import { createPgliteMastraMemory, type PgliteDatabase } from '../pglite-mastra-memory';
import { createListingOnlyModel } from '../providers/listing-only-model';

/** Unknown caller-supplied local tools stay on the eager (core) surface. */
const EAGER_ASK_TOOL = 'fixture.shell';
const EAGER_ALLOW_TOOL = 'fixture.read';
/** A non-critical native edit tool: deferred behind tool search for a hosted provider. */
const DEFERRED_ASK_TOOL = NATIVE_TOOL_ID.deleteWorkspaceFile;

const ASK_POLICY: PermissionToolGateSnapshot = {
  defaultRisk: 'mcp',
  perToolOverrides: { [WEB_SEARCH_TOOL_ID]: 'ask' },
  policies: DEFAULT_PERMISSION_POLICIES,
  riskByTool: {
    ...buildNativeToolRiskMap(),
    [EAGER_ALLOW_TOOL]: 'read',
    [EAGER_ASK_TOOL]: 'execute',
  },
  yolo: false,
};

interface ApprovalFlags {
  readonly execute?: unknown;
  readonly needsApprovalFn?: unknown;
  readonly requireApproval?: unknown;
  readonly type?: unknown;
}

function fixtureTool(id: string) {
  return createTool({
    description: `Root live approval gate fixture ${id}.`,
    execute: () => Promise.resolve({ ok: true }),
    id,
    inputSchema: z.object({}),
  });
}

function flagsOf(tool: unknown, id: string): ApprovalFlags {
  if (tool === null || typeof tool !== 'object') {
    throw new Error(`${id} is missing from the executed tool map`);
  }
  return tool as ApprovalFlags;
}

function callable(value: unknown, label: string): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new Error(`${label} is not a function`);
  }
  return value as (...args: unknown[]) => unknown;
}

function createDiscoveryStepArgs(threadId: string, stepNumber: number): ProcessInputStepArgs {
  const messageList = new MessageList();
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_THREAD_ID_KEY, threadId);
  return {
    abort(reason?: string): never {
      throw new Error(reason ?? 'processor aborted');
    },
    messageList,
    messages: messageList.get.all.db(),
    // The same fail-loud inert model the runtime hands its tool-search processor.
    model: createListingOnlyModel(),
    requestContext,
    retryCount: 0,
    state: {},
    stepNumber,
    steps: [],
    systemMessages: [],
    tools: {},
  };
}

/** Load deferred tools exactly as the model would: `load_tool`, then the next step's surface. */
async function loadDeferredTools(
  runtime: MastraAgentRuntime,
  sanitizedIds: readonly string[],
  threadId: string
): Promise<Record<string, unknown>> {
  const processor = runtime.toolSearchProcessor;
  if (!processor) {
    throw new Error('Hosted runtime did not install its tool-search processor');
  }
  const first = await processor.processInputStep(createDiscoveryStepArgs(threadId, 0));
  for (const toolName of sanitizedIds) {
    await first.tools.load_tool.execute?.({ toolName }, { observe: noopObserve });
  }
  const second = await processor.processInputStep(createDiscoveryStepArgs(threadId, 1));
  return second.tools;
}

describe('root live approval gate on the executed tool map', () => {
  let database: PGlite;
  let runtime: MastraAgentRuntime | undefined;

  beforeEach(() => {
    database = new PGlite();
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await database.close();
  });

  async function buildRootRuntime(): Promise<MastraAgentRuntime> {
    const { storage } = await createPgliteMastraMemory({
      database: database as unknown as PgliteDatabase,
    });
    runtime = await createMastraAgentRuntime({
      permissionPolicy: ASK_POLICY,
      runtime: { apiKey: 'sk-test', provider: 'anthropic' },
      storage,
      // Settlement only wraps tools when a durable store exists; this spec
      // never executes a tool, so the store must never be reached.
      toolOutputArtifactStore: {
        store: () => Promise.reject(new Error('root-live-approval-gate never stores output')),
      },
      tools: {
        [DEFERRED_ASK_TOOL]: fixtureTool(DEFERRED_ASK_TOOL),
        [EAGER_ALLOW_TOOL]: fixtureTool(EAGER_ALLOW_TOOL),
        [EAGER_ASK_TOOL]: fixtureTool(EAGER_ASK_TOOL),
        [WEB_SEARCH_TOOL_ID]: fixtureTool(WEB_SEARCH_TOOL_ID),
      },
    });
    return runtime;
  }

  it('every runtime.askTools id carries the function-form requireApproval where the Agent executes it', async () => {
    const root = await buildRootRuntime();
    const coreToolIds = root.toolDiscovery?.coreToolIds ?? [];

    expect([...root.askTools.keys()].sort()).toEqual(
      [DEFERRED_ASK_TOOL, EAGER_ASK_TOOL, WEB_SEARCH_TOOL_ID].map(sanitizeToolName).sort()
    );

    const eagerAskIds: string[] = [];
    const deferredAskIds: string[] = [];
    for (const [sanitizedId, meta] of root.askTools) {
      (coreToolIds.includes(meta.originalName) ? eagerAskIds : deferredAskIds).push(sanitizedId);
    }
    // Both surfaces are exercised, or this invariant proves nothing about one of them.
    expect(eagerAskIds).toEqual([sanitizeToolName(EAGER_ASK_TOOL)]);
    expect(deferredAskIds.sort()).toEqual(
      [DEFERRED_ASK_TOOL, WEB_SEARCH_TOOL_ID].map(sanitizeToolName).sort()
    );

    // Eager: the converted core tool Mastra executes (function form →
    // `requireApproval: true` + a per-call `needsApprovalFn`).
    const executable = await root.agent.getToolsForExecution({});
    for (const sanitizedId of eagerAskIds) {
      const tool = flagsOf(executable[sanitizedId], sanitizedId);
      expect(tool.requireApproval, sanitizedId).toBe(true);
      expect(typeof tool.needsApprovalFn, sanitizedId).toBe('function');
      expect(await callable(tool.needsApprovalFn, sanitizedId)({}, {}), sanitizedId).toBe(true);
    }
    // Control: an allowed tool is not gated, so the assertions above discriminate.
    const allowed = flagsOf(
      executable[sanitizeToolName(EAGER_ALLOW_TOOL)],
      sanitizeToolName(EAGER_ALLOW_TOOL)
    );
    expect(allowed.requireApproval).toBe(false);
    expect(allowed.needsApprovalFn).toBeUndefined();

    // Deferred: the tool object tool search hands Mastra, which converts it
    // with `requireApproval: tool.requireApproval`.
    const loaded = await loadDeferredTools(root, deferredAskIds, 'root-ask-gate-deferred');
    for (const sanitizedId of deferredAskIds) {
      const tool = flagsOf(loaded[sanitizedId], sanitizedId);
      expect(typeof tool.requireApproval, sanitizedId).toBe('function');
      expect(callable(tool.requireApproval, sanitizedId)(), sanitizedId).toBe(true);
    }
  });

  it('an ask-gated web search on anthropic keeps the approval-gated Tavily clone, never the provider-native tool', async () => {
    const root = await buildRootRuntime();
    const sanitizedId = sanitizeToolName(WEB_SEARCH_TOOL_ID);
    const onCoreSurface = (root.toolDiscovery?.coreToolIds ?? []).includes(WEB_SEARCH_TOOL_ID);
    const surface = onCoreSurface
      ? ((await root.agent.listTools()) as Record<string, unknown>)
      : await loadDeferredTools(root, [sanitizedId], 'root-ask-gate-web-search');
    const webSearch = flagsOf(surface[sanitizedId], sanitizedId);

    expect(webSearch.type, 'provider-native web search cannot suspend').not.toBe('provider');
    expect(typeof webSearch.execute).toBe('function');
    expect(typeof webSearch.requireApproval).toBe('function');
    expect(callable(webSearch.requireApproval, sanitizedId)()).toBe(true);
  });
});
