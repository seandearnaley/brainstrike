/**
 * BST-2250: every Windows git command runs under a `windows-job-native` Job,
 * and its retirement ends in `CommandJob.terminateAndWait()`, an N-API
 * AsyncWorker built with C++ exceptions. One still on the libuv pool when
 * Electron frees Main's Node environment throws an uncaught `Napi::Error`
 * and terminates Main. The live-command owner must fence new commands and
 * join every live one before the graceful shutdown lets Main quit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeCommand {
  readonly joined: PromiseWithResolvers<void>;
  readonly retire: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const commandProcess = vi.hoisted(() => ({
  create: vi.fn(),
  instances: [] as FakeCommand[],
}));

vi.mock('../assistant-server/windows-command-process', () => ({
  createWindowsCommandProcess: commandProcess.create,
}));
vi.mock('../bundled-sibling-path', () => ({
  resolveBundledSiblingPath: () => '/bundle/windows-command-entry.js',
}));

beforeEach(() => {
  vi.resetModules();
  commandProcess.instances.length = 0;
  commandProcess.create.mockReset();
  commandProcess.create.mockImplementation((options: { onSettled: () => void }) => {
    const result = Promise.withResolvers<{ exitCode: number | null; signal: null }>();
    const joined = Promise.withResolvers<void>();
    let retirement: Promise<void> | undefined;
    const retire = vi.fn(() => {
      // The real owner terminates the Job, then settles only after the native join.
      retirement ??= joined.promise.then(() => {
        options.onSettled();
        result.reject(new Error('Windows command was retired.'));
      });
      return retirement;
    });
    commandProcess.instances.push({ joined, retire });
    return { retire, start: () => result.promise };
  });
});

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function trackSettlement<T>(promise: Promise<T>): {
  readonly promise: Promise<T>;
  readonly settled: () => boolean;
} {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return { promise, settled: () => settled };
}

async function loadOwner() {
  return await import('../git-command-windows');
}

const STATUS = { args: ['status'], cwd: 'C:\\repo', env: {}, timeoutMs: 0 } as const;

describe('Windows git command shutdown join (BST-2250)', () => {
  it('retires every live command and resolves only after its native Job join', async () => {
    const owner = await loadOwner();
    const running = owner.runWindowsGitCommand(STATUS);
    expect(commandProcess.instances).toHaveLength(1);
    const command = commandProcess.instances[0] as FakeCommand;

    const disposing = trackSettlement(owner.disposeLiveWindowsGitCommands());
    await flushMacrotask();
    expect(command.retire).toHaveBeenCalledOnce();
    expect(disposing.settled()).toBe(false);

    command.joined.resolve();
    await expect(disposing.promise).resolves.toBe(1);
    await expect(running).resolves.toMatchObject({ exitCode: null });
  });

  it('admits no command once the dispose has begun', async () => {
    const owner = await loadOwner();
    const disposing = owner.disposeLiveWindowsGitCommands();

    await expect(owner.runWindowsGitCommand(STATUS)).rejects.toThrow(
      'Windows git commands are shut down.'
    );
    expect(commandProcess.create).not.toHaveBeenCalled();
    await expect(disposing).resolves.toBe(0);
  });

  it('rejects with a failed native join after every other retirement settles', async () => {
    const owner = await loadOwner();
    const failing = owner.runWindowsGitCommand(STATUS);
    const healthy = owner.runWindowsGitCommand(STATUS);
    const [first, second] = commandProcess.instances as [FakeCommand, FakeCommand];
    const failure = new Error('TerminateJobObject failed');
    first.retire.mockReturnValueOnce(Promise.reject(failure));

    const disposing = trackSettlement(owner.disposeLiveWindowsGitCommands());
    await flushMacrotask();
    expect(disposing.settled()).toBe(false);

    second.joined.resolve();
    await expect(disposing.promise).rejects.toMatchObject({ errors: [failure] });
    await expect(healthy).resolves.toMatchObject({ exitCode: null });
    // The failed join is retained: its command never reports a result.
    expect(trackSettlement(failing).settled()).toBe(false);
  });
});
