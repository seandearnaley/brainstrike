// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pauseSpy = vi.fn();
const resumeSpy = vi.fn();
const pushSpy = vi.fn();

const logBufferInstances: Array<{ pause: () => void; resume: () => void; push: () => void }> = [];

vi.mock('@brainstrike/utils', () => ({
  registerBulkOperationPauseCallback: vi.fn(() => vi.fn()),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    addLogListener: vi.fn((listener: (record: unknown) => void) => {
      listener({ level: 'info', msg: 'test' });
      return vi.fn();
    }),
    LogBuffer: class {
      size: number;
      maxArgSize: number;
      pause = pauseSpy;
      resume = resumeSpy;
      push = pushSpy;
      constructor(options: { size: number; maxArgSize: number }) {
        this.size = options.size;
        this.maxArgSize = options.maxArgSize;
        logBufferInstances.push(this);
      }
    },
  };
});

describe('renderer log-buffer', () => {
  beforeEach(() => {
    vi.resetModules();
    pauseSpy.mockClear();
    resumeSpy.mockClear();
    pushSpy.mockClear();
    logBufferInstances.length = 0;
  });

  it('creates a singleton buffer and exposes pause/resume helpers', async () => {
    const module = await import('../../renderer/log-buffer');

    const first = module.getRendererLogBuffer();
    const second = module.getRendererLogBuffer();

    expect(first).toBe(second);
    expect(logBufferInstances.length).toBe(1);
    const firstWithSize = first as unknown as { size: number; maxArgSize: number };
    expect(firstWithSize.size).toBe(500);
    expect(firstWithSize.maxArgSize).toBe(500);

    module.pauseRendererLogBuffer();
    module.resumeRendererLogBuffer();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalled();
    expect(
      (window as typeof window & { __brainstrikeRendererLogBuffer?: unknown })
        .__brainstrikeRendererLogBuffer
    ).toBe(first);
  });
});
