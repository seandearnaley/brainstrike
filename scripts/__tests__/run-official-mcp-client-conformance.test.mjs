import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildControlledEnvironment,
  buildOfficialClientInvocations,
  initializeWindowsJobOwnership,
  OFFICIAL_OUTPUT_ROOT,
  resolvePinnedConformanceEntry,
  runOfficialClientInvocation,
  runOfficialClientInvocations,
} from '../run-official-mcp-client-conformance.mjs';

const assignWindowsJob = (windowsJob) => initializeWindowsJobOwnership('win32', () => windowsJob);

test('builds exact core and auth invocations for both pinned protocol revisions', () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath:
      '/repo/packages/mcp-test-lab/node_modules/@modelcontextprotocol/conformance/dist/index.js',
    nodePath: '/runtime/node',
    outputRoot: '/repo/artifacts/official-client',
    repoRoot: '/repo',
  });

  assert.deepEqual(
    invocations.map(({ argv, command }) => ({ argv, command })),
    ['2025-11-25', '2026-07-28'].flatMap((protocolVersion) =>
      ['core', 'auth'].map((suite) => ({
        argv: [
          '/repo/packages/mcp-test-lab/node_modules/@modelcontextprotocol/conformance/dist/index.js',
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
        command: '/runtime/node',
      }))
    )
  );
});

test('resolves the exact pinned JavaScript entry instead of a platform shim', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  assert.equal(
    resolvePinnedConformanceEntry(repoRoot),
    fileURLToPath(
      new URL(
        '../../packages/mcp-test-lab/node_modules/@modelcontextprotocol/conformance/dist/index.js',
        import.meta.url
      )
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

test('settles a pid-less spawn even when the injected child emits no error', async () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined });
  await assert.rejects(
    runOfficialClientInvocation(
      { argv: ['client'], command: '/missing/conformance', id: 'pid-less' },
      { spawnProcess: () => child }
    ),
    /pid-less failed to start/u
  );
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
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
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

test('assigns the outer Windows process to the native Job before any suite starts', async () => {
  const order = [];
  const windowsJob = {
    activeProcessCount: () => 1,
    initialize: () => order.push('assign'),
    terminateOtherProcesses: () => 0,
  };

  await runOfficialClientInvocations(
    [{ argv: ['client'], command: 'conformance.exe', id: '2026-07-28/core' }],
    {
      loadWindowsJob: () => windowsJob,
      platform: 'win32',
      runInvocation: async (_invocation, options) => {
        order.push('spawn');
        assert.equal(options.platform, 'win32');
        assert.equal(options.windowsJob, windowsJob);
      },
    }
  );

  assert.deepEqual(order, ['assign', 'spawn']);
});

test('preserves native Windows Job load and assignment causes', () => {
  const loadCause = new Error('missing native addon path');
  assert.throws(
    () =>
      initializeWindowsJobOwnership('win32', () => {
        throw loadCause;
      }),
    (error) =>
      error.message ===
        'Official MCP conformance cannot start on Windows without Job Object ownership' &&
      error.cause === loadCause
  );

  const assignmentCause = new Error('AssignProcessToJobObject failed');
  assert.throws(
    () =>
      initializeWindowsJobOwnership('win32', () => ({
        activeProcessCount: () => 1,
        initialize: () => {
          throw assignmentCause;
        },
        terminateOtherProcesses: () => 0,
      })),
    (error) =>
      error.message === 'Official MCP conformance Windows Job Object assignment failed' &&
      error.cause === assignmentCause
  );
});

test('initializes a cached Windows Job controller only once', () => {
  let initializeCalls = 0;
  const windowsJob = {
    activeProcessCount: () => 1,
    initialize: () => {
      initializeCalls += 1;
    },
    terminateOtherProcesses: () => 0,
  };

  assert.equal(
    initializeWindowsJobOwnership('win32', () => windowsJob),
    windowsJob
  );
  assert.equal(
    initializeWindowsJobOwnership('win32', () => windowsJob),
    windowsJob
  );
  assert.equal(initializeCalls, 1);
});

test('refuses an unassigned Windows Job controller before spawning', async () => {
  let spawned = false;
  await assert.rejects(
    runOfficialClientInvocation(
      { argv: ['client'], command: 'conformance.exe', id: 'unassigned-job' },
      {
        platform: 'win32',
        spawnProcess: () => {
          spawned = true;
          return Object.assign(new EventEmitter(), { pid: 199 });
        },
        windowsJob: {
          activeProcessCount: () => 1,
          initialize: () => {},
          terminateOtherProcesses: () => 0,
        },
      }
    ),
    /requires assigned Windows Job Object ownership/u
  );
  assert.equal(spawned, false);
});

test('uses only the owned Windows Job and controlled process inputs after a clean close', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 211 });
  const calls = [];
  let activeProcesses = 2;
  const windowsJob = assignWindowsJob({
    activeProcessCount: () => activeProcesses,
    initialize: () => {},
    terminateOtherProcesses: (exitCode) => {
      calls.push(['terminate', exitCode]);
      activeProcesses = 1;
      return 1;
    },
  });
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: 'conformance.exe', id: '2026-07-28/core' },
    {
      env: { NO_COLOR: '1', PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
      spawnProcess: (command, argv, options) => {
        calls.push(['spawn', command, argv, options]);
        return child;
      },
      windowsJob,
    }
  );
  child.emit('close', 0, null);

  await assert.doesNotReject(result);
  assert.deepEqual(calls, [
    [
      'spawn',
      'conformance.exe',
      ['client'],
      {
        cwd: undefined,
        detached: false,
        env: { NO_COLOR: '1', PATH: 'C:\\Windows\\System32' },
        shell: false,
        stdio: 'ignore',
      },
    ],
    ['terminate', 1],
  ]);
});

test('terminates the owned Windows Job at the deadline without a POSIX signal fallback', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 223 });
  const calls = [];
  let activeProcesses = 2;
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: 'conformance.exe', id: '2026-07-28/auth' },
    {
      deadlineMs: 5,
      killGroup: async () => calls.push('posix-kill'),
      platform: 'win32',
      spawnProcess: () => child,
      windowsJob: assignWindowsJob({
        activeProcessCount: () => activeProcesses,
        initialize: () => {},
        terminateOtherProcesses: (exitCode) => {
          calls.push(['terminate', exitCode]);
          activeProcesses = 1;
          return 1;
        },
      }),
    }
  );

  await assert.rejects(result, /2026-07-28\/auth exceeded its 5ms process deadline/u);
  assert.deepEqual(calls, [['terminate', 1]]);
});

test('preserves synchronous and asynchronous Windows start failures with cleanup causes', async () => {
  const syncCause = new Error('CreateProcess failed');
  await assert.rejects(
    runOfficialClientInvocation(
      { argv: ['client'], command: 'conformance.exe', id: 'sync-start' },
      {
        platform: 'win32',
        spawnProcess: () => {
          throw syncCause;
        },
        windowsJob: assignWindowsJob({
          activeProcessCount: () => 1,
          initialize: () => {},
          terminateOtherProcesses: () => 0,
        }),
      }
    ),
    (error) => error.message.endsWith('sync-start failed to start') && error.cause === syncCause
  );

  const child = Object.assign(new EventEmitter(), { pid: undefined });
  const cleanupCause = new Error('job membership query failed');
  const asyncStartCause = new Error('CreateProcess async failure');
  const asyncResult = runOfficialClientInvocation(
    { argv: ['client'], command: 'conformance.exe', id: 'async-start' },
    {
      platform: 'win32',
      spawnProcess: () => child,
      windowsJob: assignWindowsJob({
        activeProcessCount: () => {
          throw cleanupCause;
        },
        initialize: () => {},
        terminateOtherProcesses: () => 0,
      }),
    }
  );
  queueMicrotask(() => child.emit('error', asyncStartCause));

  await assert.rejects(
    asyncResult,
    (error) =>
      error.message.endsWith('async-start cleanup failed') &&
      error.cause instanceof AggregateError &&
      error.cause.errors.some(
        (cause) =>
          cause.message.endsWith('async-start failed to start') && cause.cause === asyncStartCause
      ) &&
      error.cause.errors.includes(cleanupCause)
  );
});

test('preserves timeout or exit failure together with Windows cleanup failure', async () => {
  const run = async ({ close, deadlineMs = 1000, id }) => {
    const child = Object.assign(new EventEmitter(), { pid: 227 });
    const cleanupCause = new Error(`${id} cleanup failed`);
    const result = runOfficialClientInvocation(
      { argv: ['client'], command: 'conformance.exe', id },
      {
        deadlineMs,
        platform: 'win32',
        spawnProcess: () => child,
        windowsJob: assignWindowsJob({
          activeProcessCount: () => {
            throw cleanupCause;
          },
          initialize: () => {},
          terminateOtherProcesses: () => 0,
        }),
      }
    );
    close?.(child);
    return assert.rejects(
      result,
      (error) =>
        error.message.endsWith(`${id} cleanup failed`) &&
        error.cause instanceof AggregateError &&
        error.cause.errors.some((cause) => cause.message.includes(id)) &&
        error.cause.errors.includes(cleanupCause)
    );
  };

  await run({ close: (child) => child.emit('close', 9, null), id: 'failed-exit' });
  await run({ deadlineMs: 5, id: 'timed-out' });
});

test('surfaces Windows cleanup failure after an otherwise clean close', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 229 });
  const cleanupCause = new Error('clean-close membership query failed');
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: 'conformance.exe', id: 'clean-close' },
    {
      platform: 'win32',
      spawnProcess: () => child,
      windowsJob: assignWindowsJob({
        activeProcessCount: () => {
          throw cleanupCause;
        },
        initialize: () => {},
        terminateOtherProcesses: () => 0,
      }),
    }
  );
  child.emit('close', 0, null);

  await assert.rejects(
    result,
    (error) => error.message.endsWith('clean-close cleanup failed') && error.cause === cleanupCause
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
