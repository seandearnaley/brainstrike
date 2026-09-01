#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

export function buildOfficialClientInvocations({ binaryPath, outputRoot, repoRoot }) {
  return PROTOCOL_VERSIONS.flatMap((protocolVersion) =>
    SUITES.map((suite) => ({
      argv: [
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
      command: binaryPath,
      id: `${protocolVersion}/${suite}`,
    }))
  );
}

function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
    spawnProcess = spawn,
  } = {}
) {
  if (process.platform === 'win32' && killGroup === killPosixProcessGroup) {
    return Promise.reject(
      new Error('Official MCP conformance requires Windows Job Object ownership on Windows')
    );
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(invocation.command, [...invocation.argv], {
        cwd,
        detached: true,
        env,
        shell: false,
        stdio: 'ignore',
      });
    } catch {
      reject(new Error(`Official MCP conformance ${invocation.id} failed to start`));
      return;
    }

    const processGroupId = child.pid;
    let settled = false;
    let timedOut = false;
    let graceTimer;
    let deadlineTimer;
    const finish = async (failure, { killOwnedGroup = true } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      if (killOwnedGroup && processGroupId !== undefined) {
        try {
          await killGroup(processGroupId, 'SIGKILL');
        } catch (cleanupCause) {
          const cause = failure
            ? new AggregateError(
                [failure, cleanupCause],
                `Official MCP conformance ${invocation.id} invocation and cleanup failed`
              )
            : cleanupCause;
          reject(new Error(`Official MCP conformance ${invocation.id} cleanup failed`, { cause }));
          return;
        }
      }
      if (failure) {
        reject(failure);
        return;
      }
      resolve();
    };

    child.once('error', () => {
      void finish(new Error(`Official MCP conformance ${invocation.id} failed to start`), {
        killOwnedGroup: processGroupId !== undefined,
      });
    });
    if (processGroupId === undefined) {
      void finish(new Error(`Official MCP conformance ${invocation.id} failed to start`), {
        killOwnedGroup: false,
      });
      return;
    }

    deadlineTimer = setTimeout(() => {
      timedOut = true;
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
    runInvocation = runOfficialClientInvocation,
  } = {}
) {
  const failures = [];
  for (const invocation of invocations) {
    try {
      await runInvocation(invocation, { cwd, deadlineMs, env });
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

function resolvePinnedBinary(repoRoot) {
  const packageRoot = path.join(
    repoRoot,
    'packages/mcp-test-lab/node_modules/@modelcontextprotocol/conformance'
  );
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== CONFORMANCE_VERSION || manifest.bin?.conformance !== 'dist/index.js') {
    throw new Error(`Official MCP conformance install is not ${CONFORMANCE_VERSION}`);
  }
  return path.join(repoRoot, 'packages/mcp-test-lab/node_modules/.bin/conformance');
}

export async function main() {
  const invocations = buildOfficialClientInvocations({
    binaryPath: resolvePinnedBinary(REPO_ROOT),
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
