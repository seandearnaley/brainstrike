import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: undefined as { getPath: (name: string) => string; isPackaged: boolean } | undefined,
}));
const loggerInfoMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  get app() {
    return electron.app;
  },
}));
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: loggerInfoMock,
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const PATHS: Record<string, string> = {
  documents: '/mock/documents',
  home: '/mock/home',
  userData: '/mock/userData',
};
const getPathMock = vi.fn((name: string) => PATHS[name] ?? '/mock/unknown');

const ENV_KEYS = [
  'NODE_ENV',
  'BRAINSTRIKE_DB_ROOT_PATH',
  'BRAINSTRIKE_DB_PROFILE',
  'LOCALAPPDATA',
  'XDG_DATA_HOME',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalArgv = [...process.argv];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const scratchDirs: string[] = [];

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

function makeGitCheckout(head: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-db-location-'));
  scratchDirs.push(root);
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.git', 'HEAD'), head);
  return root;
}

async function load() {
  return await import('../../desktop-database-location');
}

describe('resolveDesktopDatabaseLocation', () => {
  beforeEach(() => {
    vi.resetModules();
    getPathMock.mockClear();
    loggerInfoMock.mockClear();
    electron.app = { getPath: getPathMock, isPackaged: false };
    for (const key of ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    process.argv = [...originalArgv];
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    vi.restoreAllMocks();
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('puts a packaged macOS build inside userData even though NODE_ENV is unset', async () => {
    setPlatform('darwin');
    electron.app = { getPath: getPathMock, isPackaged: true };
    const { resolveDesktopDatabaseLocation } = await load();

    expect(resolveDesktopDatabaseLocation()).toEqual({
      profile: 'default',
      rootPath: path.join('/mock/userData', 'data'),
      source: 'packaged',
    });
  });

  it('ignores NODE_ENV=production: an unpackaged run stays on the development location', async () => {
    process.env['NODE_ENV'] = 'production';
    const checkout = makeGitCheckout('ref: refs/heads/feature/awesome\n');
    vi.spyOn(process, 'cwd').mockReturnValue(checkout);
    const { resolveDesktopDatabaseLocation } = await load();
    const { createWorktreeScopedProfile } = await import('../../database-location');

    expect(resolveDesktopDatabaseLocation()).toEqual({
      profile: createWorktreeScopedProfile('feature/awesome', checkout),
      rootPath: path.join('/mock/documents', 'BrainStrike-dev'),
      source: 'development',
    });
  });

  it('reads a linked-worktree .git pointer to derive the development profile', async () => {
    const main = makeGitCheckout('ref: refs/heads/main\n');
    const gitDir = path.join(main, '.git', 'worktrees', 'wt-a');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/fix/linked\n');
    const worktree = mkdtempSync(path.join(tmpdir(), 'brainstrike-db-location-wt-'));
    scratchDirs.push(worktree);
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    vi.spyOn(process, 'cwd').mockReturnValue(worktree);
    const { resolveDesktopDatabaseLocation } = await load();
    const { createWorktreeScopedProfile } = await import('../../database-location');

    expect(resolveDesktopDatabaseLocation().profile).toBe(
      createWorktreeScopedProfile('fix/linked', worktree)
    );
  });

  it('names a detached HEAD by its commit prefix', async () => {
    const checkout = makeGitCheckout('0123456789abcdef0123456789abcdef01234567\n');
    vi.spyOn(process, 'cwd').mockReturnValue(checkout);
    const { resolveDesktopDatabaseLocation } = await load();
    const { createWorktreeScopedProfile } = await import('../../database-location');

    expect(resolveDesktopDatabaseLocation().profile).toBe(
      createWorktreeScopedProfile('detached-0123456789ab', checkout)
    );
  });

  it('isolates a --test-mode run into userData, packaged or not', async () => {
    process.argv = [...originalArgv, '--test-mode'];
    electron.app = { getPath: getPathMock, isPackaged: true };
    const { resolveDesktopDatabaseLocation } = await load();

    expect(resolveDesktopDatabaseLocation()).toEqual({
      profile: 'test',
      rootPath: '/mock/userData',
      source: 'test',
    });
  });

  it('honours the root and profile environment overrides', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/tmp/e2e-root';
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'Custom Profile';
    const { resolveDesktopDatabaseLocation } = await load();

    expect(resolveDesktopDatabaseLocation()).toEqual({
      profile: 'custom-profile',
      rootPath: '/tmp/e2e-root',
      source: 'override',
    });
  });

  it('feeds LOCALAPPDATA and XDG_DATA_HOME from the environment for packaged builds', async () => {
    electron.app = { getPath: getPathMock, isPackaged: true };
    process.env['XDG_DATA_HOME'] = '/xdg/share';
    setPlatform('linux');
    const linux = await load();
    expect(linux.resolveDesktopDatabaseLocation().rootPath).toBe(
      path.join('/xdg/share', 'BrainStrike Desktop', 'data')
    );

    vi.resetModules();
    setPlatform('win32');
    const win = await load();
    expect(() => win.resolveDesktopDatabaseLocation()).toThrow(/LOCALAPPDATA/u);
  });

  it('resolves once, caches the result, and logs it once', async () => {
    process.env['NODE_ENV'] = 'test';
    const { resolveDesktopDatabaseLocation } = await load();

    const first = resolveDesktopDatabaseLocation();
    const callsAfterFirst = getPathMock.mock.calls.length;
    const second = resolveDesktopDatabaseLocation();

    expect(second).toBe(first);
    expect(getPathMock).toHaveBeenCalledTimes(callsAfterFirst);
    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ profile: 'test', rootPath: '/mock/userData', source: 'test' })
    );
  });

  it('only asks Electron for the paths the chosen rule reads', async () => {
    setPlatform('darwin');
    electron.app = { getPath: getPathMock, isPackaged: true };
    const { resolveDesktopDatabaseLocation } = await load();

    resolveDesktopDatabaseLocation();

    expect(getPathMock.mock.calls.map(([name]) => name)).toEqual(['userData']);
  });

  it('fails visibly when Electron app paths are unavailable', async () => {
    electron.app = undefined;
    const { resolveDesktopDatabaseLocation } = await load();

    expect(() => resolveDesktopDatabaseLocation()).toThrow(/app path resolution is unavailable/u);
  });
});
