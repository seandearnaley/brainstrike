// @vitest-environment node
import { ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInteractiveChildFixture } from '../../e2e/utils/interactive-child-fixture';

const environmentKey = 'BRAINSTRIKE_INTERACTIVE_CLEANUP_PROBE';
const previousEnvironment = process.env[environmentKey];
let workspace: string;

function fixture() {
  const ownedProcess = new ChildProcess();
  const window = { title: 'child decision' };
  const exit = () => {
    Object.defineProperty(ownedProcess, 'exitCode', { value: 0 });
    ownedProcess.emit('exit', 0, null);
  };
  const electron = {
    dispose: vi.fn(async () => exit()),
    ensureContext: vi.fn(async () => ({ app: { process: () => ownedProcess } })),
    ensureWindow: vi.fn(async () => window),
  };
  const options = {
    captureFailure: vi.fn(async (_window: typeof window) => {}),
    closeProvider: vi.fn(async () => {}),
    electron,
    environment: { [environmentKey]: 'during scenario' },
    run: vi.fn(async (_window: typeof window) => {}),
    workspace,
  };
  return { exit, options, ownedProcess, window };
}

describe('interactive child fixture ownership', () => {
  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'interactive-cleanup-test-'));
    await writeFile(path.join(workspace, 'evidence.txt'), 'preserve while owned');
    process.env[environmentKey] = 'before scenario';
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
    if (previousEnvironment === undefined) {
      delete process.env[environmentKey];
    } else {
      process.env[environmentKey] = previousEnvironment;
    }
  });

  it('runs the scenario and removes its workspace only after owned process exit', async () => {
    const { options, window } = fixture();
    options.run.mockImplementation(async () => {
      expect(process.env[environmentKey]).toBe('during scenario');
      await expect(access(workspace)).resolves.toBeUndefined();
    });
    await runInteractiveChildFixture(options);
    expect(options.run).toHaveBeenCalledExactlyOnceWith(window);
    expect(options.captureFailure).not.toHaveBeenCalled();
    expect(options.electron.dispose).toHaveBeenCalledTimes(1);
    expect(options.closeProvider).toHaveBeenCalledTimes(1);
    expect(process.env[environmentKey]).toBe('before scenario');
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rethrows the original assertion unchanged when diagnostics and cleanup succeed', async () => {
    const { options } = fixture();
    const assertion = new Error('wrong child decision');
    options.run.mockRejectedValue(assertion);
    await expect(runInteractiveChildFixture(options)).rejects.toBe(assertion);
    expect(options.captureFailure).toHaveBeenCalledTimes(1);
    expect(options.closeProvider).toHaveBeenCalledTimes(1);
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['body extraction', 'attachment'])(
    'preserves the assertion when %s fails',
    async (phase) => {
      const { options } = fixture();
      const assertion = new Error('wrong child decision');
      const diagnostic = new Error(`${phase} failed`);
      options.run.mockRejectedValue(assertion);
      options.captureFailure.mockRejectedValue(diagnostic);
      const result = await runInteractiveChildFixture(options).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([assertion, diagnostic]);
      expect(options.closeProvider).toHaveBeenCalledTimes(1);
      expect(process.env[environmentKey]).toBe('before scenario');
      await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('preserves every error and finishes cleanup after failed disposal of an exited process', async () => {
    const { options, exit } = fixture();
    const assertion = new Error('wrong child decision');
    const diagnostic = new Error('attachment failed');
    const disposal = new Error('Electron disposal failed');
    const provider = new Error('provider close failed');
    options.run.mockRejectedValue(assertion);
    options.captureFailure.mockRejectedValue(diagnostic);
    options.electron.dispose.mockImplementation(async () => {
      exit();
      throw disposal;
    });
    options.closeProvider.mockRejectedValue(provider);
    const result = await runInteractiveChildFixture(options).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([assertion, diagnostic, disposal, provider]);
    expect(options.closeProvider).toHaveBeenCalledTimes(1);
    expect(process.env[environmentKey]).toBe('before scenario');
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes an environment override that was previously absent even when provider close fails', async () => {
    delete process.env[environmentKey];
    const { options } = fixture();
    const provider = new Error('provider close failed');
    options.closeProvider.mockRejectedValue(provider);
    await expect(runInteractiveChildFixture(options)).rejects.toBe(provider);
    expect(process.env[environmentKey]).toBeUndefined();
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains workspace evidence when launch fails before its process can be identified', async () => {
    const { options } = fixture();
    const launch = new Error('launch failed');
    options.electron.ensureContext.mockRejectedValue(launch);
    const result = await runInteractiveChildFixture(options).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(launch);
    expect(String((result as AggregateError).errors[1])).toContain(workspace);
    expect(options.closeProvider).toHaveBeenCalledTimes(1);
    expect(process.env[environmentKey]).toBe('before scenario');
    await expect(access(workspace)).resolves.toBeUndefined();
  });

  it('retains the workspace when disposal returns before the process has exited', async () => {
    // ElectronHarness.dispose resolves only after the exit; a disposal that breaks that is loud.
    const { options, exit } = fixture();
    options.electron.dispose.mockImplementation(async () => {
      setImmediate(exit);
    });
    await expect(runInteractiveChildFixture(options)).rejects.toThrow(
      `Electron exit is unconfirmed; retained interactive fixture workspace: ${workspace}`
    );
    expect(options.closeProvider).toHaveBeenCalledTimes(1);
    expect(process.env[environmentKey]).toBe('before scenario');
    await expect(access(workspace)).resolves.toBeUndefined();
  });

  it('reports abnormal exit even when disposal succeeds and releases the reaped workspace', async () => {
    const { options, ownedProcess } = fixture();
    options.electron.dispose.mockImplementation(async () => {
      Object.defineProperty(ownedProcess, 'signalCode', { value: 'SIGKILL' });
      ownedProcess.emit('exit', null, 'SIGKILL');
    });
    await expect(runInteractiveChildFixture(options)).rejects.toThrow('code=null, signal=SIGKILL');
    expect(options.closeProvider).toHaveBeenCalledTimes(1);
    expect(process.env[environmentKey]).toBe('before scenario');
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the workspace for an unreaped process while restoring environment and closing the provider', async () => {
    const { options, ownedProcess } = fixture();
    const disposal = new Error('Electron disposal failed');
    // A sent signal is not proof of exit.
    Object.defineProperty(ownedProcess, 'killed', { value: true });
    options.electron.dispose.mockRejectedValue(disposal);
    const result = await runInteractiveChildFixture(options).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      disposal,
      expect.objectContaining({ message: expect.stringContaining(workspace) }),
    ]);
    expect(options.closeProvider).toHaveBeenCalledTimes(1);
    expect(process.env[environmentKey]).toBe('before scenario');
    await expect(access(workspace)).resolves.toBeUndefined();
  });
});
