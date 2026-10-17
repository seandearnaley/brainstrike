// @vitest-environment node
import fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  acquireWorkspaceMutationLease,
  disposeLiveChildProcesses,
  runDetachedProcess,
  runExecuteCommand,
} from '../src/native-tools/index.js';
import type { createWindowsCommandProcess } from '../src/windows-command-process.js';
import { singleRootRuntime } from './fixtures/execute-command.js';

type OwnerOptions = Parameters<typeof createWindowsCommandProcess>[0];
const controls = vi.hoisted(() => ({
  create: vi.fn<typeof createWindowsCommandProcess>(),
  path: vi.fn(() => '/trusted/dist/windows-command-entry.js'),
}));
vi.mock('../src/windows-command-process.js', () => ({
  createWindowsCommandProcess: controls.create,
}));

const retained: OwnerOptions[] = [];
beforeEach(() => {
  controls.path.mockReset().mockReturnValue('/trusted/dist/windows-command-entry.js');
  controls.create.mockReset();
  const simulatedProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperties(simulatedProcess, {
    env: { value: { BRAINSTRIKE_DISABLE_FILE_LOGS: '1', NODE_ENV: 'test' } },
    platform: { value: 'win32' },
  });
  vi.stubGlobal('process', simulatedProcess);
  vi.spyOn(fsPromises, 'realpath').mockImplementation(async (input) => String(input));
});
afterEach(() => {
  // These controls create no OS processes. Settle only their in-process fixture owners.
  for (const owner of retained.splice(0)) {
    owner.onSettled();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('pre-owner preparation failure releases its transferred workspace lease exactly once', async () => {
  const root = '/windows-command-prepare-failure';
  const release = vi.fn(await acquireWorkspaceMutationLease(root, 'opaque'));
  const preparationFailure = new Error('Trusted wrapper asset identity unavailable');
  controls.path.mockImplementation(() => {
    throw preparationFailure;
  });
  try {
    await expect(
      runDetachedProcess({
        argv: [],
        cwd: root,
        executable: 'cmd.exe',
        releaseWorkspaceLease: release,
        signal: undefined,
        streamer: undefined,
        timeoutMs: 30_000,
        windowsCommandEntry: controls.path,
      })
    ).rejects.toBe(preparationFailure);
    expect(release).toHaveBeenCalledTimes(1);
    const writer = await acquireWorkspaceMutationLease(root, 'files');
    writer();
    expect(controls.create).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

test('a command does not release its real lease when retained retirement rejects', async () => {
  const root = '/windows-command-retained-failure';
  const failure = new Error('Native Job cleanup denied');
  controls.create.mockImplementation((options) => {
    retained.push(options);
    return { retire: () => Promise.reject(failure), start: () => Promise.reject(failure) };
  });
  const result = runExecuteCommand({ command: 'node command.cjs' }, singleRootRuntime(root), {
    windowsCommandEntry: controls.path,
  });
  await expect(result).rejects.toBe(failure);
  await expect(disposeLiveChildProcesses()).rejects.toMatchObject({ errors: [failure] });
  const stopWaiting = new AbortController();
  let admitted = false;
  const waiter = acquireWorkspaceMutationLease(root, 'files', stopWaiting.signal).then(
    (release) => {
      admitted = true;
      release();
    },
    (error: unknown) => error
  );
  await Promise.resolve();
  expect(admitted).toBe(false);
  stopWaiting.abort(failure);
  expect(await waiter).toBe(failure);
  expect(controls.create).toHaveBeenCalledTimes(1);
  // The shell's own wrapper, read once for the one owner.
  expect(controls.path).toHaveBeenCalledTimes(1);
});

test('finite cmd quoting is private to its verbatim boundary; direct argv stays exact', async () => {
  controls.create.mockImplementation((options) => {
    retained.push(options);
    return {
      retire: async () => {},
      start: async () => {
        options.onSettled();
        return { exitCode: 0, signal: null };
      },
    };
  });
  const command = 'node "C:\\workspace with spaces\\task.cjs" "argument with spaces"';
  await runExecuteCommand({ command }, singleRootRuntime('/quoted-command'), {
    windowsCommandEntry: controls.path,
  });
  expect(retained[0]?.command.argv).toEqual(['/d', '/s', '/c', `"${command}"`]);
  expect(retained[0]?.command.windowsVerbatimArguments).toBe(true);
  await runDetachedProcess({
    argv: ['C:\\workspace with spaces\\task.cjs', 'argument with spaces', 'embedded"quote'],
    cwd: '/quoted-skill',
    executable: 'node.exe',
    signal: undefined,
    streamer: undefined,
    timeoutMs: 30_000,
    windowsCommandEntry: controls.path,
  });
  expect(retained[1]?.command.argv).toEqual([
    'C:\\workspace with spaces\\task.cjs',
    'argument with spaces',
    'embedded"quote',
  ]);
  expect(retained[1]?.command.windowsVerbatimArguments).toBe(false);
});
