import {
  buildNativeToolRiskMap,
  DEFAULT_PERMISSION_POLICIES,
  type PermissionToolGateSnapshot,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import type { ToolsInput } from '@mastra/core/agent';
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
 * Runtime wiring proof: construct the REAL agent runtime (real sanitize + guard +
 * permission gate) with a Tavily-style web-search tool in the map and assert the
 * final Agent tool map carries the provider-native tool for anthropic and the
 * Tavily tool for a non-native provider. The provider API itself is NOT called
 * (that is the manual live-key gate) — only tool-map assembly is exercised.
 */
describe('createMastraAgentRuntime provider-native web search wiring', () => {
  async function buildAgentToolMap(provider: string): Promise<Record<string, unknown>> {
    const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'sk-test', provider },
      tools: {
        [WEB_SEARCH_TOOL_ID]: makeTavilyToolStub() as unknown as ToolsInput[string],
      },
    });
    const tools = (await runtime.agent.listTools()) as Record<string, unknown>;
    await runtime.dispose();
    return tools;
  }

  it('anthropic (read:allow default) → agent gets the provider-native web-search tool', async () => {
    const tools = await buildAgentToolMap('anthropic');
    // sanitized key: `brainstrike.webSearch` → `brainstrike_webSearch`.
    const picked = tools[SANITIZED_ID];
    expect(picked).toBeDefined();
    expect(toolType(picked)).toBe('provider');
    expect(toolId(picked)).toBe('anthropic.web_search_20250305');
    expect(hasExecute(picked)).toBe(false);
  });

  it('openrouter (no native search) → agent keeps the execute-backed Tavily tool', async () => {
    const tools = await buildAgentToolMap('openrouter');
    const picked = tools[SANITIZED_ID];
    expect(picked).toBeDefined();
    expect(hasExecute(picked)).toBe(true);
    expect(toolId(picked)).not.toBe('anthropic.web_search_20250305');
  });
});
