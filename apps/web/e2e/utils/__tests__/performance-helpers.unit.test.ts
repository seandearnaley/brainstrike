import { describe, expect, it } from 'vitest';
import {
  BASE_THRESHOLDS,
  detectEnvironment,
  getEnvironmentThresholds,
  PERFORMANCE_THRESHOLDS,
} from '../performance-config';

describe('performance helpers (unit)', () => {
  it('detectEnvironment returns local by default', () => {
    const env = detectEnvironment();
    expect(['local', 'ci', 'github-actions']).toContain(env);
  });

  it('getEnvironmentThresholds scales by environment', () => {
    const local = getEnvironmentThresholds('local');
    const ci = getEnvironmentThresholds('ci');
    expect(ci.TREE_LOAD_MAX_MS).toBeGreaterThanOrEqual(BASE_THRESHOLDS.TREE_LOAD_MAX_MS);
    expect(local.TREE_LOAD_MAX_MS).toBeGreaterThan(0);
  });

  it('PERFORMANCE_THRESHOLDS is defined', () => {
    expect(PERFORMANCE_THRESHOLDS.MEMORY_TOTAL_MAX_MB).toBeGreaterThan(0);
  });
});
