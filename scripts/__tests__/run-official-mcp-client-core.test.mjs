import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_CORE_SCENARIOS_BY_PROTOCOL } from '../../packages/assistant-contract/src/official-auth-conformance.ts';
import {
  buildOfficialAuthEvidence,
  buildOfficialClientInvocations,
  OFFICIAL_CORE_EVIDENCE_PATH,
  resolvePinnedConformanceEntry,
  runOfficialClientInvocations,
} from '../run-official-mcp-client-conformance.mjs';

test('builds the exact applicable core scenarios for both pinned protocol revisions', () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
    profile: 'core',
  });

  assert.deepEqual(
    invocations.map(({ id }) => id),
    Object.entries(OFFICIAL_CORE_SCENARIOS_BY_PROTOCOL).flatMap(([protocolVersion, scenarios]) =>
      scenarios.map((scenario) => `${protocolVersion}/${scenario}`)
    )
  );
  assert.equal(invocations.length, 13);
});

test('pins the canonical core manifest against the installed alpha.12 CLI', () => {
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
      .map((line) => /^ {2}- ((?!auth\/)[^ ]+)/u.exec(line)?.[1])
      .filter((scenario) => scenario !== undefined);
    assert.deepEqual(canonical, OFFICIAL_CORE_SCENARIOS_BY_PROTOCOL[protocolVersion]);
  }
});

test('writes exact-head core evidence for all thirteen applicable executions', async () => {
  const invocations = buildOfficialClientInvocations({
    conformanceEntryPath: '/repo/conformance/dist/index.js',
    nodePath: '/runtime/node',
    profile: 'core',
  });
  const report = await runOfficialClientInvocations(invocations, {
    now: () => 10,
    profile: 'core',
    provisionClientRuntime: async () => undefined,
    runInvocation: async () => undefined,
  });
  const evidence = buildOfficialAuthEvidence({
    completedAt: '2026-09-01T20:01:00.000Z',
    git: { clean: true, head: 'b'.repeat(40) },
    ledgers: {
      '2025-11-25': { client: [] },
      '2026-07-28': { client: [] },
    },
    profile: 'core',
    report,
    startedAt: '2026-09-01T20:00:00.000Z',
  });

  assert.deepEqual(evidence.summary, {
    cleanup: 'confirmed',
    executions: 13,
    failed: 0,
    passed: 13,
  });
  assert.equal(evidence.profile, 'core');
  assert.equal(evidence.schemaVersion, '1.1.0');
  assert.equal(evidence.ticket, 'BST-1583');
  assert.match(
    OFFICIAL_CORE_EVIDENCE_PATH,
    /packages\/mcp-test-lab\/artifacts\/official-core-evidence\.json$/u
  );
});
