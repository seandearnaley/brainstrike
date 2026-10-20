import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createOfficialLifecycleTrace,
  withOfficialLifecycleTrace,
} from '../lib/official-conformance-lifecycle.mjs';

import {
  buildOfficialClientInvocations,
  createOfficialDiagnosticCollector,
  formatOfficialInvocationDiagnostics,
  getInvocationDiagnostics,
  OFFICIAL_DIAGNOSTIC_MAX_LINES,
  runOfficialClientInvocation,
  runOfficialClientInvocations,
  sanitizeOfficialDiagnosticLine,
} from '../run-official-mcp-client-conformance.mjs';

test('sanitizes diagnostic lines: URLs, OAuth params, structured secrets, bounds', () => {
  assert.equal(
    sanitizeOfficialDiagnosticLine(
      'redirect https://auth.example.test/authorize?code=abc123&state=xyz failed'
    ),
    'redirect https://auth.example.test/authorize?[redacted-query] failed'
  );
  assert.equal(
    sanitizeOfficialDiagnosticLine('exchange rejected access_token=sk-live-12345 for client'),
    'exchange rejected access_token=[redacted-oauth-parameter] for client'
  );
  assert.equal(
    sanitizeOfficialDiagnosticLine('"client_secret": "super-secret-value"'),
    '"client_secret": [redacted-structured-secret]'
  );
  assert.equal(sanitizeOfficialDiagnosticLine('    '), null);
  assert.equal(sanitizeOfficialDiagnosticLine('\u001B[31mred error\u001B[0m'), 'red error');
  const long = sanitizeOfficialDiagnosticLine('x'.repeat(2000));
  assert.equal(long.length, 512);
  assert.ok(long.endsWith('…[truncated]'));
});

test('collector keeps a bounded sanitized tail with omission markers', () => {
  const collector = createOfficialDiagnosticCollector();
  for (let index = 0; index < 100; index += 1) {
    collector.collect(`line-${index}\n`);
  }
  const lines = collector.lines();
  assert.equal(lines.length, OFFICIAL_DIAGNOSTIC_MAX_LINES + 1);
  assert.equal(lines[0], '…[60 earlier lines omitted]');
  assert.equal(lines.at(-1), 'line-99');
});

test('attaches sanitized child output to a failing invocation', async () => {
  const stderrStream = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    pid: 91,
    stderr: stderrStream,
    stdout: new EventEmitter(),
  });
  const result = runOfficialClientInvocation(
    { argv: ['client'], command: '/bin/conformance', id: '2025-11-25/auth/basic-cimd' },
    {
      deadlineMs: 1000,
      env: {},
      killGroup: async () => {},
      spawnProcess: () => child,
    }
  );
  stderrStream.emit('data', 'Scenario failed: metadata mismatch\n');
  stderrStream.emit('data', 'refresh_token=rt-secret-9 rejected\n');
  child.emit('close', 1, null);

  const failure = await result.then(
    () => assert.fail('expected rejection'),
    (error) => error
  );
  assert.match(failure.message, /basic-cimd failed \(exit 1\)/u);
  assert.deepEqual(getInvocationDiagnostics(failure), [
    'Scenario failed: metadata mismatch',
    'refresh_token=[redacted-oauth-parameter] rejected',
  ]);
  assert.ok(!JSON.stringify(failure).includes('rt-secret-9'));
});

test('emits per-scenario diagnostics for failures and none for passes', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
  });
  const failingId = invocations[0].id;
  const written = [];
  const runInvocation = (invocation) => {
    if (invocation.id !== failingId) {
      return Promise.resolve();
    }
    const failure = new Error(`Official MCP conformance ${invocation.id} failed (exit 1)`);
    Object.defineProperty(failure, 'diagnostics', {
      enumerable: false,
      value: ['metadata mismatch detail'],
    });
    return Promise.reject(failure);
  };

  await assert.rejects(
    runOfficialClientInvocations(invocations, {
      platform: 'linux',
      provisionClientRuntime: async () => undefined,
      runInvocation,
      writeDiagnostics: (text) => written.push(text),
    }),
    /Official MCP auth conformance failed: 2025-11-25\/auth\/metadata-default/u
  );

  assert.equal(written.length, 1);
  assert.equal(
    written[0],
    [
      `--- official conformance diagnostics ${failingId} (exit) ---`,
      'metadata mismatch detail',
      `--- end diagnostics ${failingId} ---`,
      '',
    ].join('\n')
  );
});

test('reports missing child output explicitly in diagnostics blocks', () => {
  assert.equal(
    formatOfficialInvocationDiagnostics('2026-07-28/auth/pre-registration', 'timeout', []),
    [
      '--- official conformance diagnostics 2026-07-28/auth/pre-registration (timeout) ---',
      '(no child output captured)',
      '--- end diagnostics 2026-07-28/auth/pre-registration ---',
      '',
    ].join('\n')
  );
});

test('drops a truncated partial line so an unlabeled secret value cannot survive', () => {
  const collector = createOfficialDiagnosticCollector();
  collector.collect(`access_token=${'a'.repeat(70_000)}\nnext line ok\n`);
  const lines = collector.lines();
  assert.equal(lines.at(-1), 'next line ok');
  assert.ok(lines[0].startsWith('…['));
  assert.ok(!lines.some((line) => line.includes('aaaa')));
});

test('discards the whole buffer when overflow leaves no complete line', () => {
  const collector = createOfficialDiagnosticCollector();
  collector.collect(`refresh_token=${'b'.repeat(70_000)}`);
  const lines = collector.lines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /earlier chars dropped/u);
  assert.ok(!lines[0].includes('bbbb'));
});

test('redacts assertion, DPoP, bare JWT, and Bearer shapes', () => {
  assert.ok(
    !sanitizeOfficialDiagnosticLine(
      'client_assertion=eyJhbGciOiJSUzI1NiJ9.payload123.signature'
    ).includes('eyJ')
  );
  assert.equal(
    sanitizeOfficialDiagnosticLine('token line eyJhbGciOiJSUzI1NiJ9.payload123.sig ends'),
    'token line [redacted-jwt] ends'
  );
  const bearer = sanitizeOfficialDiagnosticLine('Authorization: Bearer abcdef1234567890');
  assert.ok(!bearer.includes('abcdef1234567890'));
});

test('keeps ordinary error and status text readable', () => {
  assert.equal(
    sanitizeOfficialDiagnosticLine('exit code=1 after error code=ECONNREFUSED state=failed'),
    'exit code=1 after error code=ECONNREFUSED state=failed'
  );
  assert.equal(
    sanitizeOfficialDiagnosticLine('callback received code=SplxlOBeZQ0YbYS6WxSbIA'),
    'callback received code=[redacted-oauth-parameter]'
  );
});

test('lifecycle timeout records the live child and sanitized streams before unchanged cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const signals = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 92,
    signalCode: null,
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  });
  const result = runOfficialClientInvocation(
    {
      argv: ['client'],
      command: '/bin/conformance',
      id: '2026-07-28/auth/metadata-issuer-mismatch',
    },
    {
      deadlineMs: 45_000,
      env: {},
      killGroup: async (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') {
          signals.push(events.at(-1)?.event ?? 'missing-deadline');
          child.emit('exit', null, 'SIGTERM');
          child.emit('close', null, 'SIGTERM');
        }
      },
      onLifecycle: (event) => events.push(event),
      spawnProcess: () => child,
    }
  );
  const rejected = assert.rejects(result, /exceeded its 45000ms process deadline/u);
  child.emit('spawn');
  child.stdout.emit('data', 'metadata requested\n');
  child.stderr.emit('data', 'refresh_token=private-value-123\n');
  t.mock.timers.tick(44_999);
  assert.deepEqual(signals, []);
  t.mock.timers.tick(1);
  await rejected;
  assert.deepEqual(signals, ['SIGTERM', 'deadline', 'SIGKILL']);
  const deadline = events.find((event) => event.event === 'deadline');
  assert.equal(deadline.pid, 92);
  assert.equal(deadline.exitCode, null);
  assert.ok(deadline.stdout.bytes > 0);
  assert.deepEqual(
    events
      .filter((event) => ['exit', 'close'].includes(event.event))
      .map((event) => [event.event, event.code, event.signal]),
    [
      ['exit', null, 'SIGTERM'],
      ['close', null, 'SIGTERM'],
    ]
  );
  assert.equal(events.find((event) => event.event === 'cleanup-end').status, 'confirmed');
  const output = events.find((event) => event.event === 'output');
  assert.deepEqual(output.stdout, ['metadata requested']);
  assert.deepEqual(output.stderr, ['refresh_token=[redacted-oauth-parameter]']);
  assert.ok(!JSON.stringify(events).includes('private-value-123'));
});

test('lifecycle observation preserves natural exit with the bounded stdio flush grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 93,
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  });
  const result = runOfficialClientInvocation(
    { argv: [], command: '/bin/conformance', id: 'exit-before-close' },
    {
      deadlineMs: 45_000,
      env: {},
      killGroup: async () => {},
      onLifecycle: (event) => events.push(event),
      spawnProcess: () => child,
    }
  );
  child.emit('exit', 0, null);
  t.mock.timers.tick(999);
  assert.ok(!events.some((event) => event.event === 'invocation-end'));
  t.mock.timers.tick(1);
  await result;
  assert.ok(!events.some((event) => event.event === 'deadline'));
  assert.equal(events.find((event) => event.event === 'invocation-end').status, 'passed');
});

test('lifecycle profile retains every modern scenario outcome when mismatch times out', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance.js',
    profile: 'modern-closeout',
  });
  const events = [];
  await assert.rejects(
    runOfficialClientInvocations(invocations, {
      onLifecycle: (event) => events.push(event),
      platform: 'linux',
      profile: 'modern-closeout',
      provisionClientRuntime: async () => {},
      runInvocation: async (invocation) => {
        if (invocation.id.endsWith('/metadata-issuer-mismatch')) {
          throw new Error('exceeded its 45000ms process deadline');
        }
      },
      writeDiagnostics: () => {},
    }),
    /metadata-issuer-mismatch/u
  );
  assert.deepEqual(
    events.filter((event) => event.event === 'scenario-start').map((event) => event.scenario),
    invocations.map((invocation) => invocation.id)
  );
  const results = events.filter((event) => event.event === 'scenario-end');
  assert.equal(results.length, 11);
  assert.equal(results.filter((event) => event.status === 'passed').length, 10);
  assert.equal(results.at(-1).failureType, 'timeout');
});

test('lifecycle sidecar bounds events, records monotonic offsets/runtime, and reports capture failure', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'official-lifecycle-'));
  try {
    assert.equal(createOfficialLifecycleTrace('', dir), undefined);
    assert.throws(() => createOfficialLifecycleTrace('/outside/trace.json', dir), /RUNNER_TEMP/u);
    let time = 100;
    const output = path.join(dir, 'trace.json');
    const trace = createOfficialLifecycleTrace(
      output,
      dir,
      () => ({ conformanceVersion: '0.2.0-alpha.12' }),
      () => time
    );
    time = 125;
    trace.record({ event: 'spawn', pid: 1, scenario: 'fixture' });
    trace.write();
    const saved = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(saved.events[0].atMs, 25);
    assert.equal(saved.runtime.architecture, process.arch);
    assert.equal(saved.runtime.node, process.version);
    assert.equal(saved.truncated, false);
    assert.equal(saved.conformanceVersion, '0.2.0-alpha.12');
    for (let i = 0; i < 3000; i += 1) {
      trace.record({ event: 'bounded' });
    }
    assert.throws(() => trace.write(), /event bound/u);
    const truncated = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(truncated.events.length, 2048);
    assert.equal(truncated.truncated, true);
    const missing = path.join(dir, 'missing');
    const invalid = createOfficialLifecycleTrace(
      path.join(missing, 'trace.json'),
      missing,
      () => ({})
    );
    assert.throws(() => invalid.write(), { code: 'ENOENT' });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('lifecycle records start failure and unconfirmed cleanup without exposing error contents', async () => {
  const events = [];
  await assert.rejects(
    runOfficialClientInvocation(
      { argv: [], command: '/bin/conformance', id: 'start-failure' },
      {
        env: {},
        onLifecycle: (event) => events.push(event),
        spawnProcess: () => {
          throw new Error('client_secret=private');
        },
      }
    ),
    /failed to start/u
  );
  assert.ok(events.some((event) => event.event === 'spawn-error'));
  assert.ok(!JSON.stringify(events).includes('private'));
  const child = Object.assign(new EventEmitter(), { pid: 94 });
  const result = runOfficialClientInvocation(
    { argv: [], command: '/bin/conformance', id: 'cleanup-failure' },
    {
      env: {},
      killGroup: async () => {
        throw new Error('cleanup failed');
      },
      onLifecycle: (event) => events.push(event),
      spawnProcess: () => child,
    }
  );
  child.emit('close', 0, null);
  await assert.rejects(result, /cleanup failed/u);
  assert.equal(events.find((event) => event.event === 'cleanup-end').status, 'unconfirmed');
  assert.equal(events.at(-1).status, 'failed');
});

test('capture write failure preserves the primary conformance failure', async () => {
  const primary = new Error('canonical timeout');
  const capture = new Error('sidecar write failed');
  await assert.rejects(
    withOfficialLifecycleTrace(
      {
        write: () => {
          throw capture;
        },
      },
      () => Promise.reject(primary)
    ),
    (error) =>
      error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === capture
  );
  await assert.rejects(
    withOfficialLifecycleTrace(undefined, () => Promise.reject(primary)),
    (error) => error === primary
  );
  await assert.rejects(
    withOfficialLifecycleTrace(
      {
        write: () => {
          throw capture;
        },
      },
      () => Promise.resolve()
    ),
    (error) => error === capture
  );
});
