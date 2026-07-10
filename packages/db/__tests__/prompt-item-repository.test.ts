import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { PromptItemRepository } from '../src/repositories/prompt-item-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const vector = (hotIndex: number): number[] =>
  Array.from({ length: 384 }, (_, index) => (index === hotIndex ? 1 : 0));

describe('PromptItemRepository', () => {
  let db: PGlite;
  let repository: PromptItemRepository;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-prompt-items'));
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
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
        note: 'Tighten evidence requirements',
        revision: 1,
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

  it('imports legacy snapshots transactionally and rejects divergent reruns', async () => {
    const snapshot = {
      items: [
        {
          content: 'Current prompt content',
          createdAt: new Date('2025-01-01T10:00:00.000Z'),
          id: 'legacy-prompt',
          isFavorite: true,
          kind: 'prompt' as const,
          modelSettings: { model: 'gpt-4.1', temperature: 0.4 },
          rating: 4,
          revisions: [
            {
              content: 'Original prompt content',
              createdAt: new Date('2024-12-30T10:00:00.000Z'),
              id: 'legacy-revision',
              modelSettings: { model: 'gpt-4.1', temperature: 0.2 },
              note: 'Original',
              title: 'Legacy research prompt',
            },
          ],
          sourceUrl: 'https://example.com/source',
          tags: ['legacy', 'Research'],
          title: 'Legacy research prompt',
          updatedAt: new Date('2025-01-02T10:00:00.000Z'),
        },
      ],
    };

    await repository.importSnapshot(snapshot);
    await repository.importSnapshot(snapshot);

    expect(await repository.findById('legacy-prompt')).toMatchObject({
      content: 'Current prompt content',
      embeddingStatus: 'pending',
      isFavorite: true,
      rating: 4,
      revision: 2,
      tags: ['legacy', 'research'],
    });
    expect(await repository.listRevisions('legacy-prompt')).toEqual([
      expect.objectContaining({
        content: 'Original prompt content',
        id: 'legacy-revision',
        revision: 1,
      }),
    ]);

    await expect(
      repository.importSnapshot({
        items: [{ ...snapshot.items[0], content: 'Divergent local content' }],
      })
    ).rejects.toThrow(/conflicts with an existing database record/i);
  });
});
