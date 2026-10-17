// @vitest-environment node
import fsPromises from 'node:fs/promises';
import {
  acquireWorkspaceMutationLease,
  disposeLiveChildProcesses,
} from '@brainstrike/host-capabilities/native-tools';
import type { createWindowsCommandProcess } from '@brainstrike/host-capabilities/windows-command-process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runSkillScript } from '../../assistant-server/run-skill-script-tool';
import { singleRootRuntime } from './_tool-test-helpers';

type OwnerOptions = Parameters<typeof createWindowsCommandProcess>[0];
const controls = vi.hoisted(() => ({
  create: vi.fn<typeof createWindowsCommandProcess>(),
  path: vi.fn(() => '/trusted/dist/windows-command-entry.js'),
}));
vi.mock('@brainstrike/host-capabilities/windows-command-process', () => ({
  createWindowsCommandProcess: controls.create,
}));
vi.mock('../../bundled-sibling-path', () => ({ resolveBundledSiblingPath: controls.path }));

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

test('a skill script does not release its real lease when retained retirement rejects', async () => {
  const root = '/windows-skill-retained-failure';
  const failure = new Error('Native Job cleanup denied');
  controls.create.mockImplementation((options) => {
    retained.push(options);
    return { retire: () => Promise.reject(failure), start: () => Promise.reject(failure) };
  });
  const result = runSkillScript(
    {
      cwd: '.',
      root,
      runtime: 'node',
      scriptPath: 'scripts/task.cjs',
      skillName: 'fixture',
    },
    singleRootRuntime(root),
    {
      resolveScriptExecution: async () => ({
        absolutePath: `${root}/skill/scripts/task.cjs`,
        policy: 'matched-allowed-tools',
        scriptPath: 'scripts/task.cjs',
        skillName: 'fixture',
        skillRootPath: `${root}/skill`,
        sourceTier: 'global-claude',
      }),
    }
  );
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
  // Desktop's own bundled wrapper, resolved beside the host bundle.
  expect(controls.path).toHaveBeenCalledWith('Windows command', 'windows-command-entry.js');
});
