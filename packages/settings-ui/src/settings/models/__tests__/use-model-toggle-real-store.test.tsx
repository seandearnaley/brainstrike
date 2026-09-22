import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
let db: unknown = { query: vi.fn() };

vi.mock('@brainstrike/ui', () => ({ useToast: () => ({ toast }) }));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => db }));
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

// Boundary-fixture rule (BST-1795 final review): the mocked `use-model-toggle`
// suite stubs `toggleModel` directly with `mockRejectedValue`, a shape the
// real store never produces (it optimistically applies, then reverts via a
// scheduled `fetchRegistry`, then rethrows). This file drives the hook
// against the real `model-registry-store` so a failed write is verified
// against what the store actually does, not an assumed shape.
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { useModelToggle } from '../use-model-toggle';

describe('useModelToggle against the real model-registry-store', () => {
  beforeEach(() => {
    toast.mockClear();
    __resetModelRegistryStoreForTests();
    useModelRegistryStore.setState({
      models: [
        {
          bestFor: [],
          capabilities: { streaming: true, type: 'llm' },
          description: null,
          icon: null,
          id: 'claude-opus-5',
          isEnabled: false,
          name: 'Claude Opus 5',
          parameters: null,
          providerId: 'anthropic',
          sortOrder: 0,
          tagline: null,
        },
      ],
    });
    db = { query: vi.fn().mockRejectedValue(new Error('disk full')) };
  });

  afterEach(() => {
    __resetModelRegistryStoreForTests();
  });

  it('resolves false and fires a destructive toast when the store write rejects', async () => {
    const { result } = renderHook(() => useModelToggle());

    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.toggle('claude-opus-5', true);
    });

    expect(committed).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'disk full',
        title: 'Could not enable this model',
        variant: 'destructive',
      })
    );
    expect(result.current.busyModelIds.has('claude-opus-5')).toBe(false);
  });
});
