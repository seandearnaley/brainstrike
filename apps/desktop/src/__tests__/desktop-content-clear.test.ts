import { describe, expect, it, vi } from 'vitest';
import {
  type CreateDesktopContentClearOptions,
  createDesktopContentClear,
} from '../desktop-content-clear';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function contentClear(overrides: Partial<CreateDesktopContentClearOptions> = {}) {
  const steps: string[] = [];
  const options: CreateDesktopContentClearOptions = {
    clearRetainedContent: vi.fn(async () => {
      steps.push('clear');
      return { deletedChunks: 3, deletedFiles: 2 };
    }),
    completeSuccessfulClear: vi.fn(async () => {
      steps.push('replace-renderer');
    }),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    resumeAfterClear: vi.fn(async (outcome: 'failed' | 'succeeded') => {
      steps.push(`resume:${outcome}`);
    }),
    runTransition: (work) => work(),
    runtimes: [
      {
        name: 'embedding-host',
        stop: vi.fn(async () => {
          steps.push('stop');
        }),
      },
    ],
    ...overrides,
  };
  return { clear: createDesktopContentClear(options), options, steps };
}

describe('createDesktopContentClear', () => {
  it('stops runtimes, clears, replaces the renderer and only then reopens', async () => {
    const { clear, steps } = contentClear();
    await expect(clear.clear()).resolves.toEqual({
      deletedChunks: 3,
      deletedFiles: 2,
      success: true,
    });
    expect(steps).toEqual(['stop', 'clear', 'replace-renderer', 'resume:succeeded']);
  });

  it('joins a duplicate clear and is idle only after the reopen', async () => {
    const reopened = deferred<void>();
    const reopening = deferred<void>();
    const { clear, options } = contentClear({
      resumeAfterClear: vi.fn(() => {
        reopening.resolve();
        return reopened.promise;
      }),
    });
    const first = clear.clear();
    expect(clear.clear()).toBe(first);
    expect(clear.inFlight()).toBe(first);
    let idle = false;
    const idling = clear.idle().then(() => {
      idle = true;
    });
    await reopening.promise;
    expect(idle).toBe(false);
    reopened.resolve();
    await idling;
    await expect(first).resolves.toMatchObject({ success: true });
    expect(options.clearRetainedContent).toHaveBeenCalledTimes(1);
    expect(clear.inFlight()).toBeNull();
  });

  it('reports a failed clear, reopens what it retired, and allows another attempt', async () => {
    const { clear, options, steps } = contentClear({
      clearRetainedContent: vi
        .fn<CreateDesktopContentClearOptions['clearRetainedContent']>()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValueOnce({ deletedChunks: null, deletedFiles: 0 }),
    });
    await expect(clear.clear()).resolves.toEqual({ message: 'disk full', success: false });
    expect(steps).toEqual(['stop', 'resume:failed']);
    expect(options.completeSuccessfulClear).not.toHaveBeenCalled();
    expect(options.logger.error).toHaveBeenCalledWith(
      'Failed to clear desktop content:',
      new Error('disk full')
    );
    await expect(clear.clear()).resolves.toMatchObject({ success: true });
  });

  it('keeps both the clear and the reopen failure', async () => {
    const { clear } = contentClear({
      clearRetainedContent: vi.fn(async () => {
        throw new Error('disk full');
      }),
      resumeAfterClear: vi.fn(async () => {
        throw new Error('host refused');
      }),
    });
    await expect(clear.clear()).resolves.toEqual({
      message: 'disk full; content clear runtime resume failed: host refused',
      success: false,
    });
  });

  it('leaves admission closed when the renderer replacement fails after the clear', async () => {
    const { clear, options } = contentClear({
      completeSuccessfulClear: vi.fn(async () => {
        throw new Error('renderer never became ready');
      }),
    });
    await expect(clear.clear()).resolves.toEqual({
      message: 'renderer never became ready',
      success: false,
    });
    expect(options.resumeAfterClear).not.toHaveBeenCalled();
  });

  it('touches nothing when the transition queue refuses it', async () => {
    const { clear, options } = contentClear({
      runTransition: () => Promise.reject(new Error('transition refused')),
    });
    await expect(clear.clear()).rejects.toThrow('transition refused');
    expect(options.runtimes[0]?.stop).not.toHaveBeenCalled();
    expect(options.clearRetainedContent).not.toHaveBeenCalled();
  });

  it('quit joins an accepted clear, cancels the reopen, and refuses later clears', async () => {
    const cleared = deferred<{ deletedChunks: number | null; deletedFiles: number }>();
    const { clear, options } = contentClear({ clearRetainedContent: () => cleared.promise });
    const accepted = clear.clear();
    expect(options.runtimes[0]?.stop).toHaveBeenCalled();
    const closing = clear.close();
    cleared.resolve({ deletedChunks: 1, deletedFiles: 1 });
    await closing;
    await expect(accepted).resolves.toMatchObject({ success: true });
    expect(options.completeSuccessfulClear).not.toHaveBeenCalled();
    expect(options.resumeAfterClear).not.toHaveBeenCalled();
    await expect(clear.clear()).resolves.toEqual({
      message: 'The app is quitting: the content clear did not start.',
      success: false,
    });
  });
});
