import { describe, expect, it } from 'vitest';
import { OFFICIAL_AUTH_CONFORMANCE_PROFILES } from '../official-auth-conformance.js';

describe('official auth conformance authority', () => {
  it('keeps step and job timeouts above each profile worst case', () => {
    for (const descriptor of Object.values(OFFICIAL_AUTH_CONFORMANCE_PROFILES)) {
      const protocolScenarioCounts = Object.values(descriptor.scenariosByProtocol).map(
        (scenarios) => scenarios.length
      );
      const deadlineCount =
        descriptor.execution === 'sequential'
          ? protocolScenarioCounts.reduce((total, count) => total + count, 0)
          : protocolScenarioCounts.length;
      const requiredStepMs =
        deadlineCount * descriptor.scenarioDeadlineMs + descriptor.runnerOverheadMs;
      expect(descriptor.stepTimeoutMinutes * 60_000).toBeGreaterThanOrEqual(requiredStepMs);
      expect(descriptor.jobTimeoutMinutes).toBeGreaterThanOrEqual(
        descriptor.buildTimeoutMinutes +
          descriptor.provisionTimeoutMinutes +
          descriptor.stepTimeoutMinutes +
          descriptor.workflowOverheadMinutes
      );
    }
  });
});
