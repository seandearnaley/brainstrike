import { captureConsoleError, REACT_ACT_WARNING_PROBE } from '@brainstrike/test-utils';
import { afterAll, describe, expect, it, vi } from 'vitest';

const consoleErrorProbe = captureConsoleError();

vi.resetModules();
await import('../../vitest.setup');

afterAll(() => {
  consoleErrorProbe.restore();
});

describe('app-shell Vitest setup observability', () => {
  it('forwards React act warnings to console.error', () => {
    consoleErrorProbe.clear();

    console.error(REACT_ACT_WARNING_PROBE);

    expect(consoleErrorProbe.calls).toContainEqual([REACT_ACT_WARNING_PROBE]);
  });
});
