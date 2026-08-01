import { afterAll, describe, expect, it, vi } from 'vitest';
import { captureConsoleError, REACT_ACT_WARNING_PROBE } from '../src/console-error-probe';

const consoleErrorProbe = captureConsoleError();

vi.resetModules();
await import('../src/vitest.setup');

afterAll(() => {
  consoleErrorProbe.restore();
});

describe('Vitest setup console observability', () => {
  it('forwards React act warnings to console.error', () => {
    consoleErrorProbe.clear();

    console.error(REACT_ACT_WARNING_PROBE);

    expect(consoleErrorProbe.calls).toContainEqual([REACT_ACT_WARNING_PROBE]);
  });
});
