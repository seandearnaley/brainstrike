import { constants, realpath } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { promisify } from 'node:util';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { ExecResult } from '../code-execution';
import { buildSandboxRuntimeConfig } from './fence-policy';
import { FenceReadinessError } from './fence-readiness-error';

const realpathNative = promisify(realpath.native);
export const FENCE_READINESS_TIMEOUT_MS = 5000;
const PROBE_OUTPUT = 'brainstrike-fence-ready';
const NAMESPACE_OPERATION = /namespace|unshare|[ug]id map|RTM_NEWADDR|NETLINK_ROUTE|loopback/i;
const NAMESPACE_DENIAL = /not permitted|permission denied|no permissions|not supported|disabled/i;

export function fenceReadinessTimeout(): FenceReadinessError {
  return new FenceReadinessError(
    'sandbox_readiness_timeout',
    'The sandbox readiness check did not finish within 5 seconds. No user code ran. Retry once; if it persists, restart Brainstrike and ask your administrator to check sandbox support on this host.'
  );
}

export function fenceReadinessFailure(
  error: unknown,
  cleanupErrors: readonly unknown[] = []
): FenceReadinessError {
  if (cleanupErrors.length > 0) {
    const primary = fenceReadinessFailure(error);
    return new FenceReadinessError(primary.reason, primary.message, {
      cause: new AggregateError([error, ...cleanupErrors], 'Sandbox readiness cleanup failed'),
    });
  }
  if (error instanceof FenceReadinessError) {
    return error;
  }
  const diagnostic = error instanceof Error ? error.message : '';
  if (
    platform === 'linux' &&
    NAMESPACE_OPERATION.test(diagnostic) &&
    NAMESPACE_DENIAL.test(diagnostic)
  ) {
    return new FenceReadinessError(
      'sandbox_namespace_blocked',
      'This Linux host blocked creation of the sandbox namespace. No user code ran. Ask your administrator to provide a supported bubblewrap/user-namespace configuration, or use a supported host. Brainstrike will not change host security settings or run without the sandbox.',
      { cause: error }
    );
  }
  return new FenceReadinessError(
    'sandbox_readiness_failed',
    'The sandbox readiness check failed before user code could run. Restart Brainstrike and retry; if it persists, ask your administrator to check the sandbox runtime and Brainstrike logs. No unsandboxed fallback is available.',
    { cause: error }
  );
}

/**
 * srt 0.0.75 falls back to discovered helpers when an explicit path is missing.
 * Check the host-owned override ourselves before srt sees it, on every probe
 * and run. Native realpath plus an ASAR-component refusal avoids Electron's
 * virtual fs reporting an archived binary as a usable native executable.
 */
export async function withLinuxSeccompApplyPath(
  config: SandboxRuntimeConfig,
  applyPath: string | undefined
): Promise<SandboxRuntimeConfig> {
  if (applyPath === undefined) {
    return config;
  }
  let physicalPath: string;
  try {
    if (applyPath.split('/').some((component) => component.toLowerCase().endsWith('.asar'))) {
      throw new Error('The sandbox helper must be outside ASAR archives.');
    }
    physicalPath = await realpathNative(applyPath);
    if (physicalPath.split('/').some((component) => component.toLowerCase().endsWith('.asar'))) {
      throw new Error('The sandbox helper must resolve outside ASAR archives.');
    }
    if (!(await stat(physicalPath)).isFile()) {
      throw new Error('The sandbox helper must be a regular file.');
    }
    await access(physicalPath, constants.X_OK);
  } catch (cause) {
    throw new FenceReadinessError(
      'sandbox_dependencies_missing',
      'The configured Linux sandbox helper is unavailable or is not an executable physical file. No user code ran. Reinstall Brainstrike or ask your administrator to check its sandbox installation; no alternate helper or weaker sandbox will be used.',
      { cause }
    );
  }
  // Pin the validated target rather than asking srt to follow the original
  // symlink again after validation.
  return { ...config, seccomp: { applyPath: physicalPath } };
}

interface FenceReadinessProbeOptions {
  readonly applyConfig: (config: SandboxRuntimeConfig) => Promise<void>;
  readonly deadline: number;
  readonly linuxSeccompApplyPath: string | undefined;
  readonly signal: AbortSignal;
  readonly spawn: (options: {
    argv: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxOutputBytes: number;
    signal: AbortSignal;
    timeoutMs: number;
  }) => Promise<ExecResult>;
}

/** Must run under the same process-global lock as execution and disposal. */
export async function probeFenceReadiness(options: FenceReadinessProbeOptions): Promise<void> {
  const { signal } = options;
  signal.throwIfAborted();

  const scratch = await mkdtemp(join(tmpdir(), 'brainstrike-fence-readiness-'));
  let failure: { error: unknown } | undefined;
  try {
    signal.throwIfAborted();
    const cwd = await realpathNative(scratch);
    const config = await withLinuxSeccompApplyPath(
      await buildSandboxRuntimeConfig({ allowedDomains: [], allowWrite: [cwd] }, cwd),
      options.linuxSeccompApplyPath
    );
    signal.throwIfAborted();
    // checkDependenciesAsync reads the singleton's CURRENT config. Install
    // this exact restrictive probe policy before checking, under the same
    // global lock, so it cannot inspect another executor's helper or policy.
    // In srt 0.0.75, updateConfig only clones config and resolves parent proxy
    // settings on Darwin/Linux; it needs no initialized native resources.
    // The restrictive config may remain after refusal: the caller owns reset
    // decisions and must preserve another live executor's session. Each later
    // probe/run installs its own config under this lock before using it.
    SandboxManager.updateConfig(config);
    const dependencies = await SandboxManager.checkDependenciesAsync();
    signal.throwIfAborted();
    if (dependencies.errors.length > 0) {
      throw new FenceReadinessError(
        'sandbox_dependencies_missing',
        `Sandbox dependencies are missing: ${dependencies.errors.join(', ').slice(0, 1024)}. No user code ran. Ask your administrator to install the required sandbox tools (on Linux: bubblewrap, socat and ripgrep), then retry.`
      );
    }
    // Missing seccomp is currently a warning that silently weakens the fence.
    // Refuse all warnings conservatively, but report the actual bounded warning
    // so future runtime advisories are not misdiagnosed as missing seccomp.
    if (dependencies.warnings.length > 0) {
      throw new FenceReadinessError(
        'sandbox_unsupported_runtime',
        `This runtime cannot confirm the complete OS sandbox. Sandbox runtime warnings: ${dependencies.warnings.join(', ').slice(0, 1024)}. No user code ran. Use a supported runtime with all sandbox components available; ask your administrator to check the Brainstrike installation.`
      );
    }

    await options.applyConfig(config);
    signal.throwIfAborted();
    // Fixed shell builtin, independent of Python and of any caller-supplied
    // code/interpreter. Same wrapper, policy, env and process-tree teardown as
    // a real run; a PATH/dependency check alone never counts as readiness.
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
      `printf '%s' '${PROBE_OUTPUT}'`,
      undefined,
      config,
      signal,
      cwd
    );
    signal.throwIfAborted();
    const result = await options.spawn({
      argv,
      cwd,
      env,
      maxOutputBytes: 4096,
      signal,
      timeoutMs: Math.max(1, options.deadline - Date.now()),
    });
    signal.throwIfAborted();
    if (result.timedOut) {
      throw fenceReadinessTimeout();
    }
    if (result.exitCode !== 0 || result.signal !== null || result.stdout !== PROBE_OUTPUT) {
      throw fenceReadinessFailure(
        new Error(result.stderr || 'The sandbox probe did not complete successfully.')
      );
    }
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  try {
    SandboxManager.cleanupAfterCommand();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(scratch, { force: true, recursive: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (failure) {
    throw cleanupErrors.length > 0
      ? fenceReadinessFailure(failure.error, cleanupErrors)
      : failure.error;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Sandbox readiness cleanup failed');
  }
}
