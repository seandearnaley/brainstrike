import { beforeEach, describe, expect, it, vi } from 'vitest';

const pauseSpy = vi.fn();
const resumeSpy = vi.fn();
const pushSpy = vi.fn();
const logBufferInstances: Array<{ pause: () => void; resume: () => void; push: () => void }> = [];

vi.mock('@brainstrike/logging', () => ({
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
}));

vi.mock('@brainstrike/utils/bulk-operation-context', () => ({
  registerBulkOperationPauseCallback: vi.fn(() => vi.fn()),
}));

describe('web log-buffer', () => {
  beforeEach(() => {
    vi.resetModules();
    pauseSpy.mockClear();
    resumeSpy.mockClear();
    pushSpy.mockClear();
    logBufferInstances.length = 0;
  });

  it('creates a singleton buffer and exposes pause/resume helpers', async () => {
    const module = await import('../log-buffer');

    const first = module.getWebLogBuffer();
    const second = module.getWebLogBuffer();

    expect(first).toBe(second);
    expect(logBufferInstances.length).toBe(1);
    const firstWithSize = first as unknown as { size: number; maxArgSize: number };
    expect(firstWithSize.size).toBe(500);
    expect(firstWithSize.maxArgSize).toBe(500);

    module.pauseWebLogBuffer();
    module.resumeWebLogBuffer();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalled();
  });
});
