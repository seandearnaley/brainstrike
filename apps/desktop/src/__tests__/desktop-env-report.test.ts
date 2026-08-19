import path from 'node:path';
import { providerOverrideEnvKey } from '@brainstrike/assistant-contract/provider-metadata';
import { describe, expect, it } from 'vitest';
import type { DesktopEnvLoadResult } from '../desktop-env';
import { buildDesktopEnvBootstrapReport } from '../desktop-env-report';

const APP_ROOT = '/app/root';
const USER_DATA_PATH = '/user/data';
// Named accessor, never a positional index into providerEnvKeys — which of
// the two names is the override is the registry's business.
const OPENAI_ENV_KEY = providerOverrideEnvKey('openai') as string;

function loadResult(overrides: Partial<DesktopEnvLoadResult> = {}): DesktopEnvLoadResult {
  return {
    appliedVariableCount: 0,
    deprecatedVariableNames: [],
    failures: [],
    loadedFiles: [],
    skipped: false,
    ...overrides,
  };
}

function build(
  result: DesktopEnvLoadResult,
  env: NodeJS.ProcessEnv = {},
  isPackaged = false
): ReturnType<typeof buildDesktopEnvBootstrapReport> {
  return buildDesktopEnvBootstrapReport({
    appRoot: APP_ROOT,
    env,
    isPackaged,
    result,
    userDataPath: USER_DATA_PATH,
  });
}

describe('buildDesktopEnvBootstrapReport', () => {
  it('projects development loaded files to their candidate paths', () => {
    const report = build(
      loadResult({ appliedVariableCount: 3, loadedFiles: ['dev-local', 'dev'] })
    );

    expect(report.skipped).toBe(false);
    expect(report.appliedVariableCount).toBe(3);
    expect(report.loadedFiles).toEqual([
      { file: 'dev-local', path: path.join(APP_ROOT, '.env.local') },
      { file: 'dev', path: path.join(APP_ROOT, '.env') },
    ]);
  });

  it('projects the packaged user-data candidate path', () => {
    const report = build(
      loadResult({ appliedVariableCount: 1, loadedFiles: ['user-data'] }),
      {},
      true
    );

    expect(report.loadedFiles).toEqual([
      { file: 'user-data', path: path.join(USER_DATA_PATH, '.env') },
    ]);
  });

  it('reports the skipped test-mode shape without inventing files', () => {
    const report = build(loadResult({ skipped: true }));

    expect(report).toEqual({
      appliedVariableCount: 0,
      credentialVariablesPresent: [],
      deprecatedVariablesInFiles: [],
      failures: [],
      loadedFiles: [],
      nonCredentialVariablesPresent: [],
      skipped: true,
    });
  });

  it('carries each parse failure with the parser line-precise message and its file path', () => {
    const report = build(
      loadResult({
        failures: [
          {
            code: 'env_file_invalid',
            file: 'dev-local',
            message:
              'Desktop environment file ".env.local" is invalid at line 4: unsupported variable name.',
          },
        ],
      })
    );

    expect(report.failures).toEqual([
      {
        code: 'env_file_invalid',
        file: 'dev-local',
        message:
          'Desktop environment file ".env.local" is invalid at line 4: unsupported variable name.',
        path: path.join(APP_ROOT, '.env.local'),
      },
    ]);
    expect(report.loadedFiles).toEqual([]);
  });

  it('partitions present allow-listed names into credential and non-credential sets', () => {
    const report = build(loadResult(), {
      AWS_REGION: 'us-east-1',
      [OPENAI_ENV_KEY]: 'sk-live-value',
      UNRELATED_VARIABLE: 'anything',
    });

    expect(report.credentialVariablesPresent).toContain(OPENAI_ENV_KEY);
    expect(report.nonCredentialVariablesPresent).toEqual(['AWS_REGION']);
    expect(report.credentialVariablesPresent).not.toContain('AWS_REGION');
    expect([
      ...report.credentialVariablesPresent,
      ...report.nonCredentialVariablesPresent,
    ]).not.toContain('UNRELATED_VARIABLE');
  });

  it('matches names case-insensitively and reports the canonical spelling', () => {
    // Windows environment names are case-insensitive; apply the same rule
    // everywhere so a mixed-case source object cannot dodge the report while
    // still resolving as a credential — mirroring
    // createCredentialIsolatedChildEnvironment and
    // detectDeprecatedProviderEnvVars.
    const report = build(loadResult(), {
      aws_region: 'us-east-1',
      [OPENAI_ENV_KEY.toLowerCase()]: 'set-through-a-lowercase-name',
    });

    expect(report.credentialVariablesPresent).toContain(OPENAI_ENV_KEY);
    expect(report.nonCredentialVariablesPresent).toEqual(['AWS_REGION']);
  });

  it('treats an empty or whitespace-only variable as absent', () => {
    const report = build(loadResult(), { AWS_REGION: '   ', [OPENAI_ENV_KEY]: '' });

    expect(report.credentialVariablesPresent).toEqual([]);
    expect(report.nonCredentialVariablesPresent).toEqual([]);
  });

  it('never serializes a credential VALUE into the payload', () => {
    // Deliberately NOT shaped like a real provider key: the repo secret scan
    // rejects key-shaped literals, and the assertion only needs a distinctive
    // sentinel that must never reach the payload.
    const secretValue = 'value-DO-NOT-LEAK-4f9a2b7c1e';
    const report = build(loadResult({ appliedVariableCount: 1, loadedFiles: ['dev'] }), {
      AWS_REGION: 'eu-west-1-DO-NOT-LEAK',
      [OPENAI_ENV_KEY]: secretValue,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain('DO-NOT-LEAK');
    // The NAME is still reported — the projection is names-only, not empty.
    expect(serialized).toContain(OPENAI_ENV_KEY);
  });

  it('passes through the deprecated names spelled in the loaded files', () => {
    const report = build(loadResult({ deprecatedVariableNames: ['OPENAI_API_KEY'] }));

    expect(report.deprecatedVariablesInFiles).toEqual(['OPENAI_API_KEY']);
  });

  it('throws when a recorded file id has no candidate path for the current mode', () => {
    // A packaged runtime has no `dev` candidate. Silently dropping the entry
    // would hide a real bootstrap inconsistency.
    expect(() => build(loadResult({ loadedFiles: ['dev'] }), {}, true)).toThrow(
      /no candidate path/i
    );
  });
});
