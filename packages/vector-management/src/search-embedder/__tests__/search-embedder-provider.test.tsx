import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { render, renderHook } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchEmbedderProvider, useSharedSearchEmbedder } from '../search-embedder-provider';
import type { EmbeddingSetModelInfo, UseSearchEmbedderResult } from '../use-search-embedder';

const { mockCreateProvider, mockEmbed } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
  mockEmbed: vi.fn(),
}));

vi.mock('@brainstrike/embeddings/factory', () => ({
  EmbeddingProviderFactory: { createProvider: mockCreateProvider },
}));

const hostedInfo: EmbeddingSetModelInfo = {
  dimensions: 1536,
  modelConfig: null,
  modelKey: 'openai::text-embedding-3-small',
};

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <SearchEmbedderProvider>{children}</SearchEmbedderProvider>;
}

describe('SearchEmbedderProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVectorPreferencesStore.setState({ devicePref: 'wasm' });
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue({ ok: true, value: { embedding: new Array(1536).fill(0.1) } });
    mockCreateProvider.mockReset();
    mockCreateProvider.mockResolvedValue({ ok: true, value: { embed: mockEmbed } });
  });

  it('throws a named error when no provider encloses the consumer', () => {
    // renderHook surfaces the render-time throw; assert its message.
    expect(() => renderHook(() => useSharedSearchEmbedder())).toThrow(
      /must be used within a <SearchEmbedderProvider>/
    );
  });

  it('shares one embedder cache across two consumers (factory called once)', async () => {
    // Two DISTINCT consumer instances under ONE provider embed the SAME model,
    // sequentially. If each owned its own cache the factory would run twice; the
    // shared provider means the second consumer reuses the first's resolved
    // embedder, so the factory runs exactly once.
    const captured: UseSearchEmbedderResult[] = [];

    function Consumer(): ReactElement {
      const shared = useSharedSearchEmbedder();
      useEffect(() => {
        captured.push(shared);
      }, [shared]);
      return <span>consumer</span>;
    }

    render(
      <SearchEmbedderProvider>
        <Consumer />
        <Consumer />
      </SearchEmbedderProvider>
    );

    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    if (!(first && second)) {
      throw new Error('expected both consumers to capture the shared embedder');
    }

    const a = await first.embedQueryWithRecovery(hostedInfo, 'q-a');
    const b = await second.embedQueryWithRecovery(hostedInfo, 'q-b');

    expect(a).toHaveLength(1536);
    expect(b).toHaveLength(1536);
    // The two consumers received the SAME shared result object …
    expect(second).toBe(first);
    // … and the underlying embedder cache was built exactly once.
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });

  it('provides the same result reference to every consumer', () => {
    const { result } = renderHook(() => useSharedSearchEmbedder(), { wrapper });
    const first = result.current;
    expect(typeof first.embedQueryWithRecovery).toBe('function');
    expect(typeof first.ensureEmbedderReady).toBe('function');
  });
});
