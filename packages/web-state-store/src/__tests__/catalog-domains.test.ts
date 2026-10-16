import {
  executeCollectionRequest,
  executeModelChoiceRequest,
  executePromptCatalogRequest,
  executeSourceCatalogRequest,
  executeThreadGroups,
  executeViewFilterPresetRequest,
  executeWorkspaceRootRequest,
} from '@brainstrike/state-store/catalog-domains';
import { migrate } from '@brainstrike/state-store/schema';
import { sha256Hex } from '@brainstrike/utils/crypto';
import { utf8ByteLength } from '@brainstrike/utils/utf8';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isWebRootPath, webRootPath } from '../protocol';
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

/** The browser writer's root rule: a root is named by its own id (`webRootPath`). */
const browserRoots = {
  isGranted: (root: { readonly path: string; readonly preferredId: string }) =>
    isWebRootPath(root.path, root.preferredId),
};

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
  it('the source catalog answers as on the desktop driver, retiring replaced and removed bytes', () => {
    const source = (path: string, content: string) => ({
      content,
      contentHash: sha256Hex(content),
      fileName: path.split('/').at(-1) ?? path,
      path,
      stat: { mtimeMs: 1, size: utf8ByteLength(content) },
    });
    const { desktop, web } = onBothDrivers((db) => {
      const stored = new Map<string, string>();
      const blobs = {
        put: (hash: string, content: string) => {
          stored.set(hash, content);
        },
        read: (hash: string, maxBytes: number) => {
          const content = stored.get(hash) ?? null;
          return content !== null && utf8ByteLength(content) > maxBytes ? null : content;
        },
      };
      const run = (request: Parameters<typeof executeSourceCatalogRequest>[1]) =>
        executeSourceCatalogRequest(db, request, blobs);
      const retired = () =>
        db.prepare('SELECT hash FROM source_blob_gc ORDER BY hash').pluck().all();
      executeCollectionRequest(db, { collection, operation: 'create' });
      const rootId = '00000000-0000-4000-8000-00000000aaaa';
      executeWorkspaceRootRequest(
        db,
        {
          operation: 'register',
          root: { displayName: 'notes', path: webRootPath(rootId), preferredId: rootId },
        },
        browserRoots
      );
      const imported = run({
        embeddingSetId: collection.id,
        files: [source('a.md', 'alpha café 🧠'), source('b.md', 'alpha café 🧠')],
        operation: 'import',
      });
      const prepared = run({
        embeddingSetId: collection.id,
        files: [source('src/one.ts', 'export const one = 1;\n')],
        operation: 'prepare',
        rootId,
      });
      const [rooted] = prepared.files;
      if (!rooted) {
        throw new Error('prepare returned no file');
      }
      const replaced = run({
        files: [{ expected: rooted, source: source('src/one.ts', 'export const one = 2;\n') }],
        operation: 'replace',
      });
      const afterReplace = retired();
      const [current] = replaced.files;
      if (!current) {
        throw new Error('replace returned no file');
      }
      return [
        imported,
        prepared,
        replaced,
        afterReplace,
        run({ fileIds: [current.fileId], maxContentBytes: 1000, operation: 'read' }),
        run({ fileIds: [current.fileId], maxContentBytes: 3, operation: 'read' }),
        run({ files: [{ chunkCount: 2, expected: current }], operation: 'complete' }),
        run({ embeddingSetId: collection.id, operation: 'inventory' }),
        run({
          files: [run({ fileIds: [current.fileId], operation: 'read' }).files[0] ?? current],
          operation: 'remove',
        }),
        retired(),
        run({ operation: 'list' }),
        caught(() =>
          run({ embeddingSetId: 'absent', files: [source('c.md', 'c')], operation: 'import' })
        ),
        caught(() =>
          run({
            embeddingSetId: collection.id,
            files: [{ ...source('d.md', 'd'), contentHash: sha256Hex('other') }],
            operation: 'import',
          })
        ),
      ];
    });
    expect(web[0]).toMatchObject({ imported: [true, false] });
    // The replaced bytes, then the removed file's bytes, wait for the writer's GC.
    expect(web[3]).toEqual([sha256Hex('export const one = 1;\n')]);
    expect(web[9]).toEqual(
      [sha256Hex('export const one = 1;\n'), sha256Hex('export const one = 2;\n')].sort()
    );
    expect(web).toEqual(desktop);
  });

  it('workspace roots answer as on the desktop driver, with a browser root named by its handle key', () => {
    const paths = browserRoots;
    const rootId = '00000000-0000-4000-8000-00000000bbbb';
    const { desktop, web } = onBothDrivers((db) => {
      const run = (request: Parameters<typeof executeWorkspaceRootRequest>[1]) =>
        executeWorkspaceRootRequest(db, request, paths);
      const root = { displayName: 'project', path: webRootPath(rootId), preferredId: rootId };
      return [
        run({ operation: 'register', root }),
        // Re-picking the folder registers its root again under the same id and key.
        run({ operation: 'register', root }),
        // A key that names another root would file the handle under the wrong id.
        caught(() =>
          run({
            operation: 'register',
            root: {
              ...root,
              path: webRootPath('00000000-0000-4000-8000-00000000cccc'),
              preferredId: '00000000-0000-4000-8000-00000000dddd',
            },
          })
        ),
        caught(() =>
          run({
            operation: 'register',
            root: { displayName: 'os', path: '/home/user/project', preferredId: 'os' },
          })
        ),
        run({ mountedPaths: [], operation: 'disconnect-except' }),
        run({ operation: 'list' }),
        caught(() => run({ operation: 'delete', paths: ['fsa:wrong'], rootId })),
        run({ operation: 'delete', paths: [root.path], rootId }),
        run({ operation: 'list' }),
      ];
    });
    expect(web[1]).toMatchObject({ roots: [{ id: rootId, status: 'live' }] });
    // A key naming another root, and an OS path, are not roots this host granted.
    expect(web[2]).toEqual({ code: undefined, name: 'Error' });
    expect(web[3]).toEqual({ code: undefined, name: 'Error' });
    expect(web[8]).toEqual({ roots: [] });
    expect(web).toEqual(desktop);
  });
});
