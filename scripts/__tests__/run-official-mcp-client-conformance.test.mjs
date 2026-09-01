import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildControlledEnvironment,
  buildOfficialClientInvocations,
  OFFICIAL_OUTPUT_ROOT,
  runOfficialClientInvocation,
  runOfficialClientInvocations,
} from '../run-official-mcp-client-conformance.mjs';

test('builds exact core and auth invocations for both pinned protocol revisions', () => {
  const invocations = buildOfficialClientInvocations({
    binaryPath: '/repo/packages/mcp-test-lab/node_modules/.bin/conformance',
    outputRoot: '/repo/artifacts/official-client',
    repoRoot: '/repo',
  });

  assert.deepEqual(
    invocations.map(({ argv, command }) => ({ argv, command })),
    ['2025-11-25', '2026-07-28'].flatMap((protocolVersion) =>
      ['core', 'auth'].map((suite) => ({
        argv: [
          'client',
          '--command',
          'node apps/desktop/dist/official-conformance-client-entry.js',
          '--suite',
          suite,
          '--spec-version',
          protocolVersion,
          '--expected-failures',
          `/repo/packages/mcp-test-lab/conformance/expected-failures/${protocolVersion}.json`,
          '--timeout',
          '30000',
          '--output-dir',
          `/repo/artifacts/official-client/${protocolVersion}/${suite}`,
        ],
        command: '/repo/packages/mcp-test-lab/node_modules/.bin/conformance',
      }))
    )
  );
});

test('allowlists child environment and strips conformance context and host secrets', () => {
  assert.deepEqual(
    buildControlledEnvironment({
      CI: 'true',
      HOME: '/home/test',
      MCP_CONFORMANCE_CONTEXT: '{"clientSecret":"secret"}',
      PATH: '/bin',
      SECRET_TOKEN: 'secret',
      TMPDIR: '/tmp',
    }),
    { CI: 'true', HOME: '/home/test', NO_COLOR: '1', PATH: '/bin', TMPDIR: '/tmp' }
  );
});

test('writes only beneath the existing ignored MCP test-lab artifact directory', () => {
  const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(
    OFFICIAL_OUTPUT_ROOT,
    /packages\/mcp-test-lab\/artifacts\/official-client-conformance$/u
  );
  assert.match(gitignore, /^packages\/mcp-test-lab\/artifacts\/$/mu);
});

test('handles an asynchronous spawn error when no process group was created', async () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined });
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: '/missing/conformance', id: '2025-11-25/core' },
    { spawnProcess: () => child }
  );
  queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));

  await assert.rejects(result, /2025-11-25\/core failed to start/u);
});

test('spawns without a shell and SIGKILLs the owned group after a clean close', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 71 });
  const calls = [];
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: '/bin/conformance', id: '2025-11-25/core' },
    {
      deadlineMs: 1000,
      env: { PATH: '/bin' },
      killGroup: async (pid, signal) => calls.push(['kill', pid, signal]),
      spawnProcess: (command, argv, options) => {
        calls.push(['spawn', command, argv, options]);
        return child;
      },
    }
  );
  child.emit('close', 0, null);

  await assert.doesNotReject(result);
  assert.deepEqual(calls, [
    [
      'spawn',
      '/bin/conformance',
      ['client'],
      { cwd: undefined, detached: true, env: { PATH: '/bin' }, shell: false, stdio: 'ignore' },
    ],
    ['kill', 71, 'SIGKILL'],
  ]);
});

test('enforces the deadline with SIGTERM then SIGKILL and reports no child output', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 83 });
  const signals = [];
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: '/bin/conformance', id: '2026-07-28/auth' },
    {
      deadlineMs: 5,
      env: {},
      killGraceMs: 5,
      killGroup: async (_pid, signal) => signals.push(signal),
      spawnProcess: () => child,
    }
  );

  await assert.rejects(result, /2026-07-28\/auth exceeded its 5ms process deadline/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('runs all four suites, preserves every failure, and applies suite deadline headroom', async () => {
  const invocations = buildOfficialClientInvocations({
    binaryPath: '/repo/conformance',
    outputRoot: '/repo/packages/mcp-test-lab/artifacts/official-client-conformance',
    repoRoot: '/repo',
  });
  const observed = [];

  await assert.rejects(
    runOfficialClientInvocations(invocations, {
      cwd: '/repo',
      env: { PATH: '/bin' },
      runInvocation: async (invocation, options) => {
        observed.push({ deadlineMs: options.deadlineMs, id: invocation.id });
        if (invocation.id.endsWith('/auth')) {
          throw new Error('C2b auth adapter is not implemented');
        }
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.message.includes('2025-11-25/core') &&
      error.message.includes('2026-07-28/auth')
  );
  assert.deepEqual(
    observed,
    invocations.map(({ id }) => ({ deadlineMs: 600_000, id }))
  );
});

test('preserves the invocation failure when final cleanup also fails', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 97 });
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: '/bin/conformance', id: '2025-11-25/core' },
    {
      killGroup: async (_pid, signal) => {
        if (signal === 'SIGKILL') {
          throw new Error('kill failed');
        }
      },
      spawnProcess: () => child,
    }
  );
  child.emit('close', 9, null);

  await assert.rejects(
    result,
    (error) =>
      error instanceof Error &&
      error.message === 'Official MCP conformance 2025-11-25/core cleanup failed' &&
      error.cause instanceof AggregateError &&
      error.cause.errors.some((cause) => cause.message.includes('failed (exit 9)')) &&
      error.cause.errors.some((cause) => cause.message === 'kill failed')
  );
});

test('reaps a real POSIX process group and its descendant at the deadline', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  let processGroupId;
  const hangingParent = [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'setInterval(() => {}, 1000);',
  ].join(' ');

  await assert.rejects(
    runOfficialClientInvocation(
      {
        argv: ['-e', hangingParent],
        command: process.execPath,
        id: 'real-process-group',
      },
      {
        deadlineMs: 100,
        env: { PATH: process.env.PATH },
        killGraceMs: 50,
        spawnProcess: (command, argv, options) => {
          const child = spawn(command, argv, options);
          processGroupId = child.pid;
          return child;
        },
      }
    ),
    /real-process-group exceeded its 100ms process deadline/
  );

  assert.equal(typeof processGroupId, 'number');
  assert.throws(
    () => process.kill(-processGroupId, 0),
    (error) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
  );
});
