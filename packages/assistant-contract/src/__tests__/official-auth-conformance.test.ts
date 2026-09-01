import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_AUTH_CONFORMANCE_PROFILES,
  OFFICIAL_AUTH_SCENARIOS_BY_PROTOCOL,
} from '../official-auth-conformance.js';

const BASELINE_SCENARIOS = [
  'auth/metadata-default',
  'auth/metadata-var1',
  'auth/metadata-var2',
  'auth/metadata-var3',
  'auth/basic-cimd',
  'auth/scope-from-www-authenticate',
  'auth/scope-from-scopes-supported',
  'auth/scope-omitted-when-undefined',
  'auth/scope-step-up',
  'auth/scope-retry-limit',
  'auth/token-endpoint-auth-basic',
  'auth/token-endpoint-auth-post',
  'auth/token-endpoint-auth-none',
  'auth/pre-registration',
] as const;

const MODERN_CLOSEOUT_SCENARIOS = [
  'auth/resource-mismatch',
  'auth/offline-access-scope',
  'auth/offline-access-not-supported',
  'auth/authorization-server-migration',
  'auth/iss-supported',
  'auth/iss-not-advertised',
  'auth/iss-supported-missing',
  'auth/iss-wrong-issuer',
  'auth/iss-unexpected',
  'auth/iss-normalized',
  'auth/metadata-issuer-mismatch',
] as const;

describe('official auth conformance authority', () => {
  it('pins the independent protocol manifests and modern-only delta', () => {
    expect(OFFICIAL_AUTH_SCENARIOS_BY_PROTOCOL).toEqual({
      '2025-11-25': BASELINE_SCENARIOS,
      '2026-07-28': [...BASELINE_SCENARIOS, ...MODERN_CLOSEOUT_SCENARIOS],
    });
  });

  it('owns every profile-specific execution and evidence decision', () => {
    expect(OFFICIAL_AUTH_CONFORMANCE_PROFILES).toEqual({
      baseline: {
        buildTimeoutMinutes: 4,
        evidencePath: 'packages/mcp-test-lab/artifacts/official-auth-evidence.json',
        evidenceProfile: false,
        execution: 'parallel-by-protocol',
        jobTimeoutMinutes: 8,
        runnerOverheadMs: 60_000,
        scenarioDeadlineMs: 45_000,
        scenariosByProtocol: {
          '2025-11-25': BASELINE_SCENARIOS,
          '2026-07-28': BASELINE_SCENARIOS,
        },
        schemaVersion: '1.0.0',
        stepTimeoutMinutes: 3,
        ticket: 'BST-1560',
        workflowOverheadMinutes: 1,
      },
      'modern-closeout': {
        buildTimeoutMinutes: 4,
        evidencePath: 'packages/mcp-test-lab/artifacts/official-auth-modern-closeout-evidence.json',
        evidenceProfile: true,
        execution: 'sequential',
        jobTimeoutMinutes: 18,
        runnerOverheadMs: 60_000,
        scenarioDeadlineMs: 45_000,
        scenariosByProtocol: { '2026-07-28': MODERN_CLOSEOUT_SCENARIOS },
        schemaVersion: '1.1.0',
        stepTimeoutMinutes: 10,
        ticket: 'BST-1576',
        workflowOverheadMinutes: 4,
      },
    });
  });

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
          descriptor.stepTimeoutMinutes +
          descriptor.workflowOverheadMinutes
      );
    }
  });
});
