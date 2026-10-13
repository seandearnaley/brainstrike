import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The REAL manager and the REAL db-main reset, over a real temp profile. This is what makes a
// user-confirmed reset "the way out" of a stop: it must run without forking a host (a fork is what
// a stopped manager refuses) and it must take the record with the profile.
class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly pid = 4242;
  readonly postMessage = vi.fn();
}

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  utilityProcess: { fork: forkMock },
}));

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
let rootPath: string;
let profileDir: string;
const recordPath = (): string => path.join(profileDir, '.db-init-attempt.json');

beforeEach(() => {
  vi.resetModules();
  forkMock.mockReset().mockImplementation(() => new FakeUtilityProcess());
  rootPath = mkdtempSync(path.join(tmpdir(), 'brainstrike-stop-reset-'));
  profileDir = path.join(rootPath, 'profiles', 'test');
  process.env['NODE_ENV'] = 'test';
  process.env['BRAINSTRIKE_DB_ROOT_PATH'] = rootPath;
  process.env['BRAINSTRIKE_DB_PROFILE'] = 'test';
  // Main process: no parentPort, so db-main resets through the manager and deletes from main.
  Object.defineProperty(process, 'parentPort', { configurable: true, value: undefined });
  mkdirSync(path.join(profileDir, 'pgdata'), { recursive: true });
  writeFileSync(path.join(profileDir, 'pgdata', 'PG_VERSION'), '18');
  writeFileSync(
    recordPath(),
    JSON.stringify({
      budgetMs: 372_000,
      consecutiveTimeouts: 2,
      hostPid: 4242,
      lastTimeoutAt: '2026-09-29T18:00:00.000Z',
      phaseKey: 'init:first-report',
      report: null,
      version: 1,
    })
  );
});

afterEach(() => {
  Object.defineProperty(
    process,
    'parentPort',
    originalParentPortDescriptor ?? { configurable: true, value: undefined }
  );
  rmSync(rootPath, { force: true, recursive: true });
});

it('a user-confirmed reset clears a stop without forking a host, and the next manager opens', async () => {
  const { DbHostInitStoppedError } = await import('../../db-host-lifecycle-errors');
  const { getDbHostManager } = await import('../../db-host-manager');
  const stopped = await getDbHostManager()
    .getDatabase()
    .then(
      () => null,
      (error: unknown) => error
    );
  expect(stopped).toBeInstanceOf(DbHostInitStoppedError);

  const { resetLocalDatabase } = await import('../../db-main');
  await resetLocalDatabase();

  // The stopped manager needed no host to be closed, and the profile went with the record.
  expect(forkMock).not.toHaveBeenCalled();
  expect(existsSync(recordPath())).toBe(false);
  // Both resets retire the default manager, so its stop is not carried into the next one.
  void getDbHostManager().getDatabase();
  await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });
  expect(forkMock).toHaveBeenCalledTimes(1);
});
