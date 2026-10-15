import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptItemRepository } from '../src/repositories/prompt-item-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const vector = (hotIndex: number): number[] =>
  Array.from({ length: 384 }, (_, index) => (index === hotIndex ? 1 : 0));

describe('PromptItemRepository', () => {
  let db: PGlite;
  let repository: PromptItemRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    repository = new PromptItemRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('captures an untitled text clip as a durable fragment with a derived title', async () => {
    const created = await repository.create({
      content: '  Capture exact evidence before drawing conclusions.\nKeep the source nearby.  ',
      id: 'fragment-1',
    });

    expect(created).toMatchObject({
      content: '  Capture exact evidence before drawing conclusions.\nKeep the source nearby.  ',
      embeddingStatus: 'pending',
      id: 'fragment-1',
      kind: 'fragment',
      revision: 1,
      tags: [],
      title: 'Capture exact evidence before drawing conclusions.',
      useCount: 0,
    });
    expect(await repository.list()).toEqual([created]);
  });

  it('versions edits atomically and refuses stale writers', async () => {
    const created = await repository.create({
      content: 'Ask for concrete evidence.',
      id: 'prompt-1',
      kind: 'prompt',
      tags: ['Research', 'evidence', 'research'],
      title: 'Evidence pass',
    });
    await repository.storeEmbedding({
      embedding: vector(0),
      itemId: created.id,
      revision: created.revision,
    });

    const updated = await repository.update({
      content: 'Ask for concrete evidence and cite the source.',
      description: 'A rigorous research pass',
      expectedRevision: 1,
      id: created.id,
      isFavorite: true,
      kind: 'prompt',
      modelKey: 'openai::gpt-5.4',
      modelSettings: { maxOutputTokens: 1200, reasoningEffort: 'high' },
      note: 'Tighten evidence requirements',
      tags: ['Research', 'Evidence'],
      title: 'Evidence pass',
    });

    expect(updated).toMatchObject({
      embeddingStatus: 'pending',
      isFavorite: true,
      revision: 2,
      tags: ['research', 'evidence'],
    });
    const revisions = await repository.listRevisions(created.id);
    expect(revisions).toEqual([
      expect.objectContaining({
        content: 'Ask for concrete evidence.',
        description: null,
        modelKey: null,
        modelSettings: null,
        note: 'Tighten evidence requirements',
        revision: 1,
        tags: ['research', 'evidence'],
        title: 'Evidence pass',
      }),
    ]);

    await expect(
      repository.update({
        content: 'Stale overwrite',
        expectedRevision: 1,
        id: created.id,
        isFavorite: false,
        kind: 'prompt',
        tags: [],
        title: 'Stale overwrite',
      })
    ).rejects.toThrow(/changed since it was opened/i);

    // A refused CAS write is fully atomic: no orphaned revision row, no item mutation.
    await expect(repository.listRevisions(created.id)).resolves.toEqual(revisions);
    await expect(repository.findById(created.id)).resolves.toMatchObject({
      content: 'Ask for concrete evidence and cite the source.',
      modelKey: 'openai::gpt-5.4',
      modelSettings: { maxOutputTokens: 1200, reasoningEffort: 'high' },
      revision: 2,
    });
  });

  it('stores only current-revision vectors and ranks same-space semantic matches', async () => {
    const first = await repository.create({
      content: 'Require file and line evidence.',
      id: 'snippet-evidence',
      kind: 'snippet',
      title: 'Evidence citation',
    });
    const second = await repository.create({
      content: 'Return a compact executive summary.',
      id: 'snippet-summary',
      kind: 'snippet',
      title: 'Executive summary',
    });
    await repository.storeEmbedding({
      embedding: vector(0),
      itemId: first.id,
      revision: first.revision,
    });
    await repository.storeEmbedding({
      embedding: vector(1),
      itemId: second.id,
      revision: second.revision,
    });

    const matches = await repository.searchSimilar(vector(0), {
      kinds: ['snippet'],
      limit: 2,
      threshold: -1,
    });
    expect(matches.map((match) => match.id)).toEqual(['snippet-evidence', 'snippet-summary']);
    expect(matches[0]?.similarity).toBeCloseTo(1, 5);

    const edited = await repository.update({
      content: 'Require exact source evidence.',
      expectedRevision: first.revision,
      id: first.id,
      isFavorite: false,
      kind: first.kind,
      tags: first.tags,
      title: first.title,
    });
    expect(
      await repository.storeEmbedding({
        embedding: vector(0),
        itemId: first.id,
        revision: first.revision,
      })
    ).toBe(false);
    expect(edited.embeddingStatus).toBe('pending');

    await expect(
      repository.storeEmbedding({
        embedding: [1, 0],
        itemId: second.id,
        revision: second.revision,
      })
    ).rejects.toThrow(/expected 384/i);
  });

  it.each(['l2', 'ip'] as const)(
    'fails closed when similarity search is configured with a %s profile',
    async (distance) => {
      await db.query(
        `UPDATE prompt_embedding_profiles
       SET distance = $1
       WHERE id = 'default'`,
        [distance]
      );

      await expect(repository.searchSimilar(vector(0))).rejects.toThrow(
        new RegExp(`prompt similarity search only supports cosine distance.*${distance}`, 'i')
      );
    }
  );

  it('treats LIKE metacharacters in text filters as literals', async () => {
    await Promise.all([
      repository.create({
        content: 'A plain control item.',
        id: 'plain-item',
        title: 'Plain item',
      }),
      repository.create({
        content: 'Preserve a literal percent marker.',
        id: 'percent-item',
        title: 'Budget is 50% complete',
      }),
      repository.create({
        content: 'Preserve a literal underscore marker.',
        id: 'underscore-item',
        title: 'snake_case token',
      }),
      repository.create({
        content: 'Preserve a literal backslash marker.',
        id: 'backslash-item',
        title: String.raw`C:\prompt-library`,
      }),
    ]);

    await expect(repository.list({ search: '%' })).resolves.toMatchObject([{ id: 'percent-item' }]);
    await expect(repository.list({ search: '_' })).resolves.toMatchObject([
      { id: 'underscore-item' },
    ]);
    await expect(repository.list({ search: '\\' })).resolves.toMatchObject([
      { id: 'backslash-item' },
    ]);
  });

  it('records successful agent usage and fails explicitly for missing items', async () => {
    await repository.create({
      content: 'Use a compact response.',
      id: 'snippet-usage',
      kind: 'snippet',
      title: 'Compact response',
    });

    const used = await repository.recordUsage('snippet-usage', 'insert');
    expect(used).toMatchObject({ lastUsedAction: 'insert', useCount: 1 });

    await expect(repository.recordUsage('missing', 'compose')).rejects.toThrow(
      /prompt item "missing" was not found/i
    );
    await expect(repository.delete('missing')).rejects.toThrow(
      /prompt item "missing" was not found/i
    );
  });

  it('delete emits a prompt_item tombstone op in the same statement (BST-993)', async () => {
    await repository.create({ content: 'Tombstone me.', id: 'fragment-tombstone' });

    await repository.delete('fragment-tombstone');

    const ops = await db.query<{ entity_kind: string; op: string }>(
      `SELECT entity_kind, op FROM brainstrike_mind_ops WHERE entity_id = 'fragment-tombstone'`
    );
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({ entity_kind: 'prompt_item', op: 'delete' });

    // The not-found path emits nothing: a tombstone records an actual delete.
    await expect(repository.delete('fragment-tombstone')).rejects.toThrow(/was not found/i);
    const opsAfter = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM brainstrike_mind_ops
       WHERE entity_id = 'fragment-tombstone'`
    );
    expect(opsAfter.rows[0]?.count).toBe('1');
  });
});
