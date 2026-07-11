import { addLogListener, configureLogger, type LogRecord } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetUserCommandWarningsForTests,
  MAX_USER_COMMAND_FILE_CHARS,
  MAX_USER_COMMANDS,
  scanUserSlashCommands,
  type UserSlashCommandScanDeps,
  type UserSlashCommandScanRoot,
} from '../../assistant-server/user-slash-commands-loader';

/** In-memory fs: `dirs` maps an absolute dir to its immediate entries; `files` maps an absolute file to its content. */
interface MemoryFs {
  readonly dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  readonly files: Record<string, string>;
}

function makeDeps(fs: MemoryFs): UserSlashCommandScanDeps {
  return {
    listDir: (absDir) => {
      const entries = fs.dirs[absDir];
      if (!entries) {
        return null;
      }
      return entries.map((entry) => ({
        isDirectory: entry.kind === 'dir',
        isFile: entry.kind === 'file',
        name: entry.name,
      }));
    },
    readFile: (absFile) =>
      absFile in fs.files
        ? { content: fs.files[absFile] as string, ok: true }
        : { ok: false, reason: 'unreadable' },
  };
}

const HOME = '/home/user';

function captureLogs(): { records: LogRecord[]; stop: () => void } {
  configureLogger({ console: false });
  const records: LogRecord[] = [];
  const stop = addLogListener((record) => records.push(record));
  return { records, stop };
}

beforeEach(() => {
  __resetUserCommandWarningsForTests();
});

afterEach(() => {
  __resetUserCommandWarningsForTests();
});

describe('scanUserSlashCommands', () => {
  it('returns commands with directory namespacing and the source root id', () => {
    const roots: UserSlashCommandScanRoot[] = [
      { absPath: '/proj/a', displayName: 'A', id: 'root-a' },
    ];
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/commands': [
          { kind: 'file', name: 'review.md' },
          { kind: 'dir', name: 'git' },
        ],
        '/proj/a/.brainstrike/commands/git': [{ kind: 'file', name: 'commit.md' }],
      },
      files: {
        '/proj/a/.brainstrike/commands/git/commit.md': '---\nname: Commit\n---\nCommit: $ARGUMENTS',
        '/proj/a/.brainstrike/commands/review.md': 'Review $ARGUMENTS',
      },
    });

    const commands = scanUserSlashCommands({ homeDir: HOME, roots }, deps);
    const byId = new Map(commands.map((command) => [command.id, command]));

    expect(byId.get('review')).toEqual({
      id: 'review',
      label: 'review',
      sourceRootId: 'root-a',
      template: 'Review $ARGUMENTS',
    });
    expect(byId.get('git:commit')).toEqual({
      id: 'git:commit',
      label: 'Commit',
      sourceRootId: 'root-a',
      template: 'Commit: $ARGUMENTS',
    });
  });

  it('applies priority: <root>/.brainstrike beats ~/.brainstrike beats <root>/.claude beats ~/.claude (first-name-wins)', () => {
    const roots: UserSlashCommandScanRoot[] = [
      { absPath: '/proj/a', displayName: 'A', id: 'root-a' },
    ];
    const deps = makeDeps({
      dirs: {
        [`${HOME}/.brainstrike/commands`]: [{ kind: 'file', name: 'deploy.md' }],
        [`${HOME}/.claude/commands`]: [{ kind: 'file', name: 'deploy.md' }],
        '/proj/a/.brainstrike/commands': [{ kind: 'file', name: 'deploy.md' }],
        '/proj/a/.claude/commands': [{ kind: 'file', name: 'deploy.md' }],
      },
      files: {
        [`${HOME}/.brainstrike/commands/deploy.md`]: 'home-brainstrike',
        [`${HOME}/.claude/commands/deploy.md`]: 'home-claude',
        '/proj/a/.brainstrike/commands/deploy.md': 'project-brainstrike',
        '/proj/a/.claude/commands/deploy.md': 'project-claude',
      },
    });

    const commands = scanUserSlashCommands({ homeDir: HOME, roots }, deps);
    const deploy = commands.filter((command) => command.id === 'deploy');
    expect(deploy).toHaveLength(1);
    expect(deploy[0]?.template).toBe('project-brainstrike');
  });

  it('keeps the first root on a cross-root collision and warns once', () => {
    const roots: UserSlashCommandScanRoot[] = [
      { absPath: '/proj/a', displayName: 'A', id: 'root-a' },
      { absPath: '/proj/b', displayName: 'B', id: 'root-b' },
    ];
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/commands': [{ kind: 'file', name: 'review.md' }],
        '/proj/b/.brainstrike/commands': [{ kind: 'file', name: 'review.md' }],
      },
      files: {
        '/proj/a/.brainstrike/commands/review.md': 'from-a',
        '/proj/b/.brainstrike/commands/review.md': 'from-b',
      },
    });

    const { records, stop } = captureLogs();
    let commands: ReturnType<typeof scanUserSlashCommands>;
    try {
      commands = scanUserSlashCommands({ homeDir: HOME, roots }, deps);
    } finally {
      stop();
    }

    const review = commands.filter((command) => command.id === 'review');
    expect(review).toHaveLength(1);
    expect(review[0]?.sourceRootId).toBe('root-a');
    expect(review[0]?.template).toBe('from-a');
    expect(
      records.some((record) => record.level === 'warn' && record.message?.includes('slash command'))
    ).toBe(true);
  });

  it('omits sourceRootId for global (~) commands', () => {
    const deps = makeDeps({
      dirs: { [`${HOME}/.brainstrike/commands`]: [{ kind: 'file', name: 'note.md' }] },
      files: { [`${HOME}/.brainstrike/commands/note.md`]: 'Take a note' },
    });
    const commands = scanUserSlashCommands({ homeDir: HOME, roots: [] }, deps);
    expect(commands).toEqual([{ id: 'note', label: 'note', template: 'Take a note' }]);
  });

  it('skips a malformed-frontmatter file with a visible error and continues', () => {
    const roots: UserSlashCommandScanRoot[] = [
      { absPath: '/proj/a', displayName: 'A', id: 'root-a' },
    ];
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/commands': [
          { kind: 'file', name: 'broken.md' },
          { kind: 'file', name: 'ok.md' },
        ],
      },
      files: {
        '/proj/a/.brainstrike/commands/broken.md': '---\nname: Broken\nno closing fence',
        '/proj/a/.brainstrike/commands/ok.md': 'fine',
      },
    });

    const { records, stop } = captureLogs();
    let commands: ReturnType<typeof scanUserSlashCommands>;
    try {
      commands = scanUserSlashCommands({ homeDir: HOME, roots }, deps);
    } finally {
      stop();
    }

    expect(commands.map((command) => command.id)).toEqual(['ok']);
    expect(
      records.some(
        (record) => record.level === 'error' && record.message?.includes('slash command')
      )
    ).toBe(true);
  });

  it('tolerates missing directories (returns no commands, no throw)', () => {
    const deps = makeDeps({ dirs: {}, files: {} });
    expect(scanUserSlashCommands({ homeDir: HOME, roots: [] }, deps)).toEqual([]);
  });

  it('F3: skips an oversized command file with a visible warn-once and keeps the rest', () => {
    const oversized = 'x'.repeat(MAX_USER_COMMAND_FILE_CHARS + 1);
    const deps = makeDeps({
      dirs: {
        [`${HOME}/.brainstrike/commands`]: [
          { kind: 'file', name: 'huge.md' },
          { kind: 'file', name: 'ok.md' },
        ],
      },
      files: {
        [`${HOME}/.brainstrike/commands/huge.md`]: oversized,
        [`${HOME}/.brainstrike/commands/ok.md`]: 'fine',
      },
    });

    const { records, stop } = captureLogs();
    let commands: ReturnType<typeof scanUserSlashCommands>;
    try {
      commands = scanUserSlashCommands({ homeDir: HOME, roots: [] }, deps);
    } finally {
      stop();
    }

    expect(commands.map((command) => command.id)).toEqual(['ok']);
    expect(
      records.some(
        (record) => record.level === 'warn' && record.message?.toLowerCase().includes('oversized')
      )
    ).toBe(true);
  });

  it('reports a reader-rejected oversized file as a warn (never a "Failed to read" error)', () => {
    // The real-disk reader pre-rejects a file over the byte ceiling WITHOUT
    // reading it, returning {ok:false, reason:'oversized'}. The loader must log
    // that as an oversized WARN, not misattribute it to an I/O error.
    const deps: UserSlashCommandScanDeps = {
      listDir: (absDir) =>
        absDir === `${HOME}/.brainstrike/commands`
          ? [{ isDirectory: false, isFile: true, name: 'huge.md' }]
          : null,
      readFile: () => ({ ok: false, reason: 'oversized' }),
    };

    const { records, stop } = captureLogs();
    let commands: ReturnType<typeof scanUserSlashCommands>;
    try {
      commands = scanUserSlashCommands({ homeDir: HOME, roots: [] }, deps);
    } finally {
      stop();
    }

    expect(commands).toEqual([]);
    expect(
      records.some(
        (record) => record.level === 'warn' && record.message?.toLowerCase().includes('oversized')
      )
    ).toBe(true);
    expect(
      records.some(
        (record) => record.level === 'error' && record.message?.includes('Failed to read')
      )
    ).toBe(false);
  });

  it('reports a genuinely unreadable file as a "Failed to read" error', () => {
    const deps: UserSlashCommandScanDeps = {
      listDir: (absDir) =>
        absDir === `${HOME}/.brainstrike/commands`
          ? [{ isDirectory: false, isFile: true, name: 'gone.md' }]
          : null,
      readFile: () => ({ ok: false, reason: 'unreadable' }),
    };

    const { records, stop } = captureLogs();
    try {
      expect(scanUserSlashCommands({ homeDir: HOME, roots: [] }, deps)).toEqual([]);
    } finally {
      stop();
    }

    expect(
      records.some(
        (record) => record.level === 'error' && record.message?.includes('Failed to read')
      )
    ).toBe(true);
  });

  it('F3: caps the total command count with a visible warn and ignores the rest', () => {
    const overCount = MAX_USER_COMMANDS + 5;
    const names = Array.from({ length: overCount }, (_unused, index) => `cmd${index}.md`);
    const files: Record<string, string> = {};
    for (const name of names) {
      files[`${HOME}/.brainstrike/commands/${name}`] = 'body';
    }
    const deps = makeDeps({
      dirs: { [`${HOME}/.brainstrike/commands`]: names.map((name) => ({ kind: 'file', name })) },
      files,
    });

    const { records, stop } = captureLogs();
    let commands: ReturnType<typeof scanUserSlashCommands>;
    try {
      commands = scanUserSlashCommands({ homeDir: HOME, roots: [] }, deps);
    } finally {
      stop();
    }

    expect(commands).toHaveLength(MAX_USER_COMMANDS);
    expect(
      records.some(
        (record) => record.level === 'warn' && record.message?.toLowerCase().includes('cap')
      )
    ).toBe(true);
  });

  it('skips non-.md files and empty templates', () => {
    const deps = makeDeps({
      dirs: {
        [`${HOME}/.brainstrike/commands`]: [
          { kind: 'file', name: 'readme.txt' },
          { kind: 'file', name: 'empty.md' },
        ],
      },
      files: {
        [`${HOME}/.brainstrike/commands/empty.md`]: '   \n  ',
        [`${HOME}/.brainstrike/commands/readme.txt`]: 'not a command',
      },
    });
    expect(scanUserSlashCommands({ homeDir: HOME, roots: [] }, deps)).toEqual([]);
  });
});
