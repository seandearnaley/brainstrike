#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OFFICIAL_AUTH_BASELINE_SCENARIOS,
  OFFICIAL_AUTH_CONFORMANCE_PROFILES,
  OFFICIAL_AUTH_MODERN_CLOSEOUT_SCENARIOS,
  OFFICIAL_AUTH_PROTOCOL_VERSIONS,
  OFFICIAL_AUTH_SCENARIOS_BY_PROTOCOL,
} from '../packages/assistant-contract/src/official-auth-conformance.ts';

const CONFORMANCE_VERSION = '0.2.0-alpha.12';
const CLIENT_COMMAND = 'node apps/desktop/dist/official-conformance-client-entry.js';
const BASELINE_PROFILE = 'baseline';
const CORE_PROFILE = 'core';
const MODERN_CLOSEOUT_PROFILE = 'modern-closeout';
export const OFFICIAL_AUTH_SCENARIOS = OFFICIAL_AUTH_BASELINE_SCENARIOS;
export const OFFICIAL_MODERN_AUTH_SCENARIOS = OFFICIAL_AUTH_MODERN_CLOSEOUT_SCENARIOS;
export const OFFICIAL_ALPHA10_AUTH_SCENARIOS_BY_PROTOCOL = OFFICIAL_AUTH_SCENARIOS_BY_PROTOCOL;
const WINDOWS_JOB_CLEANUP_TIMEOUT_MS = 2000;
const POSIX_GROUP_TEARDOWN_CONFIRMATION_MS = 2000;
const WINDOWS_JOB_POLL_INTERVAL_MS = 10;
export const OFFICIAL_DIAGNOSTIC_MAX_LINES = 40;
const OFFICIAL_DIAGNOSTIC_MAX_LINE_CHARS = 512;
const OFFICIAL_DIAGNOSTIC_MAX_BUFFER_CHARS = 65_536;
const OFFICIAL_DIAGNOSTIC_TRUNCATION_MARKER = '…[truncated]';
const OFFICIAL_STDIO_FLUSH_GRACE_MS = 1000;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `[${String.fromCharCode(0x1b)}${String.fromCharCode(0x9b)}]\\[[0-9;?]*[ -/]*[@-~]`,
  'gu'
);
const LINE_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const OFFICIAL_URL_PATTERN = /https?:\/\/[^\s?#]+(?:\?[^\s#]*)?(?:#[^\s]*)?/giu;
// Keys whose values are always credentials: redact unconditionally.
const OFFICIAL_OAUTH_PARAMETER_PATTERN =
  /\b(?:authorization_code|access_token|refresh_token|id_token|client_assertion|assertion|dpop|code_verifier|verifier)=([^&\s]+)/giu;
// `code=`/`state=` are ambiguous: they also carry ordinary error/status text
// (`exit code=1`, `code=ECONNREFUSED`, `state=failed`). Keep small numbers,
// ALL-CAPS identifiers, and plain lowercase words readable; redact anything
// mixed (real authorization codes and state values are high-entropy).
// Case-sensitive on purpose: the wire parameters are lowercase, and the
// carve-out classes must distinguish letter case to tell an ALL-CAPS error
// identifier or plain word from a mixed-case high-entropy credential.
const OFFICIAL_AMBIGUOUS_PARAMETER_PATTERN =
  /\b(?:code|state)=(?!(?:\d{1,4}|[A-Z][A-Z0-9_]*|[a-z_]+)(?![\w-]))[^&\s]+/gu;
// Shape-based backstop for bare secrets with no key prefix.
const OFFICIAL_JWT_PATTERN = /\beyJ[\w-]{8,}\.[\w-]+\.[\w-]*/gu;
const OFFICIAL_BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const OFFICIAL_STRUCTURED_SECRET_PATTERN =
  /(?<![A-Z0-9_-])((?:\\?["']?)(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?assertion|assertion|dpop|code[_-]?verifier|verifier|token|secret|password|api[_-]?key|apikey|cookie|set-cookie)(?:\\?["']?\s*[:=]\s*))(?!\[redacted-)[^\r\n,}\]]+/giu;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktopDependency = createRequire(path.join(REPO_ROOT, 'apps/desktop/package.json'));
const initializedWindowsJobs = new WeakSet();
export const OFFICIAL_EVIDENCE_PATH = path.join(
  REPO_ROOT,
  OFFICIAL_AUTH_CONFORMANCE_PROFILES.baseline.evidencePath
);
export const OFFICIAL_MODERN_AUTH_EVIDENCE_PATH = path.join(
  REPO_ROOT,
  OFFICIAL_AUTH_CONFORMANCE_PROFILES[MODERN_CLOSEOUT_PROFILE].evidencePath
);
export const OFFICIAL_CORE_EVIDENCE_PATH = path.join(
  REPO_ROOT,
  OFFICIAL_AUTH_CONFORMANCE_PROFILES[CORE_PROFILE].evidencePath
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

export function provisionElectronClientRuntime({
  // Electron 43's CommonJS loader synchronously runs install.js when path.txt
  // or the resolved binary is absent. Requiring it here therefore completes
  // extraction before any scenario process can load the same package.
  loadElectron = () => requireDesktopDependency('electron'),
  runtimeExists = existsSync,
} = {}) {
  let electronPath;
  try {
    electronPath = loadElectron();
  } catch (cause) {
    throw new Error('Official MCP conformance Electron runtime provisioning failed', { cause });
  }
  if (
    typeof electronPath !== 'string' ||
    !path.isAbsolute(electronPath) ||
    !runtimeExists(electronPath)
  ) {
    throw new Error('Official MCP conformance Electron runtime provisioning is invalid');
  }
  return electronPath;
}

export function sanitizeOfficialDiagnosticLine(raw) {
  const lineSafe = raw.replace(ANSI_ESCAPE_PATTERN, '').replace(LINE_UNSAFE_PATTERN, '�').trim();
  if (lineSafe.length === 0) {
    return null;
  }
  const urlRedacted = lineSafe.replace(OFFICIAL_URL_PATTERN, (candidate) => {
    try {
      const url = new URL(candidate);
      const safeUrl = `${url.origin}${url.pathname}`;
      return url.search || url.hash ? `${safeUrl}?[redacted-query]` : safeUrl;
    } catch {
      return '[redacted-auth-url]';
    }
  });
  const shapeRedacted = urlRedacted
    .replace(OFFICIAL_JWT_PATTERN, '[redacted-jwt]')
    .replace(OFFICIAL_BEARER_PATTERN, 'Bearer [redacted-bearer-token]');
  const oauthRedacted = shapeRedacted
    .replace(
      OFFICIAL_OAUTH_PARAMETER_PATTERN,
      (match) => `${match.slice(0, match.indexOf('=') + 1)}[redacted-oauth-parameter]`
    )
    .replace(
      OFFICIAL_AMBIGUOUS_PARAMETER_PATTERN,
      (match) => `${match.slice(0, match.indexOf('=') + 1)}[redacted-oauth-parameter]`
    );
  const redacted = oauthRedacted.replace(
    OFFICIAL_STRUCTURED_SECRET_PATTERN,
    (_match, prefix) => `${prefix}[redacted-structured-secret]`
  );
  if (redacted.length <= OFFICIAL_DIAGNOSTIC_MAX_LINE_CHARS) {
    return redacted;
  }
  return `${redacted.slice(
    0,
    OFFICIAL_DIAGNOSTIC_MAX_LINE_CHARS - OFFICIAL_DIAGNOSTIC_TRUNCATION_MARKER.length
  )}${OFFICIAL_DIAGNOSTIC_TRUNCATION_MARKER}`;
}

export function createOfficialDiagnosticCollector() {
  let buffered = '';
  let droppedChars = 0;
  return {
    collect(chunk) {
      buffered += String(chunk);
      if (buffered.length > OFFICIAL_DIAGNOSTIC_MAX_BUFFER_CHARS) {
        // Cut only at a line boundary: keeping the raw tail of a truncated
        // line could retain a secret value whose label was dropped, and an
        // unlabeled value defeats the pattern-based sanitizer below.
        const overflowCut = buffered.length - OFFICIAL_DIAGNOSTIC_MAX_BUFFER_CHARS;
        const nextLineStart = buffered.indexOf('\n', overflowCut);
        const cut = nextLineStart === -1 ? buffered.length : nextLineStart + 1;
        droppedChars += cut;
        buffered = buffered.slice(cut);
      }
    },
    lines() {
      const sanitized = buffered
        .split(/\r?\n/u)
        .map(sanitizeOfficialDiagnosticLine)
        .filter((line) => line !== null);
      const tail = sanitized.slice(-OFFICIAL_DIAGNOSTIC_MAX_LINES);
      const omittedLines = sanitized.length - tail.length;
      const prefix = [];
      if (droppedChars > 0) {
        prefix.push(`…[${droppedChars} earlier chars dropped]`);
      }
      if (omittedLines > 0) {
        prefix.push(`…[${omittedLines} earlier lines omitted]`);
      }
      return [...prefix, ...tail];
    },
  };
}

function attachInvocationDiagnostics(failure, collector) {
  if (!(failure instanceof Error) || collector === undefined) {
    return failure;
  }
  if (!Object.hasOwn(failure, 'diagnostics')) {
    Object.defineProperty(failure, 'diagnostics', {
      enumerable: false,
      value: collector.lines(),
    });
  }
  return failure;
}

export function getInvocationDiagnostics(error) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'diagnostics' in error &&
    Array.isArray(error.diagnostics)
  ) {
    return error.diagnostics.filter((line) => typeof line === 'string');
  }
  return [];
}

export function formatOfficialInvocationDiagnostics(invocationId, failureType, lines) {
  const body = lines.length > 0 ? lines : ['(no child output captured)'];
  return [
    `--- official conformance diagnostics ${invocationId} (${failureType}) ---`,
    ...body,
    `--- end diagnostics ${invocationId} ---`,
    '',
  ].join('\n');
}

export function buildOfficialClientInvocations({
  conformanceEntryPath,
  nodePath = process.execPath,
  profile = BASELINE_PROFILE,
}) {
  const scenariosByProtocol = officialAuthProfileDescriptor(profile).scenariosByProtocol;
  return Object.entries(scenariosByProtocol).flatMap(([protocolVersion, scenarios]) =>
    scenarios.map((scenario) => ({
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

export function officialAuthProfileDescriptor(profile) {
  if (!Object.hasOwn(OFFICIAL_AUTH_CONFORMANCE_PROFILES, profile)) {
    throw new Error('Official MCP client conformance profile is invalid');
  }
  return OFFICIAL_AUTH_CONFORMANCE_PROFILES[profile];
}

export function parseOfficialAuthProfile(argv) {
  const args = argv[0] === '--' && argv.length > 1 ? argv.slice(1) : argv;
  if (args.length === 0) {
    return BASELINE_PROFILE;
  }
  if (args.length === 2 && args[0] === '--profile') {
    if (args[1] === CORE_PROFILE) {
      return CORE_PROFILE;
    }
    if (args[1] === MODERN_CLOSEOUT_PROFILE) {
      return MODERN_CLOSEOUT_PROFILE;
    }
  }
  throw new Error('Official MCP client conformance profile arguments are invalid');
}

function evidencePathForProfile(profile) {
  return path.join(REPO_ROOT, officialAuthProfileDescriptor(profile).evidencePath);
}

export function validateExpectedFailureLedgers(
  repoRoot,
  { readDirectory = readdirSync, readFile = readFileSync } = {}
) {
  const ledgerRoot = path.join(repoRoot, 'packages/mcp-test-lab/conformance/expected-failures');
  const expectedFiles = OFFICIAL_AUTH_PROTOCOL_VERSIONS.map(
    (protocolVersion) => `${protocolVersion}.json`
  );
  const actualFiles = [...readDirectory(ledgerRoot)].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Official MCP expected-failure ledger files are invalid');
  }
  return Object.fromEntries(
    OFFICIAL_AUTH_PROTOCOL_VERSIONS.map((protocolVersion) => {
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

export function buildOfficialAuthEvidence({
  completedAt,
  git,
  ledgers,
  profile = BASELINE_PROFILE,
  report,
  startedAt,
}) {
  const descriptor = officialAuthProfileDescriptor(profile);
  const results = report.waves.flatMap((wave) => wave.results);
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.length - passed;
  const evidence = {
    completedAt,
    conformance: {
      package: '@modelcontextprotocol/conformance',
      prerelease: true,
      // `required` records the project's gate posture, not whether this run
      // happened in CI: since BST-1582 the official jobs in
      // .github/workflows/mcp-verification.yml carry no `continue-on-error`,
      // and mcp-verification-ci-contract.test.mjs pins this value to that
      // absence relationally. A local run therefore also writes `true`.
      required: true,
      version: CONFORMANCE_VERSION,
    },
    expectedFailures: ledgers,
    git,
    schemaVersion: descriptor.schemaVersion,
    startedAt,
    summary: {
      cleanup: report.failureIds.some((id) => id.endsWith('/cleanup')) ? 'failed' : 'confirmed',
      executions: results.length,
      failed,
      passed,
    },
    ticket: descriptor.ticket,
    waves: report.waves,
  };
  return descriptor.evidenceProfile ? { ...evidence, profile } : evidence;
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

/**
 * Signal a whole POSIX process group and classify the kernel's answer.
 *
 * `ESRCH` is the only proof the group is gone. `EPERM` is normally NOT a
 * denial: it reports the post-reap race, in which the group's remaining
 * members are all killed-but-unreaped zombies. Kernels disagree on how that
 * window looks, so the RULING ports but the mechanism does not — Darwin's
 * `killpg1()` drops zombies from its signalable count and answers EPERM, while
 * Linux keeps them in the group until `release_task()` and simply succeeds.
 * Either way the group is not gone. The state is transient (measured: ESRCH
 * follows within ~10ms) and is exactly what the confirmation loop is for, so
 * 'unsignalable' polls on like 'alive' rather than short-circuiting either way.
 * Returning early on it would be unsound in the other direction, because a
 * process group outlives its leader. A genuinely permanent EPERM — a
 * descendant that changed credentials, or a reused pid owned by someone else —
 * therefore surfaces as the bounded confirmation failure below, which names
 * the state it gave up on. Same ruling as
 * `packages/agent/src/fence/fence-executor.ts`.
 */
function signalPosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return 'alive';
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return 'gone';
    }
    if (hasErrorCode(error, 'EPERM')) {
      return 'unsignalable';
    }
    throw error;
  }
}

export async function killPosixProcessGroup(pid, signal) {
  let state = signalPosixProcessGroup(pid, signal);
  if (state === 'gone') {
    return;
  }
  if (signal !== 'SIGKILL') {
    return;
  }
  const deadline = Date.now() + POSIX_GROUP_TEARDOWN_CONFIRMATION_MS;
  while (Date.now() < deadline) {
    state = signalPosixProcessGroup(pid, 0);
    if (state === 'gone') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Name the state we gave up on: a group still 'unsignalable' at the deadline
  // is a real permission failure, not the post-reap race, and the two need to
  // be distinguishable in CI logs.
  throw new Error(
    `Official MCP conformance process-group teardown could not be confirmed; the group was still ${state} after ${POSIX_GROUP_TEARDOWN_CONFIRMATION_MS}ms`
  );
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
    stdioFlushGraceMs = OFFICIAL_STDIO_FLUSH_GRACE_MS,
    windowsJob,
  } = {}
) {
  const ownsWindowsJob = platform === 'win32';
  if (ownsWindowsJob && !initializedWindowsJobs.has(windowsJob)) {
    return Promise.reject(
      new Error('Official MCP conformance requires assigned Windows Job Object ownership')
    );
  }
  const diagnostics = createOfficialDiagnosticCollector();
  let child;
  try {
    child = spawnProcess(invocation.command, [...invocation.argv], {
      cwd,
      detached: !ownsWindowsJob,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
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

  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => diagnostics.collect(chunk));
  child.stderr?.on('data', (chunk) => diagnostics.collect(chunk));

  return new Promise((resolve, reject) => {
    const processGroupId = child.pid;
    let settled = false;
    let timedOut = false;
    let graceTimer;
    let deadlineTimer;
    let exitGraceTimer;
    let startFailureImmediate;
    const rejectWithDiagnostics = (failure) =>
      reject(attachInvocationDiagnostics(failure, diagnostics));
    const finish = async (failure, { killOwnedGroup = true } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      clearTimeout(exitGraceTimer);
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
          rejectWithDiagnostics(createCleanupFailure(invocation.id, failure, cleanupCause));
          return;
        }
      }
      if (failure) {
        rejectWithDiagnostics(failure);
        return;
      }
      resolve();
    };
    const completeInvocation = (code, signal) => {
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
    child.once('exit', (code, signal) => {
      if (settled) {
        return;
      }
      // The child is gone; the only remaining wait is the bounded stdio
      // flush, so the process deadline must not fire and mislabel a clean
      // exit inside the grace window as a timeout.
      clearTimeout(deadlineTimer);
      exitGraceTimer = setTimeout(() => completeInvocation(code, signal), stdioFlushGraceMs);
    });
    child.once('close', (code, signal) => {
      clearTimeout(exitGraceTimer);
      completeInvocation(code, signal);
    });
  });
}

export async function runOfficialClientInvocations(
  invocations,
  {
    cwd,
    deadlineMs,
    env = buildControlledEnvironment(),
    loadWindowsJob = loadWindowsJobNative,
    now = Date.now,
    platform = process.platform,
    profile = BASELINE_PROFILE,
    provisionClientRuntime = provisionElectronClientRuntime,
    runInvocation = runOfficialClientInvocation,
    writeDiagnostics = (text) => process.stderr.write(text),
  } = {}
) {
  const descriptor = officialAuthProfileDescriptor(profile);
  const scenariosByProtocol = descriptor.scenariosByProtocol;
  const invocationDeadlineMs = deadlineMs ?? descriptor.scenarioDeadlineMs;
  const profileProtocols = Object.keys(scenariosByProtocol);
  const canonicalInvocations = profileProtocols.flatMap((protocolVersion) =>
    scenariosByProtocol[protocolVersion].map((scenario) => ({
      id: `${protocolVersion}/${scenario}`,
      protocolVersion,
    }))
  );
  if (
    invocations.length !== canonicalInvocations.length ||
    invocations.some(
      (invocation, index) =>
        invocation.id !== canonicalInvocations[index]?.id ||
        invocation.protocolVersion !== canonicalInvocations[index]?.protocolVersion
    )
  ) {
    const executionCount = canonicalInvocations.length;
    throw new Error(
      `Official MCP ${descriptor.displayName} conformance requires the exact canonical ${executionCount}-scenario matrix`
    );
  }
  const windowsJob = initializeWindowsJobOwnership(platform, loadWindowsJob);
  await provisionClientRuntime();
  const failures = [];
  const waves = [];
  for (const protocolVersion of profileProtocols) {
    const waveStartedAt = now();
    const wave = invocations.filter((invocation) => invocation.protocolVersion === protocolVersion);
    const runScenario = async (invocation) => {
      const startedAt = now();
      try {
        await runInvocation(invocation, {
          cwd,
          deadlineMs: invocationDeadlineMs,
          deferWindowsCleanup:
            platform === 'win32' && descriptor.execution === 'parallel-by-protocol',
          env,
          platform,
          windowsJob,
        });
        return { durationMs: now() - startedAt, id: invocation.id, status: 'passed' };
      } catch (error) {
        const failureType = classifyInvocationFailure(error);
        writeDiagnostics(
          formatOfficialInvocationDiagnostics(
            invocation.id,
            failureType,
            getInvocationDiagnostics(error)
          )
        );
        return {
          durationMs: now() - startedAt,
          failureType,
          id: invocation.id,
          status: 'failed',
        };
      }
    };
    const results = [];
    if (descriptor.execution === 'sequential') {
      for (const invocation of wave) {
        results.push(await runScenario(invocation));
      }
    } else {
      results.push(...(await Promise.all(wave.map(runScenario))));
    }
    for (const result of results) {
      if (result.status === 'failed') {
        failures.push(new Error(result.id));
      }
    }
    if (windowsJob) {
      try {
        await terminateWindowsJobChildren(windowsJob);
      } catch {
        failures.push(new Error(`${protocolVersion}/${descriptor.cleanupScope}/cleanup`));
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
      `Official MCP ${descriptor.displayName} conformance failed: ${failures.map(({ message }) => message).join(', ')}`
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
  {
    completedAt,
    failure,
    ledgers,
    outputPath,
    profile = BASELINE_PROFILE,
    report,
    repoRoot,
    startedAt,
  },
  { readGitEvidence = resolveGitEvidence, writeEvidence = writeOfficialAuthEvidence } = {}
) {
  try {
    const evidence = buildOfficialAuthEvidence({
      completedAt,
      git: readGitEvidence(repoRoot),
      ledgers,
      profile,
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
        `Official MCP ${officialAuthProfileDescriptor(profile).displayName} conformance failed and sanitized evidence persistence failed`
      );
    }
    throw evidenceFailure;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const profile = parseOfficialAuthProfile(argv);
  const startedAt = new Date().toISOString();
  const ledgers = validateExpectedFailureLedgers(REPO_ROOT);
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: resolvePinnedConformanceEntry(REPO_ROOT),
    profile,
  });
  let failure;
  let report;
  try {
    report = await runOfficialClientInvocations(invocations, {
      cwd: REPO_ROOT,
      env: buildControlledEnvironment(),
      profile,
      provisionClientRuntime: provisionElectronClientRuntime,
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
    outputPath: evidencePathForProfile(profile),
    profile,
    repoRoot: REPO_ROOT,
    report,
    startedAt,
  });
  process.stdout.write(
    `Official MCP ${officialAuthProfileDescriptor(profile).displayName} conformance passed ${evidence.summary.passed}/${evidence.summary.executions} executions\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Official MCP client conformance failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    process.exitCode = 1;
  });
}
