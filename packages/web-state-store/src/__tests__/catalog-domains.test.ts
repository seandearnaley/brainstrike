import {
  executeCollectionRequest,
  executeModelChoiceRequest,
  executePromptCatalogRequest,
  executeThreadGroups,
  executeViewFilterPresetRequest,
} from '@brainstrike/state-store/catalog-domains';
import { migrate } from '@brainstrike/state-store/schema';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bothDrivers, caught, loadSqliteWasm } from './drivers';

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await loadSqliteWasm();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Each catalog's operations on a migrated state DB, on both drivers. Ids and
 * the clock restart identically before each driver's run, so every reply,
 * generated values included, must match.
 */
function onBothDrivers<T>(work: (db: BetterSqlite3.Database) => T): { desktop: T; web: T } {
  let counter = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` as const
  );
  vi.useFakeTimers({ now: new Date('2026-10-15T12:00:00.000Z'), toFake: ['Date'] });
  return bothDrivers(
    sqlite3,
    (db) => {
      migrate(db);
      return work(db);
    },
    () => {
      counter = 0;
      vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    }
  );
}

const collection = {
  createdAt: '2026-10-13T19:45:00.000Z',
  dimensions: 384,
  distance: 'cosine' as const,
  id: 'collection-one',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  name: 'Project reference',
};

describe('the catalog domains on sqlite-wasm', () => {
  it('collections answer as on the desktop driver', () => {
    const { desktop, web } = onBothDrivers((db) => [
      executeCollectionRequest(db, { collection, operation: 'create' }),
      caught(() =>
        executeCollectionRequest(db, {
          collection: { ...collection, modelId: 'different' },
          operation: 'create',
        })
      ),
      executeCollectionRequest(db, {
        id: collection.id,
        metadata: { name: 'Renamed', tags: 'docs' },
        operation: 'update',
      }),
      executeCollectionRequest(db, { id: collection.id, operation: 'get' }),
      executeCollectionRequest(db, { operation: 'snapshot' }),
      executeCollectionRequest(db, { id: collection.id, operation: 'delete' }),
      executeCollectionRequest(db, { operation: 'list' }),
    ]);
    expect(web[0]).toEqual({ collections: [collection] });
    expect(web).toEqual(desktop);
  });

  it('model choices answer as on the desktop driver', () => {
    const { desktop, web } = onBothDrivers((db) => [
      executeModelChoiceRequest(db, { enabled: true, operation: 'provider', providerId: 'openai' }),
      executeModelChoiceRequest(db, {
        models: [
          { enabled: false, modelId: 'gpt-4o', providerId: 'openai' },
          { enabled: true, modelId: 'Xenova/bge-small-en-v1.5', providerId: 'local' },
        ],
        operation: 'models',
      }),
      caught(() =>
        executeModelChoiceRequest(db, {
          models: [{ enabled: true, modelId: '', providerId: 'local' }],
          operation: 'models',
        })
      ),
      executeModelChoiceRequest(db, {
        modelIds: ['claude-x', 'claude-y'],
        operation: 'initialize',
        policy: 'seed',
        providerId: 'anthropic',
      }),
      executeModelChoiceRequest(db, { operation: 'snapshot' }),
    ]);
    expect(web).toEqual(desktop);
  });

  it('the prompt catalog answers as on the desktop driver', () => {
    const { desktop, web } = onBothDrivers((db) => {
      const created = executePromptCatalogRequest(db, {
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
      return [
        created,
        executePromptCatalogRequest(db, {
          input: {
            content: 'Review {{path}} twice.',
            expectedRevision: 1,
            id: 'prompt-item-canonical',
            isFavorite: true,
            kind: 'prompt',
            tags: ['review'],
            title: 'Review changes twice',
          },
          operation: 'update',
        }),
        executePromptCatalogRequest(db, {
          action: 'insert',
          id: 'prompt-item-canonical',
          operation: 'usage',
        }),
        executePromptCatalogRequest(db, { id: 'prompt-item-canonical', operation: 'revisions' }),
        executePromptCatalogRequest(db, { filter: {}, operation: 'list' }),
        executePromptCatalogRequest(db, { id: 'prompt-item-canonical', operation: 'delete' }),
        executePromptCatalogRequest(db, { id: 'prompt-item-canonical', operation: 'get' }),
      ];
    });
    expect(web).toEqual(desktop);
  });

  it('thread groups answer as on the desktop driver', () => {
    const group = {
      color: 'rose' as const,
      icon: 'code' as const,
      id: 'thread-group-current',
      name: 'Current work',
      rank: 'a0',
      resourceId: 'brainstrike:workspace',
    };
    const placement = {
      flatRank: 'b0',
      groupId: group.id,
      rank: 'a0',
      resourceId: group.resourceId,
      threadId: 'current-thread',
    };
    const { desktop, web } = onBothDrivers((db) => [
      executeThreadGroups(db, { group, operation: 'create' }),
      executeThreadGroups(db, { operation: 'placements', placements: [placement] }),
      executeThreadGroups(db, { groupId: group.id, name: 'Renamed work', operation: 'rename' }),
      executeThreadGroups(db, { color: 'blue', groupId: group.id, operation: 'color' }),
      executeThreadGroups(db, { groupId: group.id, icon: 'rocket', operation: 'icon' }),
      executeThreadGroups(db, { operation: 'list', resourceId: group.resourceId }),
      executeThreadGroups(db, { groupId: group.id, operation: 'delete' }),
      executeThreadGroups(db, { operation: 'list', resourceId: group.resourceId }),
    ]);
    expect(web).toEqual(desktop);
  });

  it('view filter presets answer as on the desktop driver', () => {
    const { desktop, web } = onBothDrivers((db) => {
      const seeded = executeViewFilterPresetRequest(db, { operation: 'list' });
      const created = executeViewFilterPresetRequest(db, {
        input: {
          excludes: ['src/generated/**'],
          includes: ['src/**'],
          name: 'Project sources',
          useRegex: false,
        },
        operation: 'create',
      });
      const id = created.presets[0]?.id ?? '';
      return [
        seeded,
        created,
        executeViewFilterPresetRequest(db, {
          id,
          input: { includes: ['lib/**'], name: 'My sources' },
          operation: 'update',
        }),
        executeViewFilterPresetRequest(db, {
          id: seeded.presets[0]?.id ?? '',
          operation: 'delete',
        }),
        executeViewFilterPresetRequest(db, { id, operation: 'delete' }),
        executeViewFilterPresetRequest(db, { operation: 'list' }),
      ];
    });
    expect(web[0]?.presets.length).toBeGreaterThan(0);
    expect(web).toEqual(desktop);
  });
});
