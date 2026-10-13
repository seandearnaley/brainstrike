import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
  pid: number | undefined = 42;
}

const forkMock = vi.hoisted(() => vi.fn());
const appGetPathMock = vi.hoisted(() =>
  vi.fn((name: string) => (name === 'documents' ? '/mock/documents' : '/mock/userData'))
);

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock, isPackaged: false },
  utilityProcess: { fork: forkMock },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const ENV_KEYS = ['NODE_ENV', 'BRAINSTRIKE_DB_ROOT_PATH', 'BRAINSTRIKE_DB_PROFILE'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const scratchDirs: string[] = [];

function latestForkEnv(): Record<string, string> {
  const options = forkMock.mock.calls.at(-1)?.[2] as
    | { readonly env?: Record<string, string> }
    | undefined;
  if (!options?.env) {
    throw new Error('Expected the utility DB host to be forked with an environment.');
  }
  return options.env;
}

function makeGitCheckout(head: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-host-location-'));
  scratchDirs.push(root);
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.git', 'HEAD'), head);
  return root;
}

async function newManager() {
  const { createDbHostManager } = await import('../../db-host-manager');
  return createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
}

describe('DbHostManager database location handoff', () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    forkMock.mockImplementation(() => new FakeUtilityProcess());
    for (const key of ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it('passes main-resolved root AND profile to the host, deriving nothing itself', async () => {
    process.env['NODE_ENV'] = 'development';
    const checkout = makeGitCheckout('ref: refs/heads/feature/x\n');
    vi.spyOn(process, 'cwd').mockReturnValue(checkout);
    const { createWorktreeScopedProfile } = await import('../../database-location');
    const manager = await newManager();

    manager.getDiagnostics().catch(() => undefined);
    await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });

    expect(latestForkEnv()).toMatchObject({
      BRAINSTRIKE_DB_PROFILE: createWorktreeScopedProfile('feature/x', checkout),
      BRAINSTRIKE_DB_ROOT_PATH: path.join('/mock/documents', 'BrainStrike-dev'),
    });
  });

  it('sends the profile even when main was given no explicit profile (test run)', async () => {
    process.env['NODE_ENV'] = 'test';
    const manager = await newManager();

    manager.getDiagnostics().catch(() => undefined);
    await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });

    expect(latestForkEnv()).toMatchObject({
      BRAINSTRIKE_DB_PROFILE: 'test',
      BRAINSTRIKE_DB_ROOT_PATH: '/mock/userData',
    });
  });

  it('preserves temporary paths needed to stream packaged extensions without forwarding secrets', async () => {
    process.env['NODE_ENV'] = 'test';
    const temporaryPath = path.join(tmpdir(), 'brainstrike-packaged-extension-temp');
    vi.stubEnv('TEMP', temporaryPath);
    vi.stubEnv('TMP', temporaryPath);
    vi.stubEnv('OPENAI_API_KEY', 'fake-do-not-forward');
    const manager = await newManager();

    manager.getDiagnostics().catch(() => undefined);
    await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });

    expect(latestForkEnv()).toMatchObject({ TEMP: temporaryPath, TMP: temporaryPath });
    expect(latestForkEnv()).not.toHaveProperty('OPENAI_API_KEY');
  });

  it("keeps a respawned host on main's cached location after the git branch changes", async () => {
    process.env['NODE_ENV'] = 'development';
    const checkout = makeGitCheckout('ref: refs/heads/before\n');
    vi.spyOn(process, 'cwd').mockReturnValue(checkout);
    const manager = await newManager();

    manager.getDiagnostics().catch(() => undefined);
    await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });
    const firstEnv = latestForkEnv();
    writeFileSync(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/after\n');
    const firstHost = forkMock.mock.results.at(-1)?.value as FakeUtilityProcess;
    firstHost.emit('exit', 1);
    await expect(manager.getDiagnostics()).rejects.toBeInstanceOf(Error);
    expect(forkMock).toHaveBeenCalledTimes(1);
    void manager.retryInit({ noDeadline: false }).catch(() => undefined);
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(2), { interval: 0 });

    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(latestForkEnv()['BRAINSTRIKE_DB_PROFILE']).toMatch(/^branch-before-wt-/u);
    expect(latestForkEnv()).toMatchObject({
      BRAINSTRIKE_DB_PROFILE: firstEnv['BRAINSTRIKE_DB_PROFILE'],
      BRAINSTRIKE_DB_ROOT_PATH: firstEnv['BRAINSTRIKE_DB_ROOT_PATH'],
    });
  });

  it('ignores NODE_ENV=production when choosing the host database root', async () => {
    process.env['NODE_ENV'] = 'production';
    vi.spyOn(process, 'cwd').mockReturnValue(makeGitCheckout('ref: refs/heads/prod-check\n'));
    const manager = await newManager();

    manager.getDiagnostics().catch(() => undefined);
    await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });

    expect(latestForkEnv()['BRAINSTRIKE_DB_ROOT_PATH']).toBe(
      path.join('/mock/documents', 'BrainStrike-dev')
    );
  });

  it('honours explicit overrides on main and forwards them unchanged', async () => {
    const explicitRoot = path.join(tmpdir(), 'explicit-root');
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = explicitRoot;
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'Explicit Profile';
    const manager = await newManager();

    manager.getDiagnostics().catch(() => undefined);
    await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });

    expect(latestForkEnv()).toMatchObject({
      BRAINSTRIKE_DB_PROFILE: 'explicit-profile',
      BRAINSTRIKE_DB_ROOT_PATH: explicitRoot,
    });
  });
});
