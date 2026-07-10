import { addLogListener, configureLogger, type LogRecord } from '@brainstrike/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetUserCommandWarningsForTests } from '../../assistant-server/user-slash-commands-loader';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import { listUserSlashCommands } from '../../ipc-user-commands-handlers';

afterEach(() => {
  __resetUserCommandWarningsForTests();
});

const HOME = '/home/user';

function dbReturning(rows: { id: string; displayName: string | null; path: string | null }[]) {
  const db: WorkspaceRootsQueryable = {
    query: async <T>() => ({ rows: rows as unknown as T[] }),
  };
  return db;
}

function fsWith(files: Record<string, string>, dirs: Record<string, string[]>) {
  return {
    listDir: (absDir: string) => {
      const names = dirs[absDir];
      if (!names) {
        return null;
      }
      return names.map((name) => ({
        isDirectory: !name.includes('.'),
        isFile: name.includes('.'),
        name,
      }));
    },
    readFile: (absFile: string) => files[absFile] ?? null,
  };
}

describe('listUserSlashCommands', () => {
  it('resolves DB roots (DB roots.id + path) and returns commands + roots', async () => {
    const db = dbReturning([{ displayName: 'Proj', id: 'db-root-1', path: '/proj' }]);
    const fs = fsWith(
      { '/proj/.brainstrike/commands/review.md': 'Review $ARGUMENTS' },
      { '/proj/.brainstrike/commands': ['review.md'] }
    );

    const result = await listUserSlashCommands({
      fs,
      getDatabase: async () => db,
      homedir: () => HOME,
    });

    expect(result.roots).toEqual([{ displayName: 'Proj', id: 'db-root-1' }]);
    expect(result.commands).toEqual([
      { id: 'review', label: 'review', sourceRootId: 'db-root-1', template: 'Review $ARGUMENTS' },
    ]);
  });

  it('still loads global (~) commands when the DB is unavailable (logged, not silent)', async () => {
    const fs = fsWith(
      { '/home/user/.brainstrike/commands/note.md': 'A note' },
      { '/home/user/.brainstrike/commands': ['note.md'] }
    );

    configureLogger({ console: false });
    const records: LogRecord[] = [];
    const stop = addLogListener((record) => records.push(record));
    let result: Awaited<ReturnType<typeof listUserSlashCommands>>;
    try {
      result = await listUserSlashCommands({
        fs,
        getDatabase: async () => {
          throw new Error('db down');
        },
        homedir: () => HOME,
      });
    } finally {
      stop();
    }

    expect(result.roots).toEqual([]);
    expect(result.commands).toEqual([{ id: 'note', label: 'note', template: 'A note' }]);
    expect(
      records.some((record) => record.level === 'error' && record.scope === 'UserSlashCommands')
    ).toBe(true);
  });
});
