import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addLogListener, configureLogger, type LogRecord } from '@brainstrike/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetUserCommandWarningsForTests } from '../../assistant-server/user-slash-commands-loader';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import { createNodeFsScanDeps, listUserSlashCommands } from '../../ipc-user-commands-handlers';

let tempRoot: string | undefined;

afterEach(() => {
  __resetUserCommandWarningsForTests();
  if (tempRoot) {
    rmSync(tempRoot, { force: true, recursive: true });
    tempRoot = undefined;
  }
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
    readFile: (absFile: string) =>
      absFile in files
        ? ({ content: files[absFile] as string, ok: true } as const)
        : ({ ok: false, reason: 'unreadable' } as const),
  };
}

describe('listUserSlashCommands', () => {
  it('does not follow symlinked command directories outside the workspace', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const workspace = path.join(tempRoot, 'workspace');
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(path.join(workspace, '.brainstrike'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'leaked.md'), 'Outside workspace');
    symlinkSync(outside, path.join(workspace, '.brainstrike', 'commands'), 'dir');

    expect(
      createNodeFsScanDeps().listDir(path.join(workspace, '.brainstrike', 'commands'), workspace)
    ).toBeNull();
  });

  it('does not follow symlinked command-directory parents outside the workspace', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    for (const commandsParent of ['.brainstrike', '.claude']) {
      const suffix = commandsParent.slice(1);
      const workspace = path.join(tempRoot, `workspace-${suffix}`);
      const outside = path.join(tempRoot, `outside-${suffix}`);
      mkdirSync(workspace);
      mkdirSync(path.join(outside, 'commands'), { recursive: true });
      writeFileSync(path.join(outside, 'commands', 'leaked.md'), 'Outside workspace');
      symlinkSync(outside, path.join(workspace, commandsParent), 'dir');

      expect(
        createNodeFsScanDeps().listDir(path.join(workspace, commandsParent, 'commands'), workspace)
      ).toBeNull();
    }
  });

  it('does not read through a command directory swapped after validation', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const workspace = path.join(tempRoot, 'workspace');
    const commands = path.join(workspace, '.brainstrike', 'commands');
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(commands, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(commands, 'review.md'), 'Inside workspace');
    writeFileSync(path.join(outside, 'review.md'), 'Outside workspace');

    const deps = createNodeFsScanDeps();
    expect(deps.listDir(commands, workspace)?.map((entry) => entry.name)).toEqual(['review.md']);
    rmSync(commands, { recursive: true });
    symlinkSync(outside, commands, 'dir');

    expect(deps.readFile(path.join(commands, 'review.md'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('does not read through a parent swapped between canonicalization and open', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const workspace = path.join(tempRoot, 'workspace');
    const commands = path.join(workspace, '.brainstrike', 'commands');
    const parkedCommands = path.join(tempRoot, 'parked-commands');
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(commands, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(commands, 'review.md'), 'Inside workspace');
    writeFileSync(path.join(outside, 'review.md'), 'Outside workspace');

    const deps = createNodeFsScanDeps(() => {
      renameSync(commands, parkedCommands);
      symlinkSync(outside, commands, 'dir');
    });
    expect(deps.listDir(commands, workspace)).not.toBeNull();

    expect(deps.readFile(path.join(commands, 'review.md'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('pins the canonical root across recursive directory reads', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const workspace = path.join(tempRoot, 'workspace');
    const parkedWorkspace = path.join(tempRoot, 'parked-workspace');
    const commands = path.join(workspace, '.brainstrike', 'commands');
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(path.join(commands, 'nested'), { recursive: true });
    mkdirSync(path.join(outside, '.brainstrike', 'commands', 'nested'), { recursive: true });

    const deps = createNodeFsScanDeps();
    expect(deps.listDir(commands, workspace)).not.toBeNull();
    renameSync(workspace, parkedWorkspace);
    symlinkSync(outside, workspace, 'dir');

    expect(deps.listDir(path.join(commands, 'nested'), workspace)).toBeNull();
  });

  it('does not reuse a validated directory from another workspace root', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const rootA = path.join(tempRoot, 'root-a');
    const rootB = path.join(tempRoot, 'root-b');
    const commandsA = path.join(rootA, '.brainstrike', 'commands');
    const commandsB = path.join(rootB, '.brainstrike', 'commands');
    mkdirSync(commandsA, { recursive: true });
    mkdirSync(commandsB, { recursive: true });
    writeFileSync(path.join(commandsA, 'review.md'), 'Root A');
    writeFileSync(path.join(commandsB, 'review.md'), 'Root B');

    const deps = createNodeFsScanDeps();
    expect(deps.listDir(commandsA, rootA)).not.toBeNull();
    expect(deps.listDir(commandsB, rootB)).not.toBeNull();
    rmSync(commandsB, { recursive: true });
    symlinkSync(commandsA, commandsB, 'dir');

    expect(deps.readFile(path.join(commandsB, 'review.md'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

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

  it('drops a root whose DB path is null (no filesystem-root scan, not reported)', async () => {
    const db = dbReturning([
      { displayName: 'Resolved', id: 'db-root-1', path: '/proj' },
      { displayName: 'Unresolved', id: 'db-root-2', path: null },
    ]);
    // A file planted at the filesystem-root scan path the null root would join to
    // (`/.brainstrike/commands`) must NOT be scanned.
    const fs = fsWith(
      {
        '/.brainstrike/commands/leaked.md': 'Should never load',
        '/proj/.brainstrike/commands/review.md': 'Review $ARGUMENTS',
      },
      {
        '/.brainstrike/commands': ['leaked.md'],
        '/proj/.brainstrike/commands': ['review.md'],
      }
    );

    const result = await listUserSlashCommands({
      fs,
      getDatabase: async () => db,
      homedir: () => HOME,
    });

    expect(result.roots).toEqual([{ displayName: 'Resolved', id: 'db-root-1' }]);
    expect(result.commands.map((command) => command.id)).toEqual(['review']);
  });
});
