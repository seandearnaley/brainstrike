import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { freezeCurrentOriginMain } from '../agent-routines/shared/current-main.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = 'a'.repeat(40);
const entrypoints = [
  'scripts/agent-routines/model-catalog/update-model-catalog.mjs',
  'scripts/agent-routines/contract-drift/cli.mjs',
  'scripts/agent-routines/ci-flake/cli.mjs',
  'scripts/deterministic-boundary-crash-fuzzer.mjs',
  'scripts/mutation-gap-hardener.mjs',
];

test('freezes a freshly fetched current origin/main with a per-fetch timeout', async () => {
  const calls = [];
  const baseSha = await freezeCurrentOriginMain({
    cwd: '/repo',
    fetchTimeoutMs: 12_345,
    runGit: async (request) => {
      calls.push(request);
      return { stdout: `${SHA}\n` };
    },
  });
  assert.equal(baseSha, SHA);
  assert.deepEqual(calls, [
    {
      args: [
        'fetch',
        '--no-tags',
        '--depth=1',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main',
      ],
      cwd: '/repo',
      timeoutMs: 12_345,
    },
    { args: ['rev-parse', '--verify', 'origin/main^{commit}'], cwd: '/repo', timeoutMs: 12_345 },
    { args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: '/repo', timeoutMs: 12_345 },
  ]);
});

test('rejects an arbitrary or stale checkout after fetching main', async () => {
  let call = 0;
  await assert.rejects(
    freezeCurrentOriginMain({
      cwd: '/repo',
      runGit: async () => ({ stdout: `${call++ === 1 ? SHA : 'b'.repeat(40)}\n` }),
    }),
    /checkout is not the fetched current origin\/main/u
  );
});

for (const entrypoint of entrypoints) {
  test(`${entrypoint} freezes main and writes one terminal RoutineResult`, () => {
    const source = readFileSync(path.join(root, entrypoint), 'utf8');
    assert.match(source, /freezeCurrentOriginMain/u);
    assert.match(source, /createRoutineResultWriter/u);
    assert.equal(source.match(/\.write\(terminalResult\)/gu)?.length, 1);
    assert.match(source, /\.assertWritten\(\)/u);
  });
}

test('the report-only setup action has no cache writer', () => {
  const source = readFileSync(
    path.join(root, '.github/actions/setup-report-workspace/action.yml'),
    'utf8'
  );
  assert.doesNotMatch(source, /actions\/cache|cache:\s*['"]?pnpm|turbo-cache/iu);
  assert.match(source, /pnpm install --frozen-lockfile/u);
});
