// @vitest-environment node
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { completePendingFactoryReset, requestFactoryReset } from '../../factory-reset-relaunch';

const secureFsNative = createRequire(import.meta.url).resolve('@brainstrike/secure-fs-native');
const MARKER = 'brainstrike-factory-reset.json';
const LOCK = 'brainstrike-factory-reset.lock';

const owned: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const child of owned.splice(0)) {
    child.kill('SIGKILL');
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * The Main that asked for the reset, as the OS sees it: a process holding the reset lock (and,
 * for a profile still open elsewhere, that profile's Root lock) until it dies. It answers each
 * line on its stdin with `alive`.
 */
async function previousMain(locks: readonly string[]) {
  const script = `
const { tryExclusiveLock } = require(${JSON.stringify(secureFsNative)});
globalThis.held = process.argv.slice(1).map((file) => {
  const lock = tryExclusiveLock(file);
  if (lock === null) throw new Error('could not lock ' + file);
  return lock;
});
console.log('ready');
process.stdin.on('data', () => console.log('alive'));
`;
  const child = spawn(process.execPath, ['-e', script, ...locks], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  owned.push(child);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  expect((await lines.next()).value).toBe('ready');
  const identity =
    process.platform === 'win32'
      ? {
          creationTime: (
            createRequire(import.meta.url)(
              '@brainstrike/windows-job-native'
            ) as typeof import('@brainstrike/windows-job-native')
          ).getProcessCreationTime(child.pid ?? 0),
          pid: child.pid,
        }
      : undefined;
  return {
    /** A round trip: the process is still running. */
    alive: async () => {
      child.stdin?.write('ping\n');
      expect((await lines.next()).value).toBe('alive');
    },
    exit: async () => {
      child.kill('SIGKILL');
      await once(child, 'exit');
    },
    identity,
  };
}

function seed() {
  const base = mkdtempSync(path.join(tmpdir(), 'brainstrike-reset-relaunch-'));
  directories.push(base);
  const userData = path.join(base, 'user-data');
  // The packaged macOS layout keeps the profile inside userData.
  const profile = path.join(userData, 'data', 'profiles', 'default');
  const otherProfile = path.join(base, 'profiles', 'other');
  const files = {
    chromium: path.join(userData, 'session-data', 'Local Storage', 'leveldb', 'CURRENT'),
    errorLog: path.join(userData, 'logs', 'brainstrike-errors.ndjson'),
    errorLogRotated: path.join(userData, 'logs', 'brainstrike-errors.ndjson.1'),
    log: path.join(userData, 'logs', 'brainstrike.log'),
    mcp: path.join(userData, 'mcp', 'tool-preferences.json'),
    otherProfile: path.join(otherProfile, 'state.db'),
    settings: path.join(userData, 'brainstrike-settings.json'),
    storage: path.join(userData, 'electron-storage.json'),
    threads: path.join(profile, 'state.db'),
    threadsWal: path.join(profile, 'state.db-wal'),
  };
  for (const file of Object.values(files)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'stale');
  }
  mkdirSync(path.join(profile, 'lock'), { recursive: true });
  return { files, logs: path.join(userData, 'logs'), profile, userData };
}

function recordReset(
  userData: string,
  profileRoot: string,
  identity: { readonly creationTime: string | null; readonly pid: number | undefined } | undefined,
  scope: 'all' | 'profile' = 'all'
): void {
  writeFileSync(
    path.join(userData, MARKER),
    JSON.stringify({ profileRoot, scope, ...(identity ? { process: identity } : {}) })
  );
}

it('waits for the Main that asked for the reset to exit, then wipes all but the logs', async () => {
  const { files, logs, profile, userData } = seed();
  const old = await previousMain([path.join(userData, LOCK)]);
  recordReset(userData, profile, old.identity);
  let finished = false;
  const finishing = completePendingFactoryReset({ logsPath: logs, userDataPath: userData }).then(
    () => {
      finished = true;
    }
  );
  await old.alive();
  expect(finished).toBe(false);
  expect(existsSync(files.threads)).toBe(true);

  await old.exit();
  await finishing;

  // Threads, settings, credentials' ledgers, Chromium storage and the diagnostics mirror are gone.
  for (const gone of [
    files.chromium,
    files.errorLog,
    files.errorLogRotated,
    files.mcp,
    files.settings,
    files.storage,
    files.threads,
    files.threadsWal,
  ]) {
    expect(existsSync(gone), gone).toBe(false);
  }
  expect(readdirSync(profile)).toEqual(['lock']);
  // The logs stay, another profile is untouched, and the next start finds nothing to do.
  expect(existsSync(files.log)).toBe(true);
  expect(existsSync(files.otherProfile)).toBe(true);
  expect(readdirSync(userData).sort()).toEqual(['data', LOCK, 'logs'].sort());
  await completePendingFactoryReset({ logsPath: logs, userDataPath: userData });
  expect(existsSync(files.log)).toBe(true);
});

it('the developer database reset wipes the profile and keeps userData', async () => {
  const { files, logs, profile, userData } = seed();
  const old = await previousMain([path.join(userData, LOCK)]);
  recordReset(userData, profile, old.identity, 'profile');
  await old.exit();
  await completePendingFactoryReset({ logsPath: logs, userDataPath: userData });
  expect(readdirSync(profile)).toEqual(['lock']);
  for (const kept of [files.settings, files.storage, files.chromium, files.errorLog, files.log]) {
    expect(existsSync(kept), kept).toBe(true);
  }
  expect(existsSync(path.join(userData, MARKER))).toBe(false);
});

it('refuses to wipe a profile another process has open and keeps the reset for the next start', async () => {
  const { files, logs, profile, userData } = seed();
  const cli = await previousMain([path.join(profile, 'lock', 'root.lock')]);
  recordReset(userData, profile, undefined);
  await expect(
    completePendingFactoryReset({ logsPath: logs, userDataPath: userData })
  ).rejects.toThrow('in use by another Brainstrike process');
  expect(existsSync(files.threads)).toBe(true);
  expect(existsSync(files.settings)).toBe(true);
  expect(existsSync(path.join(userData, MARKER))).toBe(true);

  await cli.exit();
  await completePendingFactoryReset({ logsPath: logs, userDataPath: userData });
  expect(existsSync(files.threads)).toBe(false);
  expect(existsSync(files.settings)).toBe(false);
});

it('starts as usual with no reset recorded, and a second request is refused while one is held', async () => {
  const { files, logs, profile, userData } = seed();
  await completePendingFactoryReset({ logsPath: logs, userDataPath: userData });
  expect(existsSync(files.threads)).toBe(true);
  expect(existsSync(files.settings)).toBe(true);

  const held = requestFactoryReset({ profileRoot: profile, scope: 'all', userDataPath: userData });
  try {
    expect(() =>
      requestFactoryReset({ profileRoot: profile, scope: 'profile', userDataPath: userData })
    ).toThrow('Another Brainstrike process is finishing a factory reset');
    expect(existsSync(path.join(userData, MARKER))).toBe(true);
    // Nothing is deleted until the next start.
    expect(existsSync(files.threads)).toBe(true);
  } finally {
    held.release();
  }
});

// ADR-0031: on Windows the old Main's process handle is the reset's one wait. A lock still held
// after it is another new instance wiping, so this start is refused at once instead of waiting.
it.runIf(process.platform === 'win32')(
  'refuses at once while another new instance holds the reset lock after the old Main exited',
  async () => {
    const { files, logs, profile, userData } = seed();
    const old = await previousMain([]);
    recordReset(userData, profile, old.identity);
    await old.exit();
    const wiping = await previousMain([path.join(userData, LOCK)]);

    await expect(
      completePendingFactoryReset({ logsPath: logs, userDataPath: userData })
    ).rejects.toThrow('Another Brainstrike instance is finishing the factory reset of this data.');
    await wiping.alive();
    expect(existsSync(path.join(userData, MARKER))).toBe(true);
    expect(existsSync(files.threads)).toBe(true);
  }
);
