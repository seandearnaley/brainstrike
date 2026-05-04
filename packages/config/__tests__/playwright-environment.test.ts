import { describe, expect, it, vi } from 'vitest';
import {
  detectEnvironment,
  getCILaunchArgs,
  getEnvironmentConfig,
  getGlobalTimeout,
  getRetryCount,
  getWorkerCount,
  harmonizeColorEnvironment,
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
    if (typeof origCI === 'string') {
      process.env['CI'] = origCI;
    } else {
      Reflect.deleteProperty(process.env, 'CI');
    }
    if (typeof origGH === 'string') {
      process.env['GITHUB_ACTIONS'] = origGH;
    } else {
      Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
    }
    if (typeof origCodex === 'string') {
      process.env['CODEX_ENV'] = origCodex;
    } else {
      Reflect.deleteProperty(process.env, 'CODEX_ENV');
    }
  });

  it('computes worker count and retries per env', () => {
    expect(getWorkerCount({ isCodex: true, isGitHubActions: false, isCI: true })).toBe(1);
    expect(getWorkerCount({ isCodex: false, isGitHubActions: true, isCI: true })).toBe(2);
    expect(getWorkerCount({ isCodex: false, isGitHubActions: false, isCI: true })).toBe(1);
    expect(getRetryCount({ isCodex: true, isGitHubActions: false, isCI: true })).toBe(1);
    expect(getRetryCount({ isCodex: false, isGitHubActions: false, isCI: false })).toBe(0);
  });

  it('keeps GitHub Actions on two workers without same-file parallelism', () => {
    const originalCI = process.env['CI'];
    const originalGH = process.env['GITHUB_ACTIONS'];
    const originalCodex = process.env['CODEX_ENV'];

    try {
      process.env['CI'] = 'true';
      process.env['GITHUB_ACTIONS'] = 'true';
      Reflect.deleteProperty(process.env, 'CODEX_ENV');

      const cfg = getEnvironmentConfig();

      expect(cfg.workers).toBe(2);
      expect(cfg.fullyParallel).toBe(false);
    } finally {
      if (typeof originalCI === 'string') {
        process.env['CI'] = originalCI;
      } else {
        Reflect.deleteProperty(process.env, 'CI');
      }
      if (typeof originalGH === 'string') {
        process.env['GITHUB_ACTIONS'] = originalGH;
      } else {
        Reflect.deleteProperty(process.env, 'GITHUB_ACTIONS');
      }
      if (typeof originalCodex === 'string') {
        process.env['CODEX_ENV'] = originalCodex;
      } else {
        Reflect.deleteProperty(process.env, 'CODEX_ENV');
      }
    }
  });

  it('keeps Playwright global timeout disabled in every environment', () => {
    expect(getGlobalTimeout({ isCodex: true, isGitHubActions: false, isCI: true })).toBe(0);
    expect(getGlobalTimeout({ isCodex: false, isGitHubActions: false, isCI: true })).toBe(0);
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
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    logEnvironmentConfig('app', cfg);
    const warnings = validateEnvironmentConfig({ ...cfg, isCodex: true });

    expect(Array.isArray(warnings)).toBe(true);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('removes NO_COLOR when FORCE_COLOR is set', () => {
    const originalForceColor = process.env['FORCE_COLOR'];
    const originalNoColor = process.env['NO_COLOR'];

    process.env['FORCE_COLOR'] = '1';
    process.env['NO_COLOR'] = '1';

    harmonizeColorEnvironment();

    expect(process.env['FORCE_COLOR']).toBe('1');
    expect(process.env['NO_COLOR']).toBeUndefined();

    if (typeof originalForceColor === 'string') {
      process.env['FORCE_COLOR'] = originalForceColor;
    } else {
      Reflect.deleteProperty(process.env, 'FORCE_COLOR');
    }

    if (typeof originalNoColor === 'string') {
      process.env['NO_COLOR'] = originalNoColor;
    } else {
      Reflect.deleteProperty(process.env, 'NO_COLOR');
    }
  });
});
