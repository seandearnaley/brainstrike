import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildOfficialAuthEvidence,
  buildOfficialClientInvocations,
  OFFICIAL_MODERN_AUTH_EVIDENCE_PATH,
  OFFICIAL_MODERN_AUTH_SCENARIOS,
  parseOfficialAuthProfile,
  runOfficialClientInvocations,
} from '../run-official-mcp-client-conformance.mjs';

const EXPECTED_SCENARIOS = [
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

test('builds one exact modern-only eleven-execution profile', () => {
  assert.deepEqual(OFFICIAL_MODERN_AUTH_SCENARIOS, EXPECTED_SCENARIOS);
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
    profile: 'modern-closeout',
  });

  assert.deepEqual(
    invocations.map(({ id, protocolVersion }) => ({ id, protocolVersion })),
    EXPECTED_SCENARIOS.map((scenario) => ({
      id: `2026-07-28/${scenario}`,
      protocolVersion: '2026-07-28',
    }))
  );
  assert.equal(invocations.length, 11);
  assert.equal(
    invocations.some(({ argv }) => argv.includes('--expected-failures')),
    false
  );
  assert.equal(
    invocations.some(({ argv }) => argv.includes('--output-dir')),
    false
  );
});

test('accepts only the closed official profile arguments', () => {
  assert.equal(parseOfficialAuthProfile([]), 'baseline');
  assert.equal(parseOfficialAuthProfile(['--profile', 'core']), 'core');
  assert.equal(parseOfficialAuthProfile(['--', '--profile', 'core']), 'core');
  assert.equal(parseOfficialAuthProfile(['--profile', 'modern-closeout']), 'modern-closeout');
  assert.equal(parseOfficialAuthProfile(['--', '--profile', 'modern-closeout']), 'modern-closeout');
  for (const argv of [
    ['--profile'],
    ['--profile', 'unknown'],
    ['--profile', 'modern-closeout', 'extra'],
    ['--output-dir', '/tmp/raw-auth'],
  ]) {
    assert.throws(() => parseOfficialAuthProfile(argv), /profile arguments are invalid/u);
  }
});

test('runs the modern-only profile as one sequentially owned wave and rejects shape drift', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
    profile: 'modern-closeout',
  });
  let active = 0;
  let maxActive = 0;
  const windowsJob = {
    activeProcessCount: () => 1,
    initialize: () => undefined,
    terminateOtherProcesses: () => 0,
  };
  const report = await runOfficialClientInvocations(invocations, {
    loadWindowsJob: () => windowsJob,
    platform: 'win32',
    profile: 'modern-closeout',
    provisionClientRuntime: async () => undefined,
    runInvocation: async (_invocation, options) => {
      assert.equal(options.deadlineMs, 45_000);
      assert.equal(options.deferWindowsCleanup, false);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    },
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(
    report.waves.map(({ protocolVersion }) => protocolVersion),
    ['2026-07-28']
  );
  assert.equal(report.waves[0].results.length, 11);
  await assert.rejects(
    runOfficialClientInvocations(invocations.slice(1), { profile: 'modern-closeout' }),
    /exact canonical 11-scenario matrix/u
  );
});

test('builds fixed secret-safe BST-1576 evidence without a raw auth directory', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    profile: 'modern-closeout',
  });
  const report = await runOfficialClientInvocations(invocations, {
    profile: 'modern-closeout',
    provisionClientRuntime: async () => undefined,
    runInvocation: async () => undefined,
  });
  const evidence = buildOfficialAuthEvidence({
    completedAt: '2026-09-01T06:01:00.000Z',
    git: { clean: true, head: 'a'.repeat(40) },
    ledgers: {
      '2025-11-25': { client: [] },
      '2026-07-28': { client: [] },
    },
    profile: 'modern-closeout',
    report,
    startedAt: '2026-09-01T06:00:00.000Z',
  });

  assert.equal(evidence.profile, 'modern-closeout');
  assert.equal(evidence.ticket, 'BST-1576');
  assert.deepEqual(evidence.summary, {
    cleanup: 'confirmed',
    executions: 11,
    failed: 0,
    passed: 11,
  });
  assert.match(
    OFFICIAL_MODERN_AUTH_EVIDENCE_PATH,
    /official-auth-modern-closeout-evidence\.json$/u
  );
  assert.equal(path.extname(OFFICIAL_MODERN_AUTH_EVIDENCE_PATH), '.json');
  const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^packages\/mcp-test-lab\/artifacts\/$/mu);
  assert.equal(JSON.stringify(evidence).includes('credential-bearing child diagnostic'), false);
});
