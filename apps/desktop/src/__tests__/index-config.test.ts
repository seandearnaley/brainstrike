// @vitest-environment node
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import type { CollectionRecord, CollectionRequest } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopIndexConfig, type DesktopIndexConfigDependencies } from '../index-config';

const MODEL = {
  dimensions: 384,
  local: { device: 'wasm', dtype: 'q8' },
  modelKey: 'transformers::Xenova/bge-small-en-v1.5',
} as const;
const OTHER = {
  dimensions: 1536,
  local: null,
  modelKey: 'openai::text-embedding-3-small',
} as const;

function harness(saved: IndexConfig | null, spaces: CollectionRecord[] = []) {
  let config = saved;
  const rows = [...spaces];
  const dependencies = {
    assertModel: vi.fn(),
    catalog: {
      collections: vi.fn(async (request: CollectionRequest) => {
        if (request.operation === 'create') {
          const existing = rows.find((row) => row.systemRole === 'workspace-index');
          if (existing) {
            return { collections: [existing] };
          }
          rows.push(request.collection);
          return { collections: [request.collection] };
        }
        return { collections: rows };
      }),
      indexConfig: vi.fn(async (request) => {
        if (request.operation === 'write') {
          config = request.config;
        }
        return { config };
      }),
    },
    publish: vi.fn(),
    rebuild: vi.fn(async () => {}),
    reconfigure: vi.fn(async () => {}),
    replaceVectorSpace: vi.fn(async () => {}),
  } satisfies DesktopIndexConfigDependencies;
  return { dependencies, owner: createDesktopIndexConfig(dependencies), saved: () => config };
}

const space = (model: { modelKey: string; dimensions: number }): CollectionRecord => ({
  createdAt: '2026-10-23T00:00:00.000Z',
  dimensions: model.dimensions,
  distance: 'cosine',
  id: 'space-old',
  modelId: model.modelKey.slice(model.modelKey.indexOf('::') + 2),
  modelKey: model.modelKey,
  systemRole: 'workspace-index',
});

describe('Main search index config', () => {
  it('reads a fresh profile as text search', async () => {
    expect(await harness(null).owner.read()).toEqual(DEFAULT_INDEX_CONFIG);
  });

  it('applies a pause in place and tells every window', async () => {
    const { dependencies, owner, saved } = harness(null);
    await owner.update({ paused: true });
    expect(saved()).toMatchObject({ paused: true });
    expect(dependencies.publish).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
    expect(dependencies.reconfigure).toHaveBeenCalledOnce();
    expect(dependencies.rebuild).not.toHaveBeenCalled();
  });

  it('rebuilds once when the chunking changes', async () => {
    const { dependencies, owner } = harness(null);
    await owner.update({ chunking: { _tag: 'Custom', maxTokens: 768, overlap: 64 } });
    expect(dependencies.rebuild).toHaveBeenCalledOnce();
    expect(dependencies.reconfigure).not.toHaveBeenCalled();
  });

  it('replaces the old vector space when the model changes', async () => {
    const { dependencies, owner } = harness(
      { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL },
      [space(MODEL)]
    );
    await owner.update({ model: OTHER });
    expect(dependencies.replaceVectorSpace).toHaveBeenCalledWith('space-old');
    expect(dependencies.rebuild).not.toHaveBeenCalled();
  });

  it('merges one worktree toggle into the saved map', async () => {
    const { owner, saved } = harness({ ...DEFAULT_INDEX_CONFIG, worktrees: { a: true } });
    await owner.update({ worktrees: { b: true } });
    expect(saved()?.worktrees).toEqual({ a: true, b: true });
  });

  it('saves nothing when a change is refused', async () => {
    const { dependencies, owner } = harness(null);
    await expect(owner.update({ mode: 'semantic' })).rejects.toMatchObject({
      _tag: 'IndexConfigRefused',
    });
    await expect(owner.update({ collection: 'x' })).rejects.toMatchObject({
      _tag: 'IndexConfigRefused',
    });
    expect(dependencies.catalog.indexConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'write' })
    );
  });

  it('runs semantic search in the vector space it ensures for the saved model', async () => {
    const { owner } = harness({ ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL });
    expect(await owner.nativeSettings()).toMatchObject({ mode: 'VECTOR' });
  });

  it('refuses to run while the vector space still holds the previous model', async () => {
    const { owner } = harness({ ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: OTHER }, [
      space(MODEL),
    ]);
    await expect(owner.nativeSettings()).rejects.toMatchObject({
      _tag: 'IndexConfigApplyFailed',
    });
  });
});
