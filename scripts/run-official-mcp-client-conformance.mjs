#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFORMANCE_VERSION = '0.2.0-alpha.10';
const CLIENT_COMMAND = 'node apps/desktop/dist/official-conformance-client-entry.js';
const PROTOCOL_VERSIONS = ['2025-11-25', '2026-07-28'];
export const OFFICIAL_AUTH_SCENARIOS = [
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
];
export const OFFICIAL_ALPHA10_AUTH_SCENARIOS = [
  ...OFFICIAL_AUTH_SCENARIOS,
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
];
export const OFFICIAL_ALPHA10_AUTH_SCENARIOS_BY_PROTOCOL = Object.freeze({
  '2025-11-25': OFFICIAL_AUTH_SCENARIOS,
  '2026-07-28': OFFICIAL_ALPHA10_AUTH_SCENARIOS,
});
const SCENARIO_DEADLINE_MS = 45_000;
const WINDOWS_JOB_CLEANUP_TIMEOUT_MS = 2000;
const WINDOWS_JOB_POLL_INTERVAL_MS = 10;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktopDependency = createRequire(path.join(REPO_ROOT, 'apps/desktop/package.json'));
const initializedWindowsJobs = new WeakSet();
export const OFFICIAL_EVIDENCE_PATH = path.join(
  REPO_ROOT,
  'packages/mcp-test-lab/artifacts/official-auth-evidence.json'
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
}) {
  return PROTOCOL_VERSIONS.flatMap((protocolVersion) =>
    OFFICIAL_AUTH_SCENARIOS.map((scenario) => ({
      argv: [
        conformanceEntryPath,
        'client',
        '--command',
        CLIENT_COMMAND,
        '--scenario',
        scenario,
        '--spec-version',
        protocolVersion,
        '--timeout',
        '30000',
      ],
      command: nodePath,
      id: `${protocolVersion}/${scenario}`,
      protocolVersion,
    }))
  );
}

export function validateExpectedFailureLedgers(
  repoRoot,
  { readDirectory = readdirSync, readFile = readFileSync } = {}
) {
  const ledgerRoot = path.join(repoRoot, 'packages/mcp-test-lab/conformance/expected-failures');
  const expectedFiles = PROTOCOL_VERSIONS.map((protocolVersion) => `${protocolVersion}.json`);
  const actualFiles = [...readDirectory(ledgerRoot)].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Official MCP expected-failure ledger files are invalid');
  }
  return Object.fromEntries(
    PROTOCOL_VERSIONS.map((protocolVersion) => {
      let ledger;
      try {
        ledger = JSON.parse(readFile(path.join(ledgerRoot, `${protocolVersion}.json`), 'utf8'));
      } catch (cause) {
        throw new Error(
          `Official MCP expected-failure ledger ${protocolVersion}.json is unreadable or malformed`,
          { cause }
        );
      }
      if (
        typeof ledger !== 'object' ||
        ledger === null ||
        Array.isArray(ledger) ||
        Object.keys(ledger).length !== 1 ||
        !Array.isArray(ledger.client) ||
        ledger.client.length !== 0
      ) {
        throw new Error('Official MCP expected-failure ledgers must remain exactly empty');
      }
      return [protocolVersion, { client: [] }];
    })
  );
}

export function buildOfficialAuthEvidence({ completedAt, git, ledgers, report, startedAt }) {
  const results = report.waves.flatMap((wave) => wave.results);
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.length - passed;
  return {
    completedAt,
    conformance: {
      package: '@modelcontextprotocol/conformance',
      prerelease: true,
      required: false,
      version: CONFORMANCE_VERSION,
    },
    expectedFailures: ledgers,
    git,
    schemaVersion: '1.0.0',
    startedAt,
    summary: {
      cleanup: report.failureIds.some((id) => id.endsWith('/cleanup')) ? 'failed' : 'confirmed',
      executions: results.length,
      failed,
      passed,
    },
    ticket: 'BST-1560',
    waves: report.waves,
  };
}

export function writeOfficialAuthEvidence(outputPath, evidence) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, outputPath);
}

export function resolveGitEvidence(repoRoot) {
  const runGit = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  return {
    clean: runGit(['status', '--porcelain']) === '',
    head: runGit(['rev-parse', 'HEAD']),
  };
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
    deferWindowsCleanup = false,
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
      const shouldCleanOwnedProcesses = ownsWindowsJob
        ? !deferWindowsCleanup
        : processGroupId !== undefined;
      if (killOwnedGroup && shouldCleanOwnedProcesses) {
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
    deadlineMs = SCENARIO_DEADLINE_MS,
    env = buildControlledEnvironment(),
    loadWindowsJob = loadWindowsJobNative,
    now = Date.now,
    platform = process.platform,
    runInvocation = runOfficialClientInvocation,
  } = {}
) {
  const canonicalIds = PROTOCOL_VERSIONS.flatMap((protocolVersion) =>
    OFFICIAL_AUTH_SCENARIOS.map((scenario) => `${protocolVersion}/${scenario}`)
  );
  if (
    invocations.length !== canonicalIds.length ||
    invocations.some(
      (invocation, index) =>
        invocation.id !== canonicalIds[index] ||
        invocation.protocolVersion !==
          PROTOCOL_VERSIONS[Math.floor(index / OFFICIAL_AUTH_SCENARIOS.length)]
    )
  ) {
    throw new Error(
      'Official MCP auth conformance requires the exact canonical 28-scenario matrix'
    );
  }
  const windowsJob = initializeWindowsJobOwnership(platform, loadWindowsJob);
  const failures = [];
  const waves = [];
  for (const protocolVersion of PROTOCOL_VERSIONS) {
    const waveStartedAt = now();
    const wave = invocations.filter((invocation) => invocation.protocolVersion === protocolVersion);
    const results = await Promise.all(
      wave.map(async (invocation) => {
        const startedAt = now();
        try {
          await runInvocation(invocation, {
            cwd,
            deadlineMs,
            deferWindowsCleanup: platform === 'win32',
            env,
            platform,
            windowsJob,
          });
          return { durationMs: now() - startedAt, id: invocation.id, status: 'passed' };
        } catch (error) {
          return {
            durationMs: now() - startedAt,
            failureType: classifyInvocationFailure(error),
            id: invocation.id,
            status: 'failed',
          };
        }
      })
    );
    for (const result of results) {
      if (result.status === 'failed') {
        failures.push(new Error(result.id));
      }
    }
    if (windowsJob) {
      try {
        await terminateWindowsJobChildren(windowsJob);
      } catch {
        failures.push(new Error(`${protocolVersion}/auth/cleanup`));
      }
    }
    waves.push({
      durationMs: now() - waveStartedAt,
      protocolVersion,
      results,
    });
  }
  const report = { failureIds: failures.map(({ message }) => message), waves };
  if (failures.length > 0) {
    const failure = new AggregateError(
      failures,
      `Official MCP auth conformance failed: ${failures.map(({ message }) => message).join(', ')}`
    );
    Object.defineProperty(failure, 'report', { enumerable: false, value: report });
    throw failure;
  }
  return report;
}

function classifyInvocationFailure(error) {
  if (!(error instanceof Error)) {
    return 'runner';
  }
  if (error.message.includes('failed to start')) {
    return 'start';
  }
  if (error.message.includes('process deadline')) {
    return 'timeout';
  }
  if (error.message.includes('cleanup failed')) {
    return 'cleanup';
  }
  if (error.message.includes('failed (')) {
    return 'exit';
  }
  return 'runner';
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

export function finalizeOfficialAuthEvidence(
  { completedAt, failure, ledgers, outputPath, report, repoRoot, startedAt },
  { readGitEvidence = resolveGitEvidence, writeEvidence = writeOfficialAuthEvidence } = {}
) {
  try {
    const evidence = buildOfficialAuthEvidence({
      completedAt,
      git: readGitEvidence(repoRoot),
      ledgers,
      report,
      startedAt,
    });
    writeEvidence(outputPath, evidence);
    if (failure) {
      throw failure;
    }
    return evidence;
  } catch (evidenceFailure) {
    if (failure && evidenceFailure !== failure) {
      throw new AggregateError(
        [failure, evidenceFailure],
        'Official MCP auth conformance failed and sanitized evidence persistence failed'
      );
    }
    throw evidenceFailure;
  }
}

export async function main() {
  const startedAt = new Date().toISOString();
  const ledgers = validateExpectedFailureLedgers(REPO_ROOT);
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: resolvePinnedConformanceEntry(REPO_ROOT),
  });
  let failure;
  let report;
  try {
    report = await runOfficialClientInvocations(invocations, {
      cwd: REPO_ROOT,
      env: buildControlledEnvironment(),
    });
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('report' in error) ||
      typeof error.report !== 'object' ||
      error.report === null
    ) {
      throw error;
    }
    failure = error;
    report = error.report;
  }
  const evidence = finalizeOfficialAuthEvidence({
    completedAt: new Date().toISOString(),
    failure,
    ledgers,
    outputPath: OFFICIAL_EVIDENCE_PATH,
    repoRoot: REPO_ROOT,
    report,
    startedAt,
  });
  process.stdout.write(
    `Official MCP auth conformance passed ${evidence.summary.passed}/${evidence.summary.executions} executions\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `Official MCP client conformance failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    process.exitCode = 1;
  });
}
