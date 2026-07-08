import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warnCycleOnce } from '../lib/cycle-warning';

describe('warnCycleOnce', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('warns once per node in non-production mode', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const warned = new Set<string>();

    warnCycleOnce({
      nodeId: 'node-1',
      warnedNodeIds: warned,
      warningMessage: 'cycle detected',
    });
    warnCycleOnce({
      nodeId: 'node-1',
      warnedNodeIds: warned,
      warningMessage: 'cycle detected',
    });

    expect(warned.has('node-1')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('stops warning when maxWarnings is reached', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const warned = new Set<string>(['existing']);

    warnCycleOnce({
      maxWarnings: 1,
      nodeId: 'node-2',
      warnedNodeIds: warned,
      warningMessage: 'cycle detected',
    });

    expect(warned.has('node-2')).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn in production mode', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warned = new Set<string>();

    warnCycleOnce({
      nodeId: 'node-3',
      warnedNodeIds: warned,
      warningMessage: 'cycle detected',
    });

    expect(warned.size).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
