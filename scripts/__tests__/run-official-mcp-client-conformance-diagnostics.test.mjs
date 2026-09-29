import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

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
