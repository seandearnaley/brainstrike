/**
 * Multi-root journal identity coverage (BST-1113 review finding): the fold
 * and `resolveJournalFileDiff` must key on `(rootId, path)`, not `path`
 * alone, or a multi-root thread that touches the same relative path in two
 * different mounted roots silently merges/loses one of them. Split out of
 * `changeset-journal-view.test.ts` to keep that file under the repo-wide
 * 1000-line cap (BST-1117) — shared fixtures in
 * `changeset-journal-view-test-support.ts`.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { AssistantEditCheckpointRecord } from '@brainstrike/agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  foldJournalRecords,
  resolveJournalFileDiff,
} from '../../assistant-server/changeset-journal-view';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import { cleanupTempDirs, makeTempDir, record } from './changeset-journal-view-test-support';

afterEach(cleanupTempDirs);

function fakeDbWithBeforeContent(
  records: AssistantEditCheckpointRecord[],
  beforeContentById: Record<string, { beforeContent: string | null; beforeExisted: boolean }>
): EditCheckpointDatabase {
  return {
    query: (async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('run_id = $1')) {
        return { rows: records };
      }
      if (sql.includes('before_content')) {
        const id = String((params ?? [])[0]);
        const row = beforeContentById[id];
        if (!row) {
          return { rows: [] };
        }
        return { rows: [row] };
      }
      throw new Error(`unexpected query in fake db: ${sql}`);
    }) as EditCheckpointDatabase['query'],
  };
}

describe('foldJournalRecords — multi-root identity (review finding, BST-1113)', () => {
  it('a run touching the SAME relative path in TWO roots yields TWO entries, not one merged/dropped entry', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: true,
        id: 'root-a-write',
        occurredAt: '2026-01-01T00:00:01.000Z',
        path: 'src/index.ts',
        rootId: 'root-a',
      }),
      record({
        beforeExisted: true,
        id: 'root-b-write',
        occurredAt: '2026-01-01T00:00:02.000Z',
        path: 'src/index.ts',
        rootId: 'root-b',
      }),
    ]);

    expect(entries).toHaveLength(2);
    const byRoot = new Map(entries.map((entry) => [entry.rootId, entry]));
    expect(byRoot.get('root-a')?.path).toBe('src/index.ts');
    expect(byRoot.get('root-a')?.chainRecords.map((r) => r.id)).toEqual(['root-a-write']);
    expect(byRoot.get('root-b')?.path).toBe('src/index.ts');
    expect(byRoot.get('root-b')?.chainRecords.map((r) => r.id)).toEqual(['root-b-write']);
  });

  it('a rename in one root never collides with (or absorbs) an unrelated same-path history in another root', () => {
    const entries = foldJournalRecords([
      // root-a: old.txt -> new.txt (rename).
      record({
        captureStatus: 'rename',
        fromPath: 'old.txt',
        id: 'rename-a',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'rename',
        path: 'new.txt',
        rootId: 'root-a',
      }),
      // root-b: an UNRELATED delete at the exact same destination path —
      // must NOT be treated as an occupant of root-a's rename destination.
      record({
        beforeExisted: true,
        id: 'delete-b',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'delete',
        path: 'new.txt',
        rootId: 'root-b',
      }),
    ]);

    expect(entries).toHaveLength(2);
    const byRoot = new Map(entries.map((entry) => [entry.rootId, entry]));
    expect(byRoot.get('root-a')?.status).toBe('renamed');
    expect(byRoot.get('root-a')?.oldPath).toBe('old.txt');
    expect(byRoot.get('root-a')?.chainRecords.map((r) => r.id)).toEqual(['rename-a']);
    expect(byRoot.get('root-b')?.status).toBe('deleted');
    expect(byRoot.get('root-b')?.chainRecords.map((r) => r.id)).toEqual(['delete-b']);
  });
});

describe('resolveJournalFileDiff — multi-root disambiguation (review finding, BST-1113)', () => {
  it('two roots journaling the SAME relative path: fileDiff resolves the REQUESTED root, never the other one', async () => {
    const recA = record({
      beforeExisted: true,
      captureStatus: 'ok',
      id: 'rec-a',
      path: 'src/index.ts',
      rootId: 'root-a',
    });
    const recB = record({
      beforeExisted: true,
      captureStatus: 'ok',
      id: 'rec-b',
      path: 'src/index.ts',
      rootId: 'root-b',
    });
    const db = fakeDbWithBeforeContent([recA, recB], {
      'rec-a': { beforeContent: 'root-a old content\n', beforeExisted: true },
      'rec-b': { beforeContent: 'root-b old content\n', beforeExisted: true },
    });
    const rootDirs: Record<string, string> = {
      'root-a': await makeTempDir(),
      'root-b': await makeTempDir(),
    };
    await fsPromises.mkdir(path.join(rootDirs['root-a'] ?? '', 'src'), { recursive: true });
    await fsPromises.mkdir(path.join(rootDirs['root-b'] ?? '', 'src'), { recursive: true });
    await fsPromises.writeFile(
      path.join(rootDirs['root-a'] ?? '', 'src/index.ts'),
      'root-a new content\n',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(rootDirs['root-b'] ?? '', 'src/index.ts'),
      'root-b new content\n',
      'utf8'
    );

    const resultA = await resolveJournalFileDiff(
      {
        db,
        resolveRootCwd: async (rootId) => ({ ok: true, value: rootDirs[String(rootId)] ?? '' }),
      },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      'root-a',
      'src/index.ts'
    );
    expect(resultA.ok).toBe(true);
    if (resultA.ok) {
      expect(resultA.value.content).toEqual({
        kind: 'full',
        newContent: 'root-a new content\n',
        oldContent: 'root-a old content\n',
      });
    }

    const resultB = await resolveJournalFileDiff(
      {
        db,
        resolveRootCwd: async (rootId) => ({ ok: true, value: rootDirs[String(rootId)] ?? '' }),
      },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      'root-b',
      'src/index.ts'
    );
    expect(resultB.ok).toBe(true);
    if (resultB.ok) {
      expect(resultB.value.content).toEqual({
        kind: 'full',
        newContent: 'root-b new content\n',
        oldContent: 'root-b old content\n',
      });
    }
  });

  it('a missing/malformed rootId is a typed rejection, never falling through to the wrong entry', async () => {
    const db = fakeDbWithBeforeContent([record({ path: 'a.txt' })], {});
    const result = await resolveJournalFileDiff(
      { db, resolveRootCwd: async () => ({ error: 'unused', ok: false }) },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      42,
      'a.txt'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/rootId/);
    }
  });
});
