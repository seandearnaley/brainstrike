import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

describe('queue-cli smoke tests', () => {
  beforeEach(() => {
    vi.resetModules();
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
  });

  it('prints help and exits gracefully when no command is provided', async () => {
    const exitCalls: number[] = [];
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0);
      if ((code ?? 0) === 0) {
        throw new Error('help exit');
      }
      return undefined as never;
    }) as never);
    const logMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.argv = ['node', 'queue-cli'];

    const createPGlite = vi.fn();
    vi.doMock('../src/wasm-loader.js', () => ({
      wasmLoader: {
        createPGlite,
      },
    }));
    vi.doMock('../src/queue/job-queue.js', () => ({
      JobQueue: vi.fn().mockReturnValue({
        getQueueStats: vi.fn(),
        requeueFailed: vi.fn(),
        clear: vi.fn(),
        prune: vi.fn(),
      }),
    }));

    await import('../src/cli/queue-cli.ts');

    await vi.waitFor(() => {
      expect(exitMock).toHaveBeenCalledWith(0);
    });
    expect(exitCalls[0]).toBe(0);
    expect(createPGlite).not.toHaveBeenCalled();
    expect(
      logMock.mock.calls.some(
        ([chunk]) =>
          typeof chunk === 'string' &&
          chunk.includes('Usage: queue-cli <stats|requeue|clear|prune>')
      )
    ).toBe(true);
  });

  it('executes stats command against the job queue', async () => {
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`unexpected exit ${code ?? 0}`);
    }) as never);
    const logMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    process.argv = ['node', 'queue-cli', 'stats', '--queue', 'embeddings'];

    const statsPayload = { queued: 2, running: 1 };
    const getQueueStats = vi.fn().mockResolvedValue(statsPayload);
    const createPGlite = vi.fn().mockResolvedValue({ database: 'memory://' });

    vi.doMock('../src/wasm-loader.js', () => ({
      wasmLoader: { createPGlite },
    }));
    const JobQueueMock = vi.fn().mockImplementation(() => ({
      getQueueStats,
      requeueFailed: vi.fn(),
      clear: vi.fn(),
      prune: vi.fn(),
    }));
    vi.doMock('../src/queue/job-queue.js', () => ({
      JobQueue: JobQueueMock,
    }));

    await import('../src/cli/queue-cli.ts');

    await vi.waitFor(async () => {
      expect(createPGlite).toHaveBeenCalledWith('memory://');
      expect(JobQueueMock).toHaveBeenCalledTimes(1);
      expect(getQueueStats).toHaveBeenCalledWith('embeddings');
      const expectedStatsPayload = JSON.stringify(
        { queue: 'embeddings', stats: statsPayload },
        null,
        2
      );
      expect(
        logMock.mock.calls.some(
          ([chunk]) => typeof chunk === 'string' && chunk.includes(expectedStatsPayload)
        )
      ).toBe(true);
    });

    expect(exitMock).not.toHaveBeenCalled();
  });
});
