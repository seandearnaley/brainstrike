import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildControlledEnvironment,
  buildOfficialAuthEvidence,
  buildOfficialClientInvocations,
  finalizeOfficialAuthEvidence,
  initializeWindowsJobOwnership,
  OFFICIAL_ALPHA10_AUTH_SCENARIOS_BY_PROTOCOL,
  OFFICIAL_AUTH_SCENARIOS,
  OFFICIAL_EVIDENCE_PATH,
  resolvePinnedConformanceEntry,
  runOfficialClientInvocation,
  runOfficialClientInvocations,
  validateExpectedFailureLedgers,
  writeOfficialAuthEvidence,
} from '../run-official-mcp-client-conformance.mjs';

const assignWindowsJob = (windowsJob) => initializeWindowsJobOwnership('win32', () => windowsJob);

test('builds the exact 14 auth scenarios for both pinned protocol revisions', () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath:
      '/repo/packages/mcp-test-lab/node_modules/@modelcontextprotocol/conformance/dist/index.js',
    nodePath: '/runtime/node',
    repoRoot: '/repo',
  });

  const authScenarios = [
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
  assert.deepEqual(
    invocations.map(({ argv, command, id, protocolVersion }) => ({
      argv,
      command,
      id,
      protocolVersion,
    })),
    ['2025-11-25', '2026-07-28'].flatMap((protocolVersion) =>
      authScenarios.map((scenario) => ({
        argv: [
          '/repo/packages/mcp-test-lab/node_modules/@modelcontextprotocol/conformance/dist/index.js',
          'client',
          '--command',
          'node apps/desktop/dist/official-conformance-client-entry.js',
          '--scenario',
          scenario,
          '--spec-version',
          protocolVersion,
          '--timeout',
          '30000',
        ],
        command: '/runtime/node',
        id: `${protocolVersion}/${scenario}`,
        protocolVersion,
      }))
    )
  );
  assert.equal(invocations.length, 28);
  assert.equal(
    invocations.some(({ argv }) => argv.includes('--expected-failures')),
    false
  );
  assert.equal(
    invocations.some(({ argv }) => argv.includes('--output-dir')),
    false
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

test('pins Electron lazy installation as a synchronous parent-process preflight', () => {
  const electronLoader = readFileSync(
    new URL('../../apps/desktop/node_modules/electron/index.js', import.meta.url),
    'utf8'
  );
  assert.match(electronLoader, /spawnSync\(process\.execPath/u);
  assert.match(electronLoader, /path\.join\(__dirname, 'install\.js'\)/u);
  assert.match(electronLoader, /if \(!fs\.existsSync\(fullPath\)\) \{\s*downloadElectron\(\);/u);
});

test('pins the canonical auth manifest against the installed alpha.10 CLI', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const entry = resolvePinnedConformanceEntry(repoRoot);
  for (const protocolVersion of ['2025-11-25', '2026-07-28']) {
    const listed = execFileSync(
      process.execPath,
      [entry, 'list', '--client', '--spec-version', protocolVersion],
      { encoding: 'utf8', timeout: 10_000 }
    );
    const canonical = listed
      .split('\n')
      .map((line) => /^ {2}- (auth\/[^ ]+)/u.exec(line)?.[1])
      .filter((scenario) => scenario !== undefined);
    assert.deepEqual(canonical, OFFICIAL_ALPHA10_AUTH_SCENARIOS_BY_PROTOCOL[protocolVersion]);
  }
});

test('accepts only the two exact empty client expected-failure ledgers', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  assert.deepEqual(validateExpectedFailureLedgers(repoRoot), {
    '2025-11-25': { client: [] },
    '2026-07-28': { client: [] },
  });

  assert.throws(
    () =>
      validateExpectedFailureLedgers('/repo', {
        readDirectory: () => ['2025-11-25.json', '2026-07-28.json'],
        readFile: (filePath) =>
          filePath.endsWith('2025-11-25.json')
            ? '{"client":["auth/metadata-default"]}'
            : '{"client":[]}',
      }),
    /expected-failure ledgers must remain exactly empty/u
  );
  assert.throws(
    () =>
      validateExpectedFailureLedgers('/repo', {
        readDirectory: () => ['2025-11-25.json', '2026-07-28.json', 'extra.json'],
        readFile: () => '{"client":[]}',
      }),
    /expected-failure ledger files are invalid/u
  );
});

test('distinguishes unreadable or malformed ledgers from non-empty ledgers', () => {
  const readFailure = new Error('disk unavailable');
  assert.throws(
    () =>
      validateExpectedFailureLedgers('/repo', {
        readDirectory: () => ['2025-11-25.json', '2026-07-28.json'],
        readFile: () => {
          throw readFailure;
        },
      }),
    (error) =>
      error.message ===
        'Official MCP expected-failure ledger 2025-11-25.json is unreadable or malformed' &&
      error.cause === readFailure
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

test('writes only one sanitized evidence file beneath the ignored MCP artifact directory', () => {
  const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(
    OFFICIAL_EVIDENCE_PATH,
    /packages\/mcp-test-lab\/artifacts\/official-auth-evidence\.json$/u
  );
  assert.equal(path.extname(OFFICIAL_EVIDENCE_PATH), '.json');
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
      {
        cwd: undefined,
        detached: true,
        env: { PATH: '/bin' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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

test('runs exactly two parallel revision waves and aggregates fixed failure ids once', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
  });
  const observed = [];
  const activeByRevision = new Map();
  let firstRevisionSettled = false;
  let maxActive = 0;
  const failedIds = ['2025-11-25/auth/metadata-var2', '2026-07-28/auth/scope-step-up'];

  await assert.rejects(
    runOfficialClientInvocations(invocations, {
      cwd: '/repo',
      env: { PATH: '/bin' },
      provisionClientRuntime: async () => undefined,
      runInvocation: async (invocation, options) => {
        observed.push({ deadlineMs: options.deadlineMs, id: invocation.id });
        assert.equal(invocation.protocolVersion === '2025-11-25' || firstRevisionSettled, true);
        const active = (activeByRevision.get(invocation.protocolVersion) ?? 0) + 1;
        activeByRevision.set(invocation.protocolVersion, active);
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        activeByRevision.set(invocation.protocolVersion, active - 1);
        if (invocation.id === '2025-11-25/auth/pre-registration') {
          firstRevisionSettled = true;
        }
        if (failedIds.includes(invocation.id)) {
          throw new Error('credential-bearing child diagnostic');
        }
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.message === `Official MCP auth conformance failed: ${failedIds.join(', ')}` &&
      error.errors.every((failure, index) => failure.message === failedIds[index])
  );
  assert.equal(maxActive, 14);
  assert.deepEqual(
    observed,
    invocations.map(({ id }) => ({ deadlineMs: 45_000, id }))
  );
});

test('provisions the shared Electron runtime once before parallel client scenarios', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
  });
  let provisionCalls = 0;
  const events = [];

  await assert.doesNotReject(
    runOfficialClientInvocations(invocations, {
      provisionClientRuntime: async () => {
        provisionCalls += 1;
        events.push('provision');
      },
      runInvocation: async () => {
        events.push('invoke');
      },
    })
  );
  assert.equal(provisionCalls, 1);
  assert.deepEqual(events, ['provision', ...Array.from({ length: 28 }, () => 'invoke')]);
});

test('rejects partial, duplicate, and reordered auth matrices before spawning', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
  });
  let spawnCount = 0;
  const options = {
    runInvocation: async () => {
      spawnCount += 1;
    },
  };
  for (const malformed of [
    invocations.slice(1),
    [...invocations, invocations[0]],
    [invocations[1], invocations[0], ...invocations.slice(2)],
  ]) {
    await assert.rejects(
      runOfficialClientInvocations(malformed, options),
      /requires the exact canonical 28-scenario matrix/u
    );
  }
  assert.equal(spawnCount, 0);
});

test('returns a sanitized 28-result timing report with no child diagnostics', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
  });
  let clock = 100;
  const report = await runOfficialClientInvocations(invocations, {
    now: () => clock,
    provisionClientRuntime: async () => undefined,
    runInvocation: async () => {
      clock += 5;
    },
  });

  assert.equal(report.waves.length, 2);
  assert.deepEqual(
    report.waves.map(({ protocolVersion, results }) => ({
      protocolVersion,
      resultIds: results.map(({ id }) => id),
    })),
    ['2025-11-25', '2026-07-28'].map((protocolVersion) => ({
      protocolVersion,
      resultIds: OFFICIAL_AUTH_SCENARIOS.map((scenario) => `${protocolVersion}/${scenario}`),
    }))
  );
  assert.equal(report.waves.flatMap(({ results }) => results).length, 28);
  assert.equal(
    report.waves
      .flatMap(({ results }) => results)
      .every(
        (result) =>
          result.status === 'passed' &&
          Number.isSafeInteger(result.durationMs) &&
          result.durationMs >= 0 &&
          Object.keys(result).length === 3
      ),
    true
  );
});

test('records only fixed failure discriminators for failed invocations', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
  });
  const messages = [
    'failed to start with credential-bearing detail',
    'exceeded its 5ms process deadline with credential-bearing detail',
    'cleanup failed with credential-bearing detail',
    'failed (exit 9) with credential-bearing detail',
  ];

  await assert.rejects(
    runOfficialClientInvocations(invocations, {
      now: () => 10,
      provisionClientRuntime: async () => undefined,
      runInvocation: async (invocation) => {
        const index = invocations.indexOf(invocation);
        if (index < messages.length) {
          throw new Error(messages[index]);
        }
      },
    }),
    (error) => {
      const failed = error.report.waves.flatMap(({ results }) =>
        results.filter(({ status }) => status === 'failed')
      );
      assert.deepEqual(
        failed.map(({ failureType }) => failureType),
        ['start', 'timeout', 'cleanup', 'exit']
      );
      assert.equal(JSON.stringify(failed).includes('credential-bearing detail'), false);
      return true;
    }
  );
});

test('writes exact-head prerelease required evidence with only fixed result data', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
  });
  const report = await runOfficialClientInvocations(invocations, {
    now: () => 10,
    provisionClientRuntime: async () => undefined,
    runInvocation: async () => {},
  });
  const evidence = buildOfficialAuthEvidence({
    completedAt: '2026-09-01T04:01:00.000Z',
    git: { clean: true, head: 'a'.repeat(40) },
    ledgers: {
      '2025-11-25': { client: [] },
      '2026-07-28': { client: [] },
    },
    report,
    startedAt: '2026-09-01T04:00:00.000Z',
  });

  assert.deepEqual(evidence.summary, {
    cleanup: 'confirmed',
    executions: 28,
    failed: 0,
    passed: 28,
  });
  assert.deepEqual(evidence.conformance, {
    package: '@modelcontextprotocol/conformance',
    prerelease: true,
    required: true,
    version: '0.2.0-alpha.12',
  });
  assert.equal(evidence.schemaVersion, '1.0.0');
  assert.equal(evidence.ticket, 'BST-1560');
  assert.equal('profile' in evidence, false);
  assert.equal(JSON.stringify(evidence).includes('credential-bearing child diagnostic'), false);

  const directory = mkdtempSync(path.join(tmpdir(), 'bst-1560-evidence-'));
  const outputPath = path.join(directory, 'official-auth-evidence.json');
  try {
    writeOfficialAuthEvidence(outputPath, evidence);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), evidence);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('keeps cleanup status separate from scenario execution totals', () => {
  const evidence = buildOfficialAuthEvidence({
    completedAt: '2026-09-01T04:01:00.000Z',
    git: { clean: true, head: 'a'.repeat(40) },
    ledgers: {
      '2025-11-25': { client: [] },
      '2026-07-28': { client: [] },
    },
    report: {
      failureIds: ['2025-11-25/auth/cleanup'],
      waves: [
        {
          durationMs: 1,
          protocolVersion: '2025-11-25',
          results: [{ durationMs: 1, id: '2025-11-25/auth/basic-cimd', status: 'passed' }],
        },
      ],
    },
    startedAt: '2026-09-01T04:00:00.000Z',
  });

  assert.deepEqual(evidence.summary, {
    cleanup: 'failed',
    executions: 1,
    failed: 0,
    passed: 1,
  });
});

test('preserves the primary conformance failure when evidence collection also fails', () => {
  const primary = new Error('fixed scenario failure');
  const evidenceFailure = new Error('git unavailable');
  assert.throws(
    () =>
      finalizeOfficialAuthEvidence(
        {
          completedAt: '2026-09-01T04:01:00.000Z',
          failure: primary,
          ledgers: {},
          outputPath: '/repo/evidence.json',
          repoRoot: '/repo',
          report: { failureIds: [], waves: [] },
          startedAt: '2026-09-01T04:00:00.000Z',
        },
        {
          readGitEvidence: () => {
            throw evidenceFailure;
          },
        }
      ),
    (error) =>
      error instanceof AggregateError &&
      error.message ===
        'Official MCP auth conformance failed and sanitized evidence persistence failed' &&
      error.errors[0] === primary &&
      error.errors[1] === evidenceFailure
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
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: 'C:\\repo\\conformance\\dist\\index.js',
    nodePath: 'node.exe',
  });
  const windowsJob = {
    activeProcessCount: () => 1,
    initialize: () => order.push('assign'),
    terminateOtherProcesses: () => 0,
  };

  await runOfficialClientInvocations(invocations, {
    loadWindowsJob: () => windowsJob,
    platform: 'win32',
    provisionClientRuntime: async () => undefined,
    runInvocation: async (_invocation, options) => {
      order.push('spawn');
      assert.equal(options.platform, 'win32');
      assert.equal(options.windowsJob, windowsJob);
    },
  });

  assert.deepEqual(order, ['assign', ...Array.from({ length: 28 }, () => 'spawn')]);
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
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ],
    ['terminate', 1],
  ]);
});

test('defers shared Windows Job cleanup until a parallel revision wave settles', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 217 });
  let terminated = 0;
  const result = runOfficialClientInvocation(
    {
      argv: ['client'],
      command: 'conformance.exe',
      id: '2026-07-28/auth/metadata-default',
    },
    {
      deferWindowsCleanup: true,
      platform: 'win32',
      spawnProcess: () => child,
      windowsJob: assignWindowsJob({
        activeProcessCount: () => 2,
        initialize: () => {},
        terminateOtherProcesses: () => {
          terminated += 1;
          return 1;
        },
      }),
    }
  );
  child.emit('close', 0, null);

  await assert.doesNotReject(result);
  assert.equal(terminated, 0);
});

test('does not terminate sibling Windows scenarios when a deferred invocation times out', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 219 });
  let terminated = 0;
  const result = runOfficialClientInvocation(
    {
      argv: ['client'],
      command: 'conformance.exe',
      id: '2026-07-28/auth/metadata-default',
    },
    {
      deadlineMs: 5,
      deferWindowsCleanup: true,
      platform: 'win32',
      spawnProcess: () => child,
      windowsJob: assignWindowsJob({
        activeProcessCount: () => 15,
        initialize: () => {},
        terminateOtherProcesses: () => {
          terminated += 1;
          return 14;
        },
      }),
    }
  );

  await assert.rejects(result, /exceeded its 5ms process deadline/u);
  assert.equal(terminated, 0);
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
