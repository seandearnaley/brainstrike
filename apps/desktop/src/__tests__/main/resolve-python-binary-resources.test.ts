import { ChildProcess } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_CONTENT,
  createFixtureDirs as createPythonFixture,
  plantUnpackedRuntime,
  writeArchive,
  writeManifest,
} from './python-runtime-test-fixtures';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** `execFileAsync` may call the mock with or without an options bag. */
function lastCallback(optionsOrCallback: unknown, maybeCallback: unknown): ExecFileCallback {
  return (
    typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
  ) as ExecFileCallback;
}

const execFileMock = vi.hoisted(() =>
  vi.fn((_command: string, _args: readonly string[], ...rest: unknown[]) => {
    const callback = rest.at(-1) as ExecFileCallback;
    callback(null, '', '');
  })
);

const readStreamMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  const createReadStream = (...args: Parameters<typeof mod.createReadStream>) =>
    readStreamMock(...args) ?? mod.createReadStream(...args);
  return { ...mod, createReadStream, default: { ...mod, createReadStream } };
});

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    command: string,
    args: readonly string[],
    options: unknown,
    callback: ExecFileCallback
  ) => {
    const child = new mod.ChildProcess();
    const returned: unknown = execFileMock(
      command,
      args,
      options,
      (error: Error | null, stdout: string, stderr: string) => {
        callback(error, stdout, stderr);
        queueMicrotask(() => child.emit('close', error ? 1 : 0, null));
      }
    );
    return returned instanceof mod.ChildProcess ? returned : child;
  };
  return { ...mod, default: { ...mod, execFile }, execFile };
});

const cleanupPaths: string[] = [];
const createFixtureDirs = (): Promise<{ resourcesDir: string; userDataDir: string }> =>
  createPythonFixture(cleanupPaths);

function mockTarSuccess(): void {
  execFileMock.mockImplementation(
    (_command: string, args: readonly string[], ...rest: unknown[]) => {
      const destinationIndex = args.indexOf('-C') + 1;
      plantUnpackedRuntime(args[destinationIndex] as string);
      lastCallback(rest[0], rest[1])(null, '', '');
    }
  );
}

async function loadModule() {
  return await import('../../python-runtime/resolve-python-binary');
}

describe('resolvePythonBinary resource lifetimes', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    readStreamMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => fsPromises.rm(target, { force: true, recursive: true }))
    );
  });

  it('destroys an interrupted hash stream and joins its close before rejecting', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const stream = new Readable({ emitClose: false, read() {} });
    readStreamMock.mockReturnValue(stream);
    const controller = new AbortController();
    const reason = new Error('hash interrupted');
    const { resolvePythonBinary } = await loadModule();
    let settled = false;
    const outcome = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      signal: controller.signal,
      userDataDir,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(readStreamMock).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(stream.destroyed).toBe(true);
      expect(settled).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      stream.emit('close');
      stream.emit('end');
    }
    await expect(outcome).resolves.toBe(reason);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
  });

  it('joins tar close after an abort callback before deleting staging or rejecting', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const controller = new AbortController();
    const child = new ChildProcess();
    const removeStaging = vi.spyOn(fsPromises, 'rm');
    let stagingDir = '';
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    execFileMock.mockImplementation(
      (_command: string, args: readonly string[], ...rest: unknown[]) => {
        stagingDir = args[args.indexOf('-C') + 1] as string;
        controller.signal.addEventListener(
          'abort',
          () => lastCallback(rest[0], rest[1])(abortError, '', ''),
          { once: true }
        );
        started();
        return child;
      }
    );
    const { resolvePythonBinary } = await loadModule();
    let settled = false;
    const outcome = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      signal: controller.signal,
      userDataDir,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await childStarted;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(removeStaging.mock.calls.filter(([target]) => target === stagingDir)).toHaveLength(1);
      expect(settled).toBe(false);
      await expect(fsPromises.stat(stagingDir)).resolves.toBeDefined();
    } finally {
      child.emit('close', null, 'SIGTERM');
      removeStaging.mockRestore();
    }
    await expect(outcome).resolves.toBe(abortError);
    await expect(fsPromises.stat(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a hash read error while joining descriptor close and removing listeners', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const stream = new Readable({ emitClose: false, read() {} });
    readStreamMock.mockReturnValue(stream);
    const readError = new Error('archive read failed');
    const { resolvePythonBinary } = await loadModule();
    let settled = false;
    const outcome = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      userDataDir,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(readStreamMock).toHaveBeenCalledTimes(1));
    stream.emit('error', readError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(stream.destroyed).toBe(true);
      expect(settled).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      stream.emit('close');
    }
    await expect(outcome).resolves.toBe(readError);
    expect(stream.eventNames()).toEqual([]);
  });

  it('does not begin extraction until a successful hash stream closes', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const stream = new Readable({ emitClose: false, read() {} });
    readStreamMock.mockReturnValue(stream);
    const { resolvePythonBinary } = await loadModule();
    const attempt = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      userDataDir,
    });
    await vi.waitFor(() => expect(readStreamMock).toHaveBeenCalledTimes(1));
    stream.push(ARCHIVE_CONTENT);
    stream.push(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      stream.emit('close');
    }
    await expect(attempt).resolves.toContain('python3');
    expect(stream.eventNames()).toEqual([]);
  });

  it('cleans partially created staging directories after mkdir fails and preserves its error', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const mkdirError = new Error('partial mkdir failure');
    const originalMkdir = fsPromises.mkdir;
    let stagingDir = '';
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir').mockImplementation(async (target, options) => {
      if (String(target).includes('.staging-')) {
        stagingDir = String(target);
        await originalMkdir(target, options);
        throw mkdirError;
      }
      return await originalMkdir(target, options);
    });
    try {
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toBe(mkdirError);
      await expect(fsPromises.stat(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it('waits for an unabortable mkdir before cancelling and removing staging', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const originalMkdir = fsPromises.mkdir;
    const controller = new AbortController();
    const reason = new Error('cancel staging acquisition');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stagingDir = '';
    const removeSpy = vi.spyOn(fsPromises, 'rm');
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir').mockImplementation(async (target, options) => {
      stagingDir = String(target);
      await originalMkdir(target, options);
      started();
      await held;
      return;
    });
    const { resolvePythonBinary } = await loadModule();
    let settled = false;
    const outcome = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      signal: controller.signal,
      userDataDir,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await startedPromise;
    controller.abort(reason);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(removeSpy.mock.calls.filter(([target]) => target === stagingDir)).toHaveLength(1);
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      release();
      await outcome;
      mkdirSpy.mockRestore();
      removeSpy.mockRestore();
    }
    await expect(outcome).resolves.toBe(reason);
    await expect(fsPromises.stat(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('joins an unabortable rename and preserves a successfully committed install after late abort', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const originalRename = fsPromises.rename;
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stagingDir = '';
    const removeSpy = vi.spyOn(fsPromises, 'rm');
    const renameSpy = vi
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (oldPath, newPath) => {
        stagingDir = String(oldPath);
        started();
        await held;
        await originalRename(oldPath, newPath);
      });
    const { resolvePythonBinary } = await loadModule();
    let settled = false;
    const attempt = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      signal: controller.signal,
      userDataDir,
    }).then((value) => {
      settled = true;
      return value;
    });
    await startedPromise;
    controller.abort();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(removeSpy.mock.calls.filter(([target]) => target === stagingDir)).toHaveLength(1);
    } finally {
      release();
      await attempt;
      renameSpy.mockRestore();
      removeSpy.mockRestore();
    }
    const binary = await attempt;
    await expect(fsPromises.access(binary)).resolves.toBeUndefined();
    await expect(fsPromises.stat(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).resolves.toBe(binary);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a cleanup-only failure as PythonUnpackFailedError with its cause', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const cleanupError = new Error('staging removal denied');
    const originalRemove = fsPromises.rm;
    let stagingRemovals = 0;
    const removeSpy = vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('.staging-') && ++stagingRemovals === 2) {
        throw cleanupError;
      }
      await originalRemove(target, options);
    });
    try {
      const { resolvePythonBinary, PythonUnpackFailedError } = await loadModule();
      const error = await resolvePythonBinary({
        arch: 'arm64',
        platform: 'darwin',
        resourcesDir,
        userDataDir,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(PythonUnpackFailedError);
      expect(error).toMatchObject({ cause: cleanupError, code: 'python_unpack_failed' });
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('preserves the primary failure and logs secondary staging cleanup through the real logger', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const primaryError = new Error('mkdir failed');
    const cleanupError = new Error('cleanup failed');
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir').mockRejectedValue(primaryError);
    const originalRemove = fsPromises.rm;
    let stagingRemovals = 0;
    const removeSpy = vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('.staging-') && ++stagingRemovals === 2) {
        throw cleanupError;
      }
      await originalRemove(target, options);
    });
    const { resolvePythonBinary } = await loadModule();
    const { addLogListener } = await import('@brainstrike/logging');
    const records: string[] = [];
    const removeLogListener = addLogListener((record) => records.push(JSON.stringify(record)));
    try {
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toBe(primaryError);
      const cleanupRecords = records.filter((record) =>
        record.includes('Bundled Python staging cleanup failed')
      );
      expect(cleanupRecords).toHaveLength(1);
      expect(cleanupRecords[0]).toContain('cleanup failed');
      expect(cleanupRecords[0]).not.toContain('mkdir failed');
    } finally {
      removeLogListener();
      mkdirSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('keeps the first caller signal as owner of a coalesced resolution', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const stream = new Readable({ read() {} });
    readStreamMock.mockReturnValue(stream);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const { resolvePythonBinary } = await loadModule();
    const options = { arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir };
    const first = resolvePythonBinary({ ...options, signal: firstController.signal });
    const second = resolvePythonBinary({ ...options, signal: secondController.signal });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(readStreamMock).toHaveBeenCalledTimes(1));
    secondController.abort();
    expect(stream.destroyed).toBe(false);
    stream.push(ARCHIVE_CONTENT);
    stream.push(null);
    await expect(first).resolves.toContain('python3');
  });

  it('observes an abort that occurs while the hash stream is acquired', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const stream = new Readable({ read() {} });
    const controller = new AbortController();
    const reason = new Error('abort at hash acquisition');
    readStreamMock.mockImplementation(() => {
      controller.abort(reason);
      return stream;
    });
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({
        arch: 'arm64',
        platform: 'darwin',
        resourcesDir,
        signal: controller.signal,
        userDataDir,
      })
    ).rejects.toBe(reason);
    expect(stream.destroyed).toBe(true);
    expect(stream.eventNames()).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects both coalesced callers when their first caller aborts hashing', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const stream = new Readable({ read() {} });
    readStreamMock.mockReturnValue(stream);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const reason = new Error('first caller stopped');
    const { resolvePythonBinary } = await loadModule();
    const options = { arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir };
    const first = resolvePythonBinary({ ...options, signal: firstController.signal });
    const second = resolvePythonBinary({ ...options, signal: secondController.signal });
    const outcomes = Promise.allSettled([first, second]);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(readStreamMock).toHaveBeenCalledTimes(1));
    firstController.abort(reason);
    expect(secondController.signal.aborted).toBe(false);
    await expect(outcomes).resolves.toEqual([
      { reason, status: 'rejected' },
      { reason, status: 'rejected' },
    ]);
    expect(stream.destroyed).toBe(true);
    expect(stream.eventNames()).toEqual([]);
  });

  it('joins successful tar close before checking or publishing its staged files', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const child = new ChildProcess();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stagingDir = '';
    execFileMock.mockImplementation(
      (_command: string, args: readonly string[], ...rest: unknown[]) => {
        stagingDir = args[args.indexOf('-C') + 1] as string;
        plantUnpackedRuntime(stagingDir);
        lastCallback(rest[0], rest[1])(null, '', '');
        started();
        return child;
      }
    );
    const { resolvePythonBinary } = await loadModule();
    let settled = false;
    const attempt = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      userDataDir,
    }).then((value) => {
      settled = true;
      return value;
    });
    await startedPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(settled).toBe(false);
      await expect(
        fsPromises.stat(path.join(stagingDir, '.brainstrike-python-runtime-ok'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      child.emit('close', 0, null);
    }
    await expect(attempt).resolves.toContain('python3');
    expect(child.eventNames()).toEqual([]);
  });
});
