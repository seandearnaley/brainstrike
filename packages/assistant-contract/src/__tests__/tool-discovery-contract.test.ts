import { describe, expect, it } from 'vitest';
import {
  NATIVE_TOOL_DISCOVERY_NAMESPACES,
  NATIVE_TOOL_IDS,
  resolveToolDiscoveryAdapter,
  resolveToolDiscoveryPhaseAccess,
  TOOL_DISCOVERY_FAILURE_CODES,
  TOOL_DISCOVERY_PIPELINE_ORDER,
} from '../index';
import { NATIVE_TOOL_DEFAULTS } from '../tool-categories';

const EXPECTED_CRITICAL_TOOL_IDS = [
  'brainstrike.askUser',
  'brainstrike.executeCommand',
  'brainstrike.globWorkspace',
  'brainstrike.grepSearch',
  'brainstrike.readWorkspaceFile',
  'brainstrike.stringReplaceWorkspaceFile',
  'brainstrike.submitPlan',
  'brainstrike.writeWorkspaceFile',
] as const;

const EXPECTED_DEFERRED_NAMESPACES = {
  artifacts: ['brainstrike.readToolOutputArtifact'],
  context: [
    'brainstrike.listWorkspaceContext',
    'brainstrike.readWorkspaceContext',
    'brainstrike.readWorkspaceDirectory',
  ],
  database: ['brainstrike.queryDiagnostics'],
  embeddings: ['brainstrike.listEmbeddingSpaces', 'brainstrike.queryEmbeddingSpace'],
  execution: ['brainstrike.runPython'],
  semantics: [
    'brainstrike.findWorkspaceSymbol',
    'brainstrike.hybridSearch',
    'brainstrike.lspInspect',
  ],
  sessions: ['brainstrike.inspectCommandSessions', 'brainstrike.manageCommandSession'],
  skills: ['brainstrike.runSkillScript', 'skill', 'skill_read', 'skill_search'],
  web: [
    'brainstrike.browserGetPageText',
    'brainstrike.browserNavigate',
    'brainstrike.browserReadPage',
    'brainstrike.webExtract',
    'brainstrike.webSearch',
  ],
  workspace: [
    'brainstrike.deleteWorkspaceFile',
    'brainstrike.listWorktrees',
    'brainstrike.manageCanvas',
    'brainstrike.manageTaskList',
    'brainstrike.manageWorktree',
    'brainstrike.renameWorkspaceFile',
  ],
} as const;

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('native tool discovery contract', () => {
  it('keeps one exact minimal critical partition and defers every other native tool', () => {
    const critical = NATIVE_TOOL_IDS.filter(
      (toolId) => NATIVE_TOOL_DEFAULTS[toolId].loadingTier === 'critical'
    );
    const conditional = NATIVE_TOOL_IDS.filter(
      (toolId) => NATIVE_TOOL_DEFAULTS[toolId].loadingTier === 'conditional'
    );
    const deferred = NATIVE_TOOL_IDS.filter(
      (toolId) => NATIVE_TOOL_DEFAULTS[toolId].loadingTier === 'deferred'
    );

    expect(sorted(critical)).toEqual(sorted(EXPECTED_CRITICAL_TOOL_IDS));
    expect(conditional).toEqual([]);
    expect(sorted([...critical, ...deferred])).toEqual(sorted(NATIVE_TOOL_IDS));
  });

  it('publishes concise deferred namespaces with exact catalog reachability', () => {
    const actualNamespaces = Object.fromEntries(
      Object.entries(NATIVE_TOOL_DISCOVERY_NAMESPACES).map(([namespace, definition]) => [
        namespace,
        definition.toolIds,
      ])
    );
    expect(actualNamespaces).toEqual(EXPECTED_DEFERRED_NAMESPACES);

    const deferredIds = Object.values(NATIVE_TOOL_DISCOVERY_NAMESPACES).flatMap(
      ({ toolIds }) => toolIds
    );
    expect(new Set(deferredIds).size).toBe(deferredIds.length);
    expect(sorted(deferredIds)).toEqual(
      sorted(
        NATIVE_TOOL_IDS.filter((toolId) => NATIVE_TOOL_DEFAULTS[toolId].loadingTier === 'deferred')
      )
    );

    for (const definition of Object.values(NATIVE_TOOL_DISCOVERY_NAMESPACES)) {
      expect(definition.summary.length).toBeGreaterThan(0);
      expect(definition.toolIds.length).toBeLessThanOrEqual(9);
    }
  });

  it('keys provider-native discovery to declared model capability', () => {
    expect(resolveToolDiscoveryAdapter({ modelId: 'gpt-5.6-terra', provider: 'openai' })).toEqual({
      adapter: 'openai-native-search',
      status: 'supported',
    });
    expect(resolveToolDiscoveryAdapter({ modelId: 'gpt-5.4-mini', provider: 'openai' })).toEqual({
      adapter: 'openai-native-search',
      status: 'supported',
    });
    expect(resolveToolDiscoveryAdapter({ modelId: 'gpt-5.3-codex', provider: 'openai' })).toEqual({
      adapter: 'mastra-catalog-search',
      status: 'supported',
    });
    expect(
      resolveToolDiscoveryAdapter({ modelId: 'claude-sonnet-4-6', provider: 'anthropic' })
    ).toEqual({
      adapter: 'anthropic-native-search',
      status: 'supported',
    });
    expect(
      resolveToolDiscoveryAdapter({ modelId: 'gemini-3.5-flash', provider: 'google' })
    ).toEqual({
      adapter: 'mastra-catalog-search',
      status: 'supported',
    });
    expect(
      resolveToolDiscoveryAdapter({
        modelId: 'openai/gpt-5.6-terra',
        provider: 'openrouter',
      })
    ).toEqual({
      adapter: 'mastra-catalog-search',
      status: 'supported',
    });
  });

  it('does not silently substitute a requested unsupported adapter', () => {
    expect(
      resolveToolDiscoveryAdapter({
        modelId: 'externally-supplied-model',
        provider: 'openai',
        requestedAdapter: 'mastra-catalog-search',
      })
    ).toEqual({
      adapter: 'mastra-catalog-search',
      status: 'supported',
    });
    expect(
      resolveToolDiscoveryAdapter({
        modelId: 'gpt-5.6-terra',
        provider: 'openai',
        requestedAdapter: 'anthropic-native-search',
      })
    ).toEqual({
      adapter: 'unsupported',
      reason: 'model-lacks-requested-native-search',
      requestedAdapter: 'anthropic-native-search',
      status: 'unsupported',
    });
    expect(
      resolveToolDiscoveryAdapter({
        modelId: 'gpt-5.3-codex',
        provider: 'openai',
        requestedAdapter: 'openai-native-search',
      })
    ).toEqual({
      adapter: 'unsupported',
      reason: 'model-lacks-requested-native-search',
      requestedAdapter: 'openai-native-search',
      status: 'unsupported',
    });
    expect(
      resolveToolDiscoveryAdapter({
        modelId: 'unknown-model',
        provider: 'anthropic',
      })
    ).toEqual({
      adapter: 'unsupported',
      reason: 'unknown-model',
      status: 'unsupported',
    });
  });

  it('keeps discovery misses distinct from policy, host, and adapter failures', () => {
    expect(TOOL_DISCOVERY_FAILURE_CODES).toEqual([
      'catalog-miss',
      'host-unavailable',
      'permission-denied',
      'unsupported-adapter',
    ]);
  });

  it('refuses an embeddings-only provider rather than resolving a chat adapter', () => {
    // The built-in on-device provider declares `capabilities.llm: false`, so
    // discovery names that as the reason instead of handing back an adapter
    // nothing can run.
    expect(resolveToolDiscoveryAdapter({ modelId: 'any-model', provider: 'local' })).toEqual({
      adapter: 'unsupported',
      reason: 'provider-has-no-llm',
      status: 'unsupported',
    });
    expect(resolveToolDiscoveryAdapter({ modelId: 'dynamic-model', provider: 'ollama' })).toEqual({
      adapter: 'unsupported',
      reason: 'dynamic-model-capability-unknown',
      status: 'unsupported',
    });
  });

  it('treats enabled as eligible, never as automatically active', () => {
    expect(
      resolveToolDiscoveryPhaseAccess({
        available: true,
        enabled: true,
        loaded: false,
        permission: 'allow',
      })
    ).toEqual({
      active: false,
      loadable: true,
      searchable: true,
      status: 'eligible',
    });
    expect(
      resolveToolDiscoveryPhaseAccess({
        available: true,
        enabled: true,
        loaded: true,
        permission: 'ask',
      })
    ).toEqual({
      active: true,
      loadable: true,
      searchable: true,
      status: 'eligible',
    });
  });

  it.each([
    {
      input: { available: true, enabled: true, loaded: true, permission: 'deny' as const },
      status: 'permission-denied',
    },
    {
      input: { available: false, enabled: true, loaded: true, permission: 'allow' as const },
      status: 'host-unavailable',
    },
    {
      input: { available: true, enabled: false, loaded: true, permission: 'allow' as const },
      status: 'disabled',
    },
  ])('keeps $status tools out of search, load, and active phases', ({ input, status }) => {
    expect(resolveToolDiscoveryPhaseAccess(input)).toEqual({
      active: false,
      loadable: false,
      searchable: false,
      status,
    });
  });

  it('pins the future discovery pipeline order without changing runtime wiring', () => {
    expect(TOOL_DISCOVERY_PIPELINE_ORDER).toEqual([
      'capability-and-permission-eligibility',
      'guards-and-lifecycle-hooks',
      'plan-permission-and-suspend-gates',
      'provider-native-web-search',
      'tool-output-settlement-and-projection',
      'skills-metadata-injection',
      'tool-discovery',
      'projection-safe-tool-history-filter',
      'provider-history-compatibility',
      'projection-aware-token-limiter',
    ]);
  });
});
