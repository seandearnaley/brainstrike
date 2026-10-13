import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

test('prompt catalog retains canonical identity, revisions and usage with stale edit rejection across reopen', async () => {
  const root = freshDir('prompt-owner');
  let store = await StateStore.open(root);
  try {
    const created = await store.promptCatalog({
      input: {
        content: 'Review {{path}} carefully.',
        id: 'prompt-item-canonical',
        kind: 'prompt',
        modelKey: 'openai::gpt-5.2',
        modelSettings: { temperature: 0.2 },
        rating: 4,
        tags: [' Review ', 'review'],
        title: 'Review changes',
      },
      operation: 'create',
    });
    const first = created.items[0];
    expect(first).toMatchObject({
      id: 'prompt-item-canonical',
      rating: 4,
      revision: 1,
      tags: ['review'],
      useCount: 0,
    });
    if (!first) {
      throw new Error('Prompt catalog omitted committed item');
    }
    const edit = {
      content: 'Review {{path}} and report risk.',
      expectedRevision: 1,
      id: first.id,
      isFavorite: true,
      kind: first.kind,
      modelKey: first.modelKey,
      modelSettings: first.modelSettings,
      rating: 4,
      tags: first.tags,
      title: 'Review safely',
    };
    const changed = await store.promptCatalog({ input: edit, operation: 'update' });
    expect(changed.items[0]).toMatchObject({
      content: edit.content,
      id: first.id,
      isFavorite: true,
      revision: 2,
    });
    await expect(store.promptCatalog({ input: edit, operation: 'update' })).rejects.toThrow();
    const revisions = await store.promptCatalog({ id: first.id, operation: 'revisions' });
    expect(revisions.revisions).toHaveLength(1);
    expect(revisions.revisions[0]).toMatchObject({
      content: first.content,
      promptItemId: first.id,
      revision: 1,
    });
    const used = await store.promptCatalog({
      action: 'new-thread',
      id: first.id,
      operation: 'usage',
    });
    expect(used.items[0]).toMatchObject({ lastUsedAction: 'new-thread', useCount: 1 });
    await store.close();
    store = await StateStore.open(root);
    expect(await store.promptCatalog({ id: first.id, operation: 'get' })).toEqual(used);
    await store.promptCatalog({ id: first.id, operation: 'delete' });
    expect(
      (await store.promptCatalog({ filter: { includeArchived: true }, operation: 'list' })).items
    ).toEqual([]);
    expect((await store.promptCatalog({ id: first.id, operation: 'revisions' })).revisions).toEqual(
      []
    );
  } finally {
    await store.close();
  }
});
