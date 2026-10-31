// @vitest-environment node
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  DEFAULT_INDEX_CONFIG,
  INDEX_CONFIG_RESET_REMEDY,
  INDEX_CONFIG_UNREADABLE,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import type { CollectionRecord, CollectionRequest } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import {
  assertRegisteredEmbeddingModel,
  createDesktopIndexConfig,
  type DesktopIndexConfigDependencies,
} from '../index-config';

const MODEL = { dimensions: 1536, modelKey: 'openai::text-embedding-3-small' } as const;
const OTHER = { dimensions: 3072, modelKey: 'openai::text-embedding-3-large' } as const;

function harness(saved: IndexConfig | null, spaces: CollectionRecord[] = []) {
  let config = saved;
  const rows = [...spaces];
  const dependencies = {
    assertModel: assertRegisteredEmbeddingModel,
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
        await Promise.resolve();
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

  it('resets a saved config it cannot read to the defaults and rebuilds the index', async () => {
    const { dependencies, owner, saved } = harness({ ...DEFAULT_INDEX_CONFIG, paused: true });
    const unreadable = refusalError(
      'configuration',
      INDEX_CONFIG_UNREADABLE,
      'The saved search index settings are from another version and cannot be read.',
      INDEX_CONFIG_RESET_REMEDY
    );
    const serve = dependencies.catalog.indexConfig.getMockImplementation();
    dependencies.catalog.indexConfig.mockImplementation(async (request) => {
      if (request.operation === 'read' || !serve) {
        throw unreadable;
      }
      return await serve(request);
    });
    await expect(owner.read()).rejects.toMatchObject({ cause: unreadable });
    expect(await owner.reset()).toEqual(DEFAULT_INDEX_CONFIG);
    expect(saved()).toEqual(DEFAULT_INDEX_CONFIG);
    expect(dependencies.publish).toHaveBeenCalledExactlyOnceWith(DEFAULT_INDEX_CONFIG);
    expect(dependencies.rebuild).toHaveBeenCalledOnce();
    expect(dependencies.reconfigure).not.toHaveBeenCalled();
  });

  it('rebuilds once when the chunking changes', async () => {
    const { dependencies, owner } = harness(null);
    await owner.update({ chunking: { _tag: 'Custom', maxTokens: 768, overlap: 64 } });
    expect(dependencies.rebuild).toHaveBeenCalledOnce();
    expect(dependencies.reconfigure).not.toHaveBeenCalled();
  });

  it('refuses a chunking change while search is off and saves nothing', async () => {
    const off = { ...DEFAULT_INDEX_CONFIG, mode: 'off' } as const;
    const { dependencies, owner, saved } = harness(off);
    await expect(
      owner.update({ chunking: { _tag: 'Custom', maxTokens: 768, overlap: 64 } })
    ).rejects.toMatchObject({
      _tag: 'IndexConfigRefused',
      message: 'Turn search on before changing chunking.',
    });
    expect(saved()).toEqual(off);
    expect(dependencies.publish).not.toHaveBeenCalled();
    expect(dependencies.rebuild).not.toHaveBeenCalled();
  });

  it('rebuilds when search turns on with new chunking in one change', async () => {
    const chunking = { _tag: 'Custom', maxTokens: 768, overlap: 64 } as const;
    const { dependencies, owner, saved } = harness({ ...DEFAULT_INDEX_CONFIG, mode: 'off' });
    await owner.update({ chunking, mode: 'text' });
    expect(saved()).toMatchObject({ chunking, mode: 'text' });
    expect(dependencies.rebuild).toHaveBeenCalledOnce();
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

  it('replaces the vector space once when the model and chunking change together', async () => {
    const chunking = { _tag: 'Custom', maxTokens: 256, overlap: 32 } as const;
    const { dependencies, owner, saved } = harness(
      { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL },
      [space(MODEL)]
    );
    await owner.update({ chunking, model: OTHER });
    expect(saved()).toMatchObject({ chunking, model: OTHER });
    // The new vector space starts empty, so its first scan chunks every file with the new sizes.
    expect(dependencies.replaceVectorSpace).toHaveBeenCalledOnce();
    expect(dependencies.replaceVectorSpace).toHaveBeenCalledWith('space-old');
    expect(dependencies.rebuild).not.toHaveBeenCalled();
  });

  it('merges one worktree toggle into the saved map', async () => {
    const { owner, saved } = harness({ ...DEFAULT_INDEX_CONFIG, worktrees: { a: true } });
    await owner.update({ worktrees: { b: true } });
    expect(saved()?.worktrees).toEqual({ a: true, b: true });
  });

  it('keeps both of two quick worktree toggles', async () => {
    const { owner, saved } = harness({ ...DEFAULT_INDEX_CONFIG, worktrees: { a: true } });
    const first = owner.update({ worktrees: { b: true } });
    const second = owner.update({ worktrees: { c: true } });
    await Promise.all([first, second]);
    expect(saved()?.worktrees).toEqual({ a: true, b: true, c: true });
  });

  it('finishes a model change while a factory reset publishes the saved config', async () => {
    const { dependencies, owner } = harness(
      { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL },
      [space(MODEL)]
    );
    const replacing = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    // The reset holds the transition queue, so the replacement runs only after its publish.
    dependencies.replaceVectorSpace.mockImplementationOnce(async () => {
      replacing.resolve();
      await published.promise;
    });
    const change = owner.update({ model: OTHER });
    await replacing.promise;
    const publish = owner.publishSaved().finally(() => published.resolve());
    await expect(Promise.all([change, publish])).resolves.toMatchObject([
      { model: OTHER },
      { model: OTHER },
    ]);
  });

  it('applies a save made during a model change after the replacement', async () => {
    const { dependencies, owner, saved } = harness(
      { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL },
      [space(MODEL)]
    );
    // The native owner's FIFO: each apply runs after the one queued before it.
    const applied: string[] = [];
    let queue = Promise.resolve();
    const enqueue = (name: string, work: () => Promise<void>) => {
      const run = queue.then(work).then(() => {
        applied.push(name);
      });
      queue = run.catch(() => undefined);
      return run;
    };
    const replacing = Promise.withResolvers<void>();
    const replaced = Promise.withResolvers<void>();
    dependencies.replaceVectorSpace.mockImplementationOnce(() =>
      enqueue('model change', async () => {
        replacing.resolve();
        await replaced.promise;
      })
    );
    // The old space is still listed while it is removed, so the Pause's apply removes it again
    // (nothing left to remove) and reopens from the saved config.
    dependencies.replaceVectorSpace.mockImplementationOnce(() =>
      enqueue(`pause ${saved()?.paused}`, async () => {})
    );
    const change = owner.update({ model: OTHER });
    await replacing.promise;
    // A Pause saved meanwhile is saved at once; its apply waits behind the replacement.
    const pause = owner.update({ paused: true });
    await vi.waitFor(() => expect(saved()).toMatchObject({ model: OTHER, paused: true }));
    expect(applied).toEqual([]);
    replaced.resolve();
    await expect(Promise.all([change, pause])).resolves.toMatchObject([
      { model: OTHER },
      { model: OTHER, paused: true },
    ]);
    expect(applied).toEqual(['model change', 'pause true']);
  });

  it('shows a model change the index could not apply', async () => {
    const { dependencies, owner, saved } = harness(
      { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model: MODEL },
      [space(MODEL)]
    );
    dependencies.replaceVectorSpace.mockRejectedValueOnce(new Error('host stopped'));
    await expect(owner.update({ model: OTHER })).rejects.toMatchObject({
      _tag: 'IndexConfigApplyFailed',
      message: "The previous model's vectors could not be removed.",
    });
    expect(saved()).toMatchObject({ model: OTHER });
  });

  it('saves nothing when a change is refused', async () => {
    const { dependencies, owner } = harness(null);
    await expect(owner.update({ mode: 'semantic' })).rejects.toMatchObject({
      _tag: 'IndexConfigRefused',
    });
    expect(dependencies.catalog.indexConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'write' })
    );
  });

  it.each([
    {
      message: 'Search index model provider "acme" is not registered.',
      model: { ...MODEL, modelKey: 'acme::text-embedding-3-small' },
      name: 'a model from an unregistered provider',
    },
  ])('refuses $name and saves nothing', async ({ message, model }) => {
    const { dependencies, owner, saved } = harness(null);
    await expect(owner.update({ mode: 'semantic', model })).rejects.toMatchObject({
      _tag: 'IndexConfigRefused',
      message,
    });
    expect(saved()).toBeNull();
    expect(dependencies.publish).not.toHaveBeenCalled();
  });

  it('keeps and shows a saved change the index could not apply', async () => {
    const { dependencies, owner, saved } = harness(null);
    dependencies.reconfigure.mockRejectedValueOnce(new Error('host stopped'));
    await expect(owner.update({ paused: true })).rejects.toMatchObject({
      _tag: 'IndexConfigApplyFailed',
    });
    expect(saved()).toMatchObject({ paused: true });
    expect(dependencies.publish).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
    expect(await owner.read()).toMatchObject({ paused: true });
  });

  it('never shows defaults when the saved config cannot be read', async () => {
    const { dependencies, owner, saved } = harness({ ...DEFAULT_INDEX_CONFIG, paused: true });
    dependencies.catalog.indexConfig.mockRejectedValue(new Error('store closed'));
    await expect(owner.read()).rejects.toMatchObject({ _tag: 'IndexConfigStoreFailed' });
    await expect(owner.update({ policy: 'full-root' })).rejects.toMatchObject({
      _tag: 'IndexConfigStoreFailed',
    });
    expect(saved()).toMatchObject({ paused: true, policy: 'balanced' });
  });

  it('saves nothing when the vector space cannot be read', async () => {
    const { dependencies, owner, saved } = harness(null);
    dependencies.catalog.collections.mockRejectedValueOnce(new Error('store closed'));
    await expect(owner.update({ paused: true })).rejects.toMatchObject({
      _tag: 'IndexConfigStoreFailed',
    });
    expect(saved()).toBeNull();
    expect(dependencies.publish).not.toHaveBeenCalled();
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
