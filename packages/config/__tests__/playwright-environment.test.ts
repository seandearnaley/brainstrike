import { describe, expect, it } from 'vitest';
import {
  detectEnvironment,
  getCILaunchArgs,
  getEnvironmentConfig,
  getGlobalTimeout,
  getRetryCount,
  getWorkerCount,
  logEnvironmentConfig,
  validateEnvironmentConfig,
} from '../src/playwright-environment';

describe('playwright-environment helpers', () => {
  it('detectEnvironment returns shape and toggles with env', () => {
    const origCI = process.env['CI'];
    const origGH = process.env['GITHUB_ACTIONS'];
    const origCodex = process.env['CODEX_ENV'];

    // Ensure a clean slate using Reflect.deleteProperty to satisfy lint rules
    Reflect.deleteProperty(process.env, 'CI');
    Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
    Reflect.deleteProperty(process.env, 'CODEX_ENV');

    expect(detectEnvironment()).toEqual({ isCodex: false, isGitHubActions: false, isCI: false });

    process.env['CI'] = '1';
    expect(detectEnvironment().isCI).toBe(true);

    process.env['GITHUB_ACTIONS'] = 'true';
    expect(detectEnvironment().isGitHubActions).toBe(true);

    // Restore
    if (typeof origCI === 'string') process.env['CI'] = origCI;
    else Reflect.deleteProperty(process.env, 'CI');
    if (typeof origGH === 'string') process.env['GITHUB_ACTIONS'] = origGH;
    else Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
    if (typeof origCodex === 'string') process.env['CODEX_ENV'] = origCodex;
    else Reflect.deleteProperty(process.env, 'CODEX_ENV');
  });

  it('computes worker count and retries per env', () => {
    expect(getWorkerCount({ isCodex: true, isGitHubActions: false, isCI: true })).toBe(1);
    expect(getWorkerCount({ isCodex: false, isGitHubActions: true, isCI: true })).toBe(2);
    expect(getRetryCount({ isCodex: true, isGitHubActions: false, isCI: true })).toBe(1);
    expect(getRetryCount({ isCodex: false, isGitHubActions: false, isCI: false })).toBe(0);
  });

  it('global timeout policy differs between CI and local', () => {
    expect(getGlobalTimeout({ isCodex: true, isGitHubActions: false, isCI: true })).toBeGreaterThan(
      0
    );
    expect(getGlobalTimeout({ isCodex: false, isGitHubActions: false, isCI: false })).toBe(0);
  });

  it('CI launch args are empty locally and populated in CI', () => {
    expect(getCILaunchArgs({ isCodex: false, isGitHubActions: false, isCI: false })).toEqual([]);
    const args = getCILaunchArgs({ isCodex: true, isGitHubActions: false, isCI: true });
    expect(Array.isArray(args)).toBe(true);
    expect(args.length).toBeGreaterThan(0);
  });

  it('returns environment config and validates warnings', () => {
    const cfg = getEnvironmentConfig();
    expect(typeof cfg.headless).toBe('boolean');
    // Quiet logger (no-op) call for coverage
    logEnvironmentConfig('app', cfg);
    const warnings = validateEnvironmentConfig({ ...cfg, isCodex: true });
    expect(Array.isArray(warnings)).toBe(true);
  });
});
