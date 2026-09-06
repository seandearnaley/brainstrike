import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import {
  listProviders,
  type ProviderDefinition,
} from '@brainstrike/assistant-contract/provider-metadata';
import { describe, expect, it } from 'vitest';
import {
  buildProviderRuntimeGroups,
  listRecommendedProviders,
  PROVIDER_RUNTIME_ORDER,
  resolveProviderConnection,
} from '../provider-connection';

function storedSource(provider: string): ProviderKeySource<string> {
  return { provider, source: 'stored' };
}

function envSource(provider: string, envVar: string): ProviderKeySource<string> {
  return { envVar, provider, source: 'env' };
}

function sourcesOf(
  ...entries: ProviderKeySource<string>[]
): ReadonlyMap<string, ProviderKeySource<string>> {
  return new Map(entries.map((entry) => [entry.provider, entry]));
}

const NO_SOURCES: ReadonlyMap<string, ProviderKeySource<string>> = new Map();

describe('resolveProviderConnection', () => {
  it('reports a keyless runtime provider as not-applicable, never as disconnected', () => {
    // ollama/lmstudio/local need NO credential — calling them "disconnected"
    // would invent a problem the user cannot fix on this surface.
    expect(
      resolveProviderConnection({ authType: 'none', source: undefined, sourceState: 'ready' })
    ).toBe('not-applicable');
  });

  it('reports a keyed provider with any source as connected', () => {
    expect(
      resolveProviderConnection({
        authType: 'api_key',
        source: storedSource('openai'),
        sourceState: 'ready',
      })
    ).toBe('connected');
    expect(
      resolveProviderConnection({
        authType: 'api_key',
        source: envSource('openai', 'OPENAI_API_KEY'),
        sourceState: 'ready',
      })
    ).toBe('connected');
  });

  it('reports a keyed provider with no source as disconnected once the listing is ready', () => {
    expect(
      resolveProviderConnection({ authType: 'api_key', source: undefined, sourceState: 'ready' })
    ).toBe('disconnected');
  });

  it('derives an oauth_subscription provider from its sign-in state, not the key listing', () => {
    // BST-1356: subscription tokens live in the desktop OAuth engine and never
    // appear in the `secrets.list()` payload. Reading the key listing for one
    // would report a signed-in ChatGPT account as "Not connected" forever.
    const oauth = {
      authType: 'oauth_subscription',
      source: undefined,
      sourceState: 'ready',
    } as const;

    expect(resolveProviderConnection({ ...oauth, authState: 'connected' })).toBe('connected');
    expect(resolveProviderConnection({ ...oauth, authState: 'disconnected' })).toBe('disconnected');
    // An expired session is NOT plain disconnected: the user has an account,
    // it just needs re-authorising, and the card must say so.
    expect(resolveProviderConnection({ ...oauth, authState: 'reconnect_required' })).toBe(
      'reconnect-required'
    );
    // Mid-flow states are not yet a verdict.
    expect(resolveProviderConnection({ ...oauth, authState: 'awaiting_browser' })).toBe('unknown');
    // No bridge (web) means no verdict is obtainable.
    expect(resolveProviderConnection({ ...oauth, authState: undefined })).toBe('unknown');
  });

  it('reports unknown when the credential listing itself is unavailable', () => {
    // Web has no secrets bridge and no status payload: "we cannot read this"
    // must never render as "you have not set this".
    expect(
      resolveProviderConnection({
        authType: 'api_key',
        source: undefined,
        sourceState: 'unavailable',
      })
    ).toBe('unknown');
  });

  it('reports unknown — never disconnected — while the listing is loading or failed', () => {
    // NO SILENT FALLBACKS: a failed listing cannot support the claim
    // "you have not set this key".
    expect(
      resolveProviderConnection({ authType: 'api_key', source: undefined, sourceState: 'loading' })
    ).toBe('unknown');
    expect(
      resolveProviderConnection({ authType: 'aws', source: undefined, sourceState: 'error' })
    ).toBe('unknown');
  });
});

describe('buildProviderRuntimeGroups', () => {
  it('groups by runtime in picker order and drops empty groups', () => {
    const groups = buildProviderRuntimeGroups({
      definitions: listProviders(),
      sourceState: 'ready',
      sourcesBySlotId: NO_SOURCES,
    });

    expect(groups.map((group) => group.runtime)).toEqual(['hosted', 'gateway', 'local', 'browser']);
    expect(groups.map((group) => group.label)).toEqual(['Hosted', 'Gateway', 'Local', 'Browser']);
    expect(PROVIDER_RUNTIME_ORDER).toEqual(['hosted', 'gateway', 'local', 'browser']);
  });

  it('sorts connected providers first, then registry order within a runtime group', () => {
    // Registry order is openai, anthropic, google, …, so surfacing google
    // first proves the connected-first rule beat the registry order.
    const groups = buildProviderRuntimeGroups({
      definitions: listProviders(),
      sourceState: 'ready',
      sourcesBySlotId: sourcesOf(storedSource('google')),
    });

    const hosted = groups.find((group) => group.runtime === 'hosted');
    expect(hosted?.providers.map((card) => card.definition.id).slice(0, 3)).toEqual([
      'google',
      'openai',
      'anthropic',
    ]);
    expect(hosted?.providers[0]?.connection).toBe('connected');
    expect(hosted?.providers[0]?.source).toEqual(storedSource('google'));
  });

  it('keeps registry order among equally-connected providers (stable sort)', () => {
    const groups = buildProviderRuntimeGroups({
      definitions: listProviders(),
      sourceState: 'ready',
      sourcesBySlotId: sourcesOf(storedSource('openai'), storedSource('anthropic')),
    });

    const hosted = groups.find((group) => group.runtime === 'hosted');
    expect(hosted?.providers.map((card) => card.definition.id).slice(0, 2)).toEqual([
      'openai',
      'anthropic',
    ]);
  });

  it('carries every registry provider exactly once across all groups', () => {
    const groups = buildProviderRuntimeGroups({
      definitions: listProviders(),
      sourceState: 'ready',
      sourcesBySlotId: NO_SOURCES,
    });

    const ids = groups.flatMap((group) => group.providers.map((card) => card.definition.id));
    expect([...ids].sort()).toEqual([...listProviders().map((entry) => entry.id)].sort());
  });
});

describe('listRecommendedProviders', () => {
  it('recommends the first three unconnected credentialed providers in registry order', () => {
    const groups = buildProviderRuntimeGroups({
      definitions: listProviders(),
      sourceState: 'ready',
      sourcesBySlotId: NO_SOURCES,
    });

    expect(listRecommendedProviders(groups).map((card) => card.definition.id)).toEqual([
      'openai',
      'anthropic',
      'google',
    ]);
  });

  it('never recommends a subscription provider — the panel offers "add a key"', () => {
    // An oauth provider is connected by signing in, not by pasting a key, so
    // listing it under "Add a key for any provider below" misdescribes it.
    const oauthDefinition: ProviderDefinition = {
      authType: 'oauth_subscription',
      capabilities: { embeddings: false, llm: true, streaming: true },
      displayName: 'Subscription Provider',
      id: 'openai' as ProviderDefinition['id'],
      models: [],
      runtime: 'hosted',
    };
    const groups = buildProviderRuntimeGroups({
      definitions: [oauthDefinition],
      sourceState: 'ready',
      sourcesBySlotId: NO_SOURCES,
    });

    expect(listRecommendedProviders(groups)).toEqual([]);
  });

  it('never recommends a keyless provider — there is nothing to connect', () => {
    const groups = buildProviderRuntimeGroups({
      definitions: listProviders(),
      sourceState: 'ready',
      sourcesBySlotId: NO_SOURCES,
    });

    const recommendedIds = listRecommendedProviders(groups).map((card) => card.definition.id);
    expect(recommendedIds).not.toContain('ollama');
    expect(recommendedIds).not.toContain('local');
  });

  it('skips providers that are already connected', () => {
    const groups = buildProviderRuntimeGroups({
      definitions: listProviders(),
      sourceState: 'ready',
      sourcesBySlotId: sourcesOf(storedSource('openai'), storedSource('anthropic')),
    });

    expect(listRecommendedProviders(groups).map((card) => card.definition.id)).toEqual([
      'google',
      'openrouter',
      'cohere',
    ]);
  });
});
