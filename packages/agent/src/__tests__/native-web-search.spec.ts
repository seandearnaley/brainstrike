import {
  buildNativeToolRiskMap,
  DEFAULT_PERMISSION_POLICIES,
  type PermissionToolGateSnapshot,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import { MessageList, type ToolsInput } from '@mastra/core/agent';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { MASTRA_THREAD_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { filterToolsByPermissionWithMetadata } from '../mastra/permission-tool-gate';
import {
  applyProviderNativeWebSearch,
  createProviderNativeWebSearchTool,
  providerSupportsNativeWebSearch,
} from '../providers/native-web-search';
import { applyToolGuards } from '../tools/guard-tool-execution';

/**
 * A stand-in for the Tavily-backed Mastra tool the desktop registers under
 * WEB_SEARCH_TOOL_ID. What matters for these tests is that it HAS an `execute`
 * (so it can be approval-gated / suspended) — the exact opposite of a
 * provider-native tool, which has none.
 */
function makeTavilyToolStub(): { execute: () => Promise<unknown>; id: string } {
  return {
    execute: () => Promise.resolve({ available: true, results: [] }),
    id: WEB_SEARCH_TOOL_ID,
  };
}

/**
 * The runtime sanitizes `brainstrike.webSearch` (dot) to `brainstrike_webSearch`
 * and records the mapping in `toolNameMap` (sanitized -> original). Every
 * selection input mirrors that real post-sanitize shape.
 */
const SANITIZED_ID = 'brainstrike_webSearch';

function baseParams(overrides: Partial<Parameters<typeof applyProviderNativeWebSearch>[0]> = {}) {
  const tools: ToolsInput = {
    [SANITIZED_ID]: makeTavilyToolStub() as unknown as ToolsInput[string],
  };
  return {
    apiKey: 'sk-test',
    askTools: new Map<string, unknown>(),
    logger: { info: vi.fn() },
    provider: 'anthropic',
    toolNameMap: new Map<string, string>([[SANITIZED_ID, WEB_SEARCH_TOOL_ID]]),
    tools,
    ...overrides,
  };
}

function toolType(tool: unknown): string | undefined {
  return (tool as { type?: string } | undefined)?.type;
}

function toolId(tool: unknown): string | undefined {
  return (tool as { id?: string } | undefined)?.id;
}

function hasExecute(tool: unknown): boolean {
  return typeof (tool as { execute?: unknown } | undefined)?.execute === 'function';
}

describe('WEB_SEARCH_TOOL_ID contract parity', () => {
  it('matches the id the desktop registers the web-search tool under', () => {
    expect(WEB_SEARCH_TOOL_ID).toBe('brainstrike.webSearch');
  });
});

describe('providerSupportsNativeWebSearch', () => {
  it('returns true only for anthropic and openai', () => {
    expect(providerSupportsNativeWebSearch('anthropic')).toBe(true);
    expect(providerSupportsNativeWebSearch('openai')).toBe(true);
  });

  it('returns false for every provider without a first-party native search (incl. google)', () => {
    for (const provider of ['google', 'openrouter', 'ollama', 'lmstudio', 'local', 'unknown']) {
      expect(providerSupportsNativeWebSearch(provider)).toBe(false);
    }
  });
});

describe('createProviderNativeWebSearchTool', () => {
  it('builds a provider-EXECUTED anthropic web-search tool (no execute, correct id)', () => {
    const tool = createProviderNativeWebSearchTool('anthropic', 'sk-test');
    expect(tool).toBeDefined();
    expect(toolType(tool)).toBe('provider');
    expect(toolId(tool)).toBe('anthropic.web_search_20250305');
    // A provider-native tool is executed inside the provider's own infra — it
    // MUST NOT carry a local execute (that is what makes it un-gateable).
    expect(hasExecute(tool)).toBe(false);
  });

  it('builds a provider-EXECUTED openai web-search tool (no execute, correct id)', () => {
    const tool = createProviderNativeWebSearchTool('openai', 'sk-test');
    expect(tool).toBeDefined();
    expect(toolType(tool)).toBe('provider');
    expect(toolId(tool)).toBe('openai.web_search');
    expect(hasExecute(tool)).toBe(false);
  });

  it('returns undefined for a provider with no native search', () => {
    for (const provider of ['google', 'openrouter', 'ollama', 'lmstudio', 'local']) {
      expect(createProviderNativeWebSearchTool(provider, undefined)).toBeUndefined();
    }
  });

  it('does not require an api key to construct the tool object (key rides on the model)', () => {
    const tool = createProviderNativeWebSearchTool('anthropic', undefined);
    expect(toolId(tool)).toBe('anthropic.web_search_20250305');
  });
});

describe('applyProviderNativeWebSearch — selection table', () => {
  it('anthropic + allow → swaps in the provider-native tool', () => {
    const result = applyProviderNativeWebSearch(baseParams({ provider: 'anthropic' }));
    const picked = result[SANITIZED_ID];
    expect(toolType(picked)).toBe('provider');
    expect(toolId(picked)).toBe('anthropic.web_search_20250305');
    expect(hasExecute(picked)).toBe(false);
  });

  it('openai + allow → swaps in the provider-native tool', () => {
    const result = applyProviderNativeWebSearch(baseParams({ provider: 'openai' }));
    const picked = result[SANITIZED_ID];
    expect(toolType(picked)).toBe('provider');
    expect(toolId(picked)).toBe('openai.web_search');
    expect(hasExecute(picked)).toBe(false);
  });

  it.each([
    'google',
    'openrouter',
    'ollama',
    'lmstudio',
    'local',
  ])('provider %s + allow → keeps the Tavily (execute-backed) tool unchanged', (provider) => {
    const params = baseParams({ provider });
    const result = applyProviderNativeWebSearch(params);
    // Same object reference, untouched.
    expect(result[SANITIZED_ID]).toBe(params.tools[SANITIZED_ID]);
    expect(hasExecute(result[SANITIZED_ID])).toBe(true);
  });

  it('CRITICAL: anthropic + ask (in askTools) → keeps Tavily so the run can suspend for approval', () => {
    // A provider-native tool has no execute and CANNOT be approval-gated. When
    // the permission gate resolved webSearch to `ask`, we MUST route to the
    // execute-backed Tavily tool (which suspends) — never silently downgrade.
    const params = baseParams({
      askTools: new Map<string, unknown>([[SANITIZED_ID, { riskCategory: 'read' }]]),
      provider: 'anthropic',
    });
    const result = applyProviderNativeWebSearch(params);
    expect(result[SANITIZED_ID]).toBe(params.tools[SANITIZED_ID]);
    expect(hasExecute(result[SANITIZED_ID])).toBe(true);
  });

  it('anthropic + tool omitted by gate (deny / not registered) → no web search injected', () => {
    const params = baseParams({ provider: 'anthropic', tools: {} });
    const result = applyProviderNativeWebSearch(params);
    expect(result[SANITIZED_ID]).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('does not mutate the input tool map (pure)', () => {
    const params = baseParams({ provider: 'anthropic' });
    const before = params.tools[SANITIZED_ID];
    applyProviderNativeWebSearch(params);
    expect(params.tools[SANITIZED_ID]).toBe(before);
    expect(hasExecute(params.tools[SANITIZED_ID])).toBe(true);
  });
});

/**
 * Defense in depth (study §7): the native tool is injected AFTER the gate in
 * production, but prove the guard + permission layers treat a provider-defined
 * (no-`execute`) object as fully inert — so an accidental future re-ordering
 * that ran it through them could never add an `execute` or approval-clone it.
 */
describe('provider-defined tool is inert through guard + permission gate', () => {
  function providerDefinedTool(): { id: string; isProviderExecuted: true; type: 'provider' } {
    return { id: 'anthropic.web_search_20250305', isProviderExecuted: true, type: 'provider' };
  }

  it('applyToolGuards leaves a no-execute provider tool unchanged (no execute added)', () => {
    const tools: ToolsInput = {
      [SANITIZED_ID]: providerDefinedTool() as unknown as ToolsInput[string],
    };
    const guarded = applyToolGuards(tools, { timeoutMs: 60_000 });
    expect(guarded[SANITIZED_ID]).toBe(tools[SANITIZED_ID]);
    expect(hasExecute(guarded[SANITIZED_ID])).toBe(false);
  });

  it('permission gate keeps it unchanged on read:allow (no requireApproval clone)', () => {
    const snapshot: PermissionToolGateSnapshot = {
      defaultRisk: 'mcp',
      policies: DEFAULT_PERMISSION_POLICIES,
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    };
    const tool = providerDefinedTool();
    const tools: ToolsInput = { [SANITIZED_ID]: tool as unknown as ToolsInput[string] };
    const toolNameMap = new Map<string, string>([[SANITIZED_ID, WEB_SEARCH_TOOL_ID]]);
    const result = filterToolsByPermissionWithMetadata(tools, snapshot, toolNameMap, {
      info: vi.fn(),
      warn: vi.fn(),
    });
    // read:allow → kept unchanged, not cloned, not in askToolIds.
    expect(result.tools[SANITIZED_ID]).toBe(tool);
    expect(result.askToolIds.has(SANITIZED_ID)).toBe(false);
    expect(
      (result.tools[SANITIZED_ID] as { requireApproval?: unknown }).requireApproval
    ).toBeUndefined();
  });
});

/**
 * `applyProviderNativeWebSearch` fed by the REAL `filterToolsByPermissionWithMetadata`
 * gate (not a hand-built `askTools`/`tools` map), so the ask/deny cells below prove
 * the two modules compose correctly end to end, not just that the selection helper
 * behaves given synthetic inputs (that's the "selection table" describe above).
 */
describe('applyProviderNativeWebSearch — driven by the real permission gate', () => {
  function makeSnapshot(decision: 'ask' | 'deny'): PermissionToolGateSnapshot {
    return {
      defaultRisk: 'mcp',
      perToolOverrides: { [WEB_SEARCH_TOOL_ID]: decision },
      policies: DEFAULT_PERMISSION_POLICIES,
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    };
  }

  it('non-native provider (openrouter) + real ask gate → Tavily selected, native never injected', () => {
    const tools: ToolsInput = {
      [SANITIZED_ID]: makeTavilyToolStub() as unknown as ToolsInput[string],
    };
    const toolNameMap = new Map<string, string>([[SANITIZED_ID, WEB_SEARCH_TOOL_ID]]);
    const gateResult = filterToolsByPermissionWithMetadata(
      tools,
      makeSnapshot('ask'),
      toolNameMap,
      { info: vi.fn(), warn: vi.fn() }
    );
    // Sanity: the REAL gate actually resolved this to `ask` (per-tool override),
    // not `allow` — otherwise the assertions below would pass vacuously.
    expect(gateResult.askToolIds.has(SANITIZED_ID)).toBe(true);

    const result = applyProviderNativeWebSearch({
      apiKey: undefined,
      askTools: gateResult.askTools,
      provider: 'openrouter',
      toolNameMap,
      tools: gateResult.tools,
    });

    const picked = result[SANITIZED_ID];
    expect(picked).toBeDefined();
    expect(toolId(picked)).toBe(WEB_SEARCH_TOOL_ID);
    expect(toolType(picked)).toBeUndefined();
    expect(hasExecute(picked)).toBe(true);
    expect((picked as { requireApproval?: unknown }).requireApproval).toBe(true);
  });

  it('native-capable provider (anthropic) + real deny gate → web search omitted, native never injected', () => {
    const tools: ToolsInput = {
      [SANITIZED_ID]: makeTavilyToolStub() as unknown as ToolsInput[string],
    };
    const toolNameMap = new Map<string, string>([[SANITIZED_ID, WEB_SEARCH_TOOL_ID]]);
    const gateResult = filterToolsByPermissionWithMetadata(
      tools,
      makeSnapshot('deny'),
      toolNameMap,
      { info: vi.fn(), warn: vi.fn() }
    );
    // Sanity: the REAL gate actually omitted it (deny), not merely absent by
    // some unrelated accident — and it never entered askToolIds either.
    expect(SANITIZED_ID in gateResult.tools).toBe(false);
    expect(gateResult.askToolIds.has(SANITIZED_ID)).toBe(false);

    const result = applyProviderNativeWebSearch({
      apiKey: 'sk-test',
      askTools: gateResult.askTools,
      provider: 'anthropic',
      toolNameMap,
      tools: gateResult.tools,
    });

    expect(result[SANITIZED_ID]).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });
});

/**
 * Runtime wiring proof: construct the REAL agent runtime (real sanitize + guard +
 * permission gate) with a Tavily-style web-search tool in the map and assert the
 * final Agent tool map carries the provider-native tool for anthropic and the
 * Tavily tool for a non-native provider. The provider API itself is NOT called
 * (that is the manual live-key gate) — only tool-map assembly is exercised.
 */
describe('createMastraAgentRuntime provider-native web search wiring', () => {
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
      model: 'test-model',
      requestContext,
      retryCount: 0,
      state: {},
      stepNumber,
      steps: [],
      systemMessages: [],
      tools: {},
    };
  }

  async function buildSearchableToolMap(provider: string): Promise<Record<string, unknown>> {
    const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'sk-test', provider },
      tools: {
        [WEB_SEARCH_TOOL_ID]: makeTavilyToolStub() as unknown as ToolsInput[string],
      },
    });
    try {
      const eagerTools = (await runtime.agent.listTools()) as Record<string, unknown>;
      if (eagerTools[SANITIZED_ID]) {
        expect(runtime.toolDiscovery?.coreToolIds).toContain(WEB_SEARCH_TOOL_ID);
        return eagerTools;
      }
      expect(runtime.toolDiscovery?.deferredToolIds).toContain(WEB_SEARCH_TOOL_ID);
      const processor = runtime.toolSearchProcessor;
      if (!processor) {
        throw new Error('Hosted runtime did not install its tool-search processor');
      }
      const threadId = `native-web-${provider}`;
      const first = await processor.processInputStep(createDiscoveryStepArgs(threadId, 0));
      await first.tools.search_tools.execute?.({ query: SANITIZED_ID });
      const second = await processor.processInputStep(createDiscoveryStepArgs(threadId, 1));
      return second.tools;
    } finally {
      await runtime.dispose();
    }
  }

  it('anthropic (read:allow default) → searchable catalog gets the provider-native web-search tool', async () => {
    const tools = await buildSearchableToolMap('anthropic');
    // sanitized key: `brainstrike.webSearch` → `brainstrike_webSearch`.
    const picked = tools[SANITIZED_ID];
    expect(picked).toBeDefined();
    expect(toolType(picked)).toBe('provider');
    expect(toolId(picked)).toBe('anthropic.web_search_20250305');
    expect(hasExecute(picked)).toBe(false);
  });

  it('openrouter (no native search) → searchable catalog keeps the execute-backed Tavily tool', async () => {
    const tools = await buildSearchableToolMap('openrouter');
    const picked = tools[SANITIZED_ID];
    expect(picked).toBeDefined();
    expect(hasExecute(picked)).toBe(true);
    expect(toolId(picked)).not.toBe('anthropic.web_search_20250305');
  });
});
