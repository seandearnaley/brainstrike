import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addLogListener, configureLogger, type LogRecord } from '@brainstrike/logging';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFsScanDeps } from '../../assistant-server/node-fs-scan-deps';
import { __resetUserCommandWarningsForTests } from '../../assistant-server/user-slash-commands-loader';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import { listUserSlashCommands } from '../../ipc-user-commands-handlers';

let tempRoot: string | undefined;
const scanDependencies: ReturnType<typeof createNodeFsScanDeps>[] = [];

function openScanDependencies(): ReturnType<typeof createNodeFsScanDeps> {
  const dependencies = createNodeFsScanDeps();
  scanDependencies.push(dependencies);
  return dependencies;
}

afterEach(() => {
  __resetUserCommandWarningsForTests();
  for (const dependencies of scanDependencies.splice(0)) {
    dependencies.dispose();
  }
  if (tempRoot) {
    rmSync(tempRoot, { force: true, recursive: true });
    tempRoot = undefined;
  }
});

const HOME = '/home/user';
const PROJECT_ROOT = path.resolve('/proj');

function dbReturning(rows: { id: string; displayName: string | null; path: string | null }[]) {
  const db: WorkspaceRootsQueryable = {
    query: async <T>() => ({ rows: rows as unknown as T[] }),
  };
  return db;
}

function fsWith(files: Record<string, string>, dirs: Record<string, string[]>) {
  return {
    listDir: (absDir: string, _containmentRoot: string, maxEntries: number) => {
      const names = dirs[absDir];
      if (!names) {
        return null;
      }
      return {
        entries: names.slice(0, maxEntries).map((name) => ({
          isDirectory: !name.includes('.'),
          isFile: name.includes('.'),
          name,
        })),
        inspected: Math.min(names.length, maxEntries),
        truncated: names.length > maxEntries,
      };
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
      openScanDependencies().listDir(
        path.join(workspace, '.brainstrike', 'commands'),
        workspace,
        500
      )
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
        openScanDependencies().listDir(
          path.join(workspace, commandsParent, 'commands'),
          workspace,
          500
        )
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

    const deps = openScanDependencies();
    expect(deps.listDir(commands, workspace, 500)?.entries.map((entry) => entry.name)).toEqual([
      'review.md',
    ]);
    rmSync(commands, { recursive: true });
    symlinkSync(outside, commands, 'dir');

    expect(deps.readFile(path.join(commands, 'review.md'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('does not read through a parent replaced after directory validation', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const workspace = path.join(tempRoot, 'workspace');
    const commands = path.join(workspace, '.brainstrike', 'commands');
    const parkedCommands = path.join(tempRoot, 'parked-commands');
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(commands, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(commands, 'review.md'), 'Inside workspace');
    writeFileSync(path.join(outside, 'review.md'), 'Outside workspace');

    const deps = openScanDependencies();
    expect(deps.listDir(commands, workspace, 500)).not.toBeNull();
    renameSync(commands, parkedCommands);
    symlinkSync(outside, commands, 'dir');

    expect(deps.readFile(path.join(commands, 'review.md'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('keeps recursive reads on the pinned root after its path is replaced', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const workspace = path.join(tempRoot, 'workspace');
    const parkedWorkspace = path.join(tempRoot, 'parked-workspace');
    const commands = path.join(workspace, '.brainstrike', 'commands');
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(path.join(commands, 'nested'), { recursive: true });
    mkdirSync(path.join(outside, '.brainstrike', 'commands', 'nested'), { recursive: true });

    const deps = openScanDependencies();
    expect(deps.listDir(commands, workspace, 500)).not.toBeNull();
    renameSync(workspace, parkedWorkspace);
    symlinkSync(outside, workspace, 'dir');

    expect(deps.listDir(path.join(commands, 'nested'), workspace, 500)).toEqual({
      entries: [],
      inspected: 0,
      truncated: false,
    });
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

    const deps = openScanDependencies();
    expect(deps.listDir(commandsA, rootA, 500)).not.toBeNull();
    expect(deps.listDir(commandsB, rootB, 500)).not.toBeNull();
    rmSync(commandsB, { recursive: true });
    symlinkSync(commandsA, commandsB, 'dir');

    expect(deps.readFile(path.join(commandsB, 'review.md'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('loads project commands through the native root capability', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-user-commands-'));
    const workspace = path.join(tempRoot, 'workspace');
    const commands = path.join(workspace, '.brainstrike', 'commands');
    mkdirSync(commands, { recursive: true });
    writeFileSync(path.join(commands, 'review.md'), 'Review $ARGUMENTS');

    const result = await listUserSlashCommands({
      fs: openScanDependencies(),
      getDatabase: async () =>
        dbReturning([{ displayName: 'Workspace', id: 'root-1', path: workspace }]),
      homedir: () => path.join(tempRoot as string, 'home'),
    });

    expect(result.commands).toEqual([
      {
        id: 'review',
        label: 'review',
        sourceRootId: 'root-1',
        template: 'Review $ARGUMENTS',
      },
    ]);
  });

  it('resolves DB roots (DB roots.id + path) and returns commands + roots', async () => {
    const db = dbReturning([{ displayName: 'Proj', id: 'db-root-1', path: PROJECT_ROOT }]);
    const fs = fsWith(
      { [`${PROJECT_ROOT}/.brainstrike/commands/review.md`]: 'Review $ARGUMENTS' },
      { [`${PROJECT_ROOT}/.brainstrike/commands`]: ['review.md'] }
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
      { displayName: 'Resolved', id: 'db-root-1', path: PROJECT_ROOT },
      { displayName: 'Unresolved', id: 'db-root-2', path: null },
    ]);
    // A file planted at the filesystem-root scan path the null root would join to
    // (`/.brainstrike/commands`) must NOT be scanned.
    const fs = fsWith(
      {
        '/.brainstrike/commands/leaked.md': 'Should never load',
        [`${PROJECT_ROOT}/.brainstrike/commands/review.md`]: 'Review $ARGUMENTS',
      },
      {
        '/.brainstrike/commands': ['leaked.md'],
        [`${PROJECT_ROOT}/.brainstrike/commands`]: ['review.md'],
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
