#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFORMANCE_VERSION = '0.2.0-alpha.10';
const CLIENT_COMMAND = 'node apps/desktop/dist/official-conformance-client-entry.js';
const PROTOCOL_VERSIONS = ['2025-11-25', '2026-07-28'];
// C2a defines and executes the final suite topology as a fail-closed tripwire.
// With zero accepted failures, these invocations cannot pass until C2b adds
// elicitation-defaults, sse-retry, and the complete auth scenario adapter.
const SUITES = ['core', 'auth'];
const SUITE_DEADLINE_MS = 600_000;
const WINDOWS_JOB_CLEANUP_TIMEOUT_MS = 2000;
const WINDOWS_JOB_POLL_INTERVAL_MS = 10;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktopDependency = createRequire(path.join(REPO_ROOT, 'apps/desktop/package.json'));
const initializedWindowsJobs = new WeakSet();
export const OFFICIAL_OUTPUT_ROOT = path.join(
  REPO_ROOT,
  'packages/mcp-test-lab/artifacts/official-client-conformance'
);
const SAFE_ENVIRONMENT_NAMES = [
  'CI',
  'COMSPEC',
  'HOME',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
];

export function buildControlledEnvironment(source = process.env) {
  const environment = { NO_COLOR: '1' };
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (source[name] !== undefined) {
      environment[name] = source[name];
    }
  }
  return environment;
}

export function buildOfficialClientInvocations({
  conformanceEntryPath,
  nodePath = process.execPath,
  outputRoot,
  repoRoot,
}) {
  return PROTOCOL_VERSIONS.flatMap((protocolVersion) =>
    SUITES.map((suite) => ({
      argv: [
        conformanceEntryPath,
        'client',
        '--command',
        CLIENT_COMMAND,
        '--suite',
        suite,
        '--spec-version',
        protocolVersion,
        '--expected-failures',
        path.join(
          repoRoot,
          'packages/mcp-test-lab/conformance/expected-failures',
          `${protocolVersion}.json`
        ),
        '--timeout',
        '30000',
        '--output-dir',
        path.join(outputRoot, protocolVersion, suite),
      ],
      command: nodePath,
      id: `${protocolVersion}/${suite}`,
    }))
  );
}

function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function loadWindowsJobNative() {
  return requireDesktopDependency('@brainstrike/windows-job-native');
}

function hasWindowsJobInterface(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.activeProcessCount === 'function' &&
    typeof value.initialize === 'function' &&
    typeof value.terminateOtherProcesses === 'function'
  );
}

export function initializeWindowsJobOwnership(
  platform = process.platform,
  load = loadWindowsJobNative
) {
  if (platform !== 'win32') {
    return;
  }
  let windowsJob;
  try {
    windowsJob = load();
  } catch (cause) {
    throw new Error(
      'Official MCP conformance cannot start on Windows without Job Object ownership',
      { cause }
    );
  }
  if (!hasWindowsJobInterface(windowsJob)) {
    throw new Error('Official MCP conformance Windows Job Object capability is invalid');
  }
  if (initializedWindowsJobs.has(windowsJob)) {
    return windowsJob;
  }
  try {
    windowsJob.initialize();
  } catch (cause) {
    throw new Error('Official MCP conformance Windows Job Object assignment failed', { cause });
  }
  initializedWindowsJobs.add(windowsJob);
  return windowsJob;
}

function readWindowsJobActiveProcessCount(windowsJob) {
  const count = windowsJob.activeProcessCount();
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(
      'Official MCP conformance Windows Job Object returned an invalid process count'
    );
  }
  return count;
}

async function terminateWindowsJobChildren(windowsJob, timeoutMs = WINDOWS_JOB_CLEANUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (readWindowsJobActiveProcessCount(windowsJob) > 1) {
    const terminated = windowsJob.terminateOtherProcesses(1);
    if (!Number.isSafeInteger(terminated) || terminated < 0) {
      throw new Error(
        'Official MCP conformance Windows Job Object returned an invalid termination count'
      );
    }
    if (readWindowsJobActiveProcessCount(windowsJob) <= 1) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('Official MCP conformance Windows Job Object cleanup could not be confirmed');
    }
    await new Promise((resolve) => setTimeout(resolve, WINDOWS_JOB_POLL_INTERVAL_MS));
  }
}

function createCleanupFailure(invocationId, failure, cleanupCause) {
  const cause = failure
    ? new AggregateError(
        [failure, cleanupCause],
        `Official MCP conformance ${invocationId} invocation and cleanup failed`
      )
    : cleanupCause;
  return new Error(`Official MCP conformance ${invocationId} cleanup failed`, { cause });
}

export async function killPosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasErrorCode(error, 'ESRCH')) {
      throw error;
    }
  }
  if (signal !== 'SIGKILL') {
    return;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (hasErrorCode(error, 'ESRCH')) {
        return;
      }
      if (!hasErrorCode(error, 'EPERM')) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Official MCP conformance process-group teardown could not be confirmed');
}

export function runOfficialClientInvocation(
  invocation,
  {
    cwd,
    deadlineMs = 120_000,
    env = buildControlledEnvironment(),
    killGraceMs = 2000,
    killGroup = killPosixProcessGroup,
    platform = process.platform,
    spawnProcess = spawn,
    windowsJob,
  } = {}
) {
  const ownsWindowsJob = platform === 'win32';
  if (ownsWindowsJob && !initializedWindowsJobs.has(windowsJob)) {
    return Promise.reject(
      new Error('Official MCP conformance requires assigned Windows Job Object ownership')
    );
  }
  let child;
  try {
    child = spawnProcess(invocation.command, [...invocation.argv], {
      cwd,
      detached: !ownsWindowsJob,
      env,
      shell: false,
      stdio: 'ignore',
    });
  } catch (cause) {
    const failure = new Error(`Official MCP conformance ${invocation.id} failed to start`, {
      cause,
    });
    if (!ownsWindowsJob) {
      return Promise.reject(failure);
    }
    return terminateWindowsJobChildren(windowsJob).then(
      () => Promise.reject(failure),
      (cleanupCause) => Promise.reject(createCleanupFailure(invocation.id, failure, cleanupCause))
    );
  }

  return new Promise((resolve, reject) => {
    const processGroupId = child.pid;
    let settled = false;
    let timedOut = false;
    let graceTimer;
    let deadlineTimer;
    let startFailureImmediate;
    const finish = async (failure, { killOwnedGroup = true } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      clearImmediate(startFailureImmediate);
      if (killOwnedGroup && (ownsWindowsJob || processGroupId !== undefined)) {
        try {
          if (ownsWindowsJob) {
            await terminateWindowsJobChildren(windowsJob, killGraceMs);
          } else {
            await killGroup(processGroupId, 'SIGKILL');
          }
        } catch (cleanupCause) {
          reject(createCleanupFailure(invocation.id, failure, cleanupCause));
          return;
        }
      }
      if (failure) {
        reject(failure);
        return;
      }
      resolve();
    };

    child.once('error', (cause) => {
      void finish(
        new Error(`Official MCP conformance ${invocation.id} failed to start`, { cause }),
        {
          killOwnedGroup: ownsWindowsJob || processGroupId !== undefined,
        }
      );
    });
    if (processGroupId === undefined) {
      startFailureImmediate = setImmediate(() => {
        void finish(new Error(`Official MCP conformance ${invocation.id} failed to start`), {
          killOwnedGroup: ownsWindowsJob,
        });
      });
      return;
    }

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      if (ownsWindowsJob) {
        void finish(
          new Error(
            `Official MCP conformance ${invocation.id} exceeded its ${deadlineMs}ms process deadline`
          )
        );
        return;
      }
      void killGroup(processGroupId, 'SIGTERM').then(
        () => {
          if (settled) {
            return;
          }
          graceTimer = setTimeout(() => {
            void finish(
              new Error(
                `Official MCP conformance ${invocation.id} exceeded its ${deadlineMs}ms process deadline`
              )
            );
          }, killGraceMs);
        },
        (cause) =>
          finish(new Error(`Official MCP conformance ${invocation.id} cleanup failed`, { cause }))
      );
    }, deadlineMs);
    child.once('close', (code, signal) => {
      const failure = timedOut
        ? new Error(
            `Official MCP conformance ${invocation.id} exceeded its ${deadlineMs}ms process deadline`
          )
        : code === 0
          ? undefined
          : new Error(
              `Official MCP conformance ${invocation.id} failed (${signal ? 'signal' : 'exit'} ${signal ?? code ?? 'unknown'})`
            );
      void finish(failure);
    });
  });
}

export async function runOfficialClientInvocations(
  invocations,
  {
    cwd,
    deadlineMs = SUITE_DEADLINE_MS,
    env = buildControlledEnvironment(),
    loadWindowsJob = loadWindowsJobNative,
    platform = process.platform,
    runInvocation = runOfficialClientInvocation,
  } = {}
) {
  const windowsJob = initializeWindowsJobOwnership(platform, loadWindowsJob);
  const failures = [];
  for (const invocation of invocations) {
    try {
      await runInvocation(invocation, { cwd, deadlineMs, env, platform, windowsJob });
    } catch (error) {
      failures.push(
        new Error(`Official MCP conformance ${invocation.id} failed`, {
          cause: error,
        })
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Official MCP conformance suites failed: ${invocations.map(({ id }) => id).join(', ')}`
    );
  }
}

export function resolvePinnedConformanceEntry(repoRoot) {
  const packageRoot = path.join(
    repoRoot,
    'packages/mcp-test-lab/node_modules/@modelcontextprotocol/conformance'
  );
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== CONFORMANCE_VERSION || manifest.bin?.conformance !== 'dist/index.js') {
    throw new Error(`Official MCP conformance install is not ${CONFORMANCE_VERSION}`);
  }
  return path.join(packageRoot, manifest.bin.conformance);
}

export async function main() {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: resolvePinnedConformanceEntry(REPO_ROOT),
    outputRoot: OFFICIAL_OUTPUT_ROOT,
    repoRoot: REPO_ROOT,
  });
  await runOfficialClientInvocations(invocations, {
    cwd: REPO_ROOT,
    env: buildControlledEnvironment(),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `Official MCP client conformance failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    process.exitCode = 1;
  });
}
