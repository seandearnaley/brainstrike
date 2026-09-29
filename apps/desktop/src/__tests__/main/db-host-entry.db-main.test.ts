import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinProfileDirectory } from '../../database-location';
import {
  bootHost,
  lifecycleStates,
  posted,
  responsesFor,
  restoreParentPort,
} from '../helpers/db-host-entry-harness';

// The REAL host entry over the REAL db-main (its real `closeLocalDatabase`, sticky `closeFailure`,
// process lock and clean-shutdown marker) on a temp directory. Only the PGlite engine is fake, so a
// close failure can be injected into it.
const engine = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createBrainstrikePglite: vi.fn(),
  exec: vi.fn(async () => undefined),
  migrate: vi.fn(async () => undefined),
  query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })),
  syncToFs: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/unused') } }));
vi.mock('@brainstrike/db/pglite-factory', () => ({
  createBrainstrikePglite: engine.createBrainstrikePglite,
}));
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db')>()),
  migrate: engine.migrate,
}));
vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

const originalDbRootPath = process.env['BRAINSTRIKE_DB_ROOT_PATH'];
const originalDbProfile = process.env['BRAINSTRIKE_DB_PROFILE'];
const originalNodeEnv = process.env['NODE_ENV'];

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

describe('db-host-entry signal close over the real db-main', () => {
  let rootPath: string;
  let appDataDir: string;

  const markerPath = (): string => path.join(appDataDir, '.db-clean-shutdown');
  const lockPath = (): string => path.join(appDataDir, '.db-process.lock');

  async function bootOpenHost() {
    const host = await bootHost();
    host.send('init', { kind: 'init' });
    await vi.waitFor(() => expect(responsesFor(host, 'init')).toHaveLength(1));
    expect(responsesFor(host, 'init')[0]).toMatchObject({ ok: true });
    // Opening removes the marker: a running session is unclean until it closes.
    expect(existsSync(markerPath())).toBe(false);
    expect(existsSync(lockPath())).toBe(true);
    return host;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    rootPath = mkdtempSync(path.join(tmpdir(), 'brainstrike-host-close-'));
    appDataDir = joinProfileDirectory(rootPath, 'test');
    process.env['NODE_ENV'] = 'test';
    // The host reads BOTH from its environment and throws when either is missing.
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = rootPath;
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'test';
    // Implementations a test set (a failing close, a gated open) must not leak into the next one.
    for (const method of [engine.close, engine.migrate, engine.syncToFs]) {
      method.mockReset();
      method.mockResolvedValue(undefined);
    }
    engine.createBrainstrikePglite.mockImplementation(async () => ({
      close: engine.close,
      exec: engine.exec,
      query: engine.query,
      syncToFs: engine.syncToFs,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    restoreParentPort();
    restoreEnv('BRAINSTRIKE_DB_ROOT_PATH', originalDbRootPath);
    restoreEnv('BRAINSTRIKE_DB_PROFILE', originalDbProfile);
    restoreEnv('NODE_ENV', originalNodeEnv);
    rmSync(rootPath, { force: true, recursive: true });
  });

  it('control: a signal close that succeeds has written the marker, naming this host, before it exits 0', async () => {
    const host = await bootOpenHost();
    let markerAtExit: boolean | null = null;
    vi.mocked(process.exit).mockImplementation(((code?: number | string | null) => {
      markerAtExit = existsSync(markerPath());
      host.exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);

    host.signal('SIGTERM');

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(markerAtExit).toBe(true);
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(existsSync(lockPath())).toBe(false);
    expect(lifecycleStates(host)).toEqual(['closing:SIGTERM', 'closed:SIGTERM']);
  });

  it('a signal that arrives mid-open waits for the open to settle, then closes what it opened', async () => {
    const host = await bootHost();
    const opening = Promise.withResolvers<void>();
    engine.createBrainstrikePglite.mockImplementation(async () => {
      await opening.promise;
      return {
        close: engine.close,
        exec: engine.exec,
        query: engine.query,
        syncToFs: engine.syncToFs,
      };
    });
    host.send('init', { kind: 'init' });
    await vi.waitFor(() => expect(engine.createBrainstrikePglite).toHaveBeenCalledTimes(1));

    host.signal('SIGTERM');
    await vi.waitFor(() => expect(lifecycleStates(host)).toEqual(['closing:SIGTERM']));
    // Nothing closes underneath the open, and the host has not exited.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.close).not.toHaveBeenCalled();
    expect(host.exitCodes).toEqual([]);

    opening.resolve();

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(responsesFor(host, 'init')[0]).toMatchObject({ ok: true });
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(existsSync(lockPath())).toBe(false);
  });

  it('a signal that arrives mid-open which then fails closes nothing more and exits 0 with no marker', async () => {
    const host = await bootHost();
    const opening = Promise.withResolvers<void>();
    engine.migrate.mockImplementation(async () => {
      await opening.promise;
      throw new Error('migration failed');
    });
    host.send('init', { kind: 'init' });
    await vi.waitFor(() => expect(engine.migrate).toHaveBeenCalledTimes(1));

    host.signal('SIGTERM');
    opening.resolve();

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(responsesFor(host, 'init')[0]).toMatchObject({ ok: false });
    // The failed open's own cleanup closed its handle once; the signal close found nothing to close.
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(existsSync(markerPath())).toBe(false);
  });

  it.each([
    { failure: 'close', stage: 'close' },
    { failure: 'syncToFs', stage: 'sync' },
  ] as const)(
    'a signal close that fails at the $stage stage exits 1, writes no marker, keeps the lock, and never retries',
    async ({ failure }) => {
      const host = await bootOpenHost();
      engine[failure].mockRejectedValue(new Error('checkpoint failed'));

      host.signal('SIGTERM');

      await vi.waitFor(() => expect(host.exitCodes).toEqual([1]));
      expect(existsSync(markerPath())).toBe(false);
      // A failed close keeps the lock: the handle may still own the data directory.
      expect(existsSync(lockPath())).toBe(true);
      expect(posted(host)).toContainEqual(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('checkpoint failed') }),
          kind: 'lifecycle',
          reason: 'SIGTERM',
          state: 'close-failed',
        })
      );
      expect(posted(host)).toContainEqual(
        expect.objectContaining({
          error: expect.objectContaining({ name: 'DatabaseCloseError' }),
          kind: 'lifecycle',
        })
      );
      // A failed sync still runs the shutdown close, so the engine was closed exactly once.
      expect(engine.close).toHaveBeenCalledTimes(1);
      const syncsAfterFirst = engine.syncToFs.mock.calls.length;

      // No retry from any later path: a signal exits 1 at once, and a close envelope is answered
      // with the first failure.
      host.signal('SIGINT');
      host.signal('SIGHUP');
      host.send('late-close', { kind: 'close' });
      await vi.waitFor(() => expect(responsesFor(host, 'late-close')).toHaveLength(1));

      expect(host.exitCodes).toEqual([1, 1, 1]);
      expect(responsesFor(host, 'late-close')[0]).toMatchObject({
        error: expect.objectContaining({ message: expect.stringContaining('checkpoint failed') }),
        ok: false,
      });
      // A second attempt would fail on the sticky `closeFailure` and be announced again.
      expect(lifecycleStates(host)).toEqual(['closing:SIGTERM', 'close-failed:SIGTERM']);
      expect(
        posted(host).filter(
          (message) => message['message'] === 'DB host failed to close the database'
        )
      ).toHaveLength(1);
      expect(engine.close).toHaveBeenCalledTimes(1);
      expect(engine.syncToFs).toHaveBeenCalledTimes(syncsAfterFirst);
      expect(existsSync(markerPath())).toBe(false);
      expect(existsSync(lockPath())).toBe(true);
    }
  );
});
