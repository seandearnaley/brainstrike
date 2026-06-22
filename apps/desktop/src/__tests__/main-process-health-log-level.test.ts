import { describe, expect, it } from 'vitest';
import { isMainProcessHealthDegraded } from '../main-process-health-log-level';

describe('isMainProcessHealthDegraded', () => {
  it('does not treat routine indexing CPU load as degraded health when loop lag is healthy', () => {
    expect(
      isMainProcessHealthDegraded({
        loopLagMaxMs: 86.6,
        loopLagP99Ms: 55.4,
      })
    ).toBe(false);
  });

  it('treats high p99 or max event-loop lag as degraded health', () => {
    expect(isMainProcessHealthDegraded({ loopLagMaxMs: 90, loopLagP99Ms: 101 })).toBe(true);
    expect(isMainProcessHealthDegraded({ loopLagMaxMs: 501, loopLagP99Ms: 50 })).toBe(true);
  });
});
