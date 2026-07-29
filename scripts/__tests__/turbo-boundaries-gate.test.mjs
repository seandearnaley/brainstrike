/**
 * Contract tests for the `turbo boundaries` CI gate (BST-967).
 *
 * The gate is a Static-job step running `pnpm exec turbo boundaries` BEFORE any
 * step that can materialize `dist/` (type-check's dependsOn: ["build"] builds
 * the workspace; a replayed turbo cache task writes outputs back). Ordering is
 * load-bearing: the analyzer scans build output too, so stale `dist/` from a
 * previous state of the tree produces phantom violations (observed live: the
 * unmerged turso branch's `dist/turso/*` files flagged `@tursodatabase/database`
 * imports that no source on main contains). On a fresh checkout with no dist,
 * the count is the SOURCE count — that is the number the gate enforces at zero.
 *
 * Per the BST-836 discipline, the gate itself is proven able to fail: a minimal
 * fixture workspace with an undeclared import must make `turbo boundaries` exit
 * non-zero, and the same fixture without the violation must exit zero. A gate
 * that cannot fail is not evidence.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const turboBin = path.join(repoRoot, 'node_modules', '.bin', 'turbo');

function writeFixture(dir, { violating }) {
  mkdirSync(path.join(dir, 'packages', 'alpha', 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'boundaries-fixture', packageManager: 'pnpm@11.15.0', private: true })
  );
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(
    path.join(dir, 'turbo.json'),
    JSON.stringify({ $schema: 'https://turborepo.dev/schema.json', tasks: { build: {} } })
  );
  writeFileSync(
    path.join(dir, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: 'alpha', private: true, version: '0.0.0' })
  );
  writeFileSync(
    path.join(dir, 'packages', 'alpha', 'src', 'index.ts'),
    violating
      ? "import { thing } from 'undeclared-dep';\nexport const x = thing;\n"
      : 'export const x = 1;\n'
  );
}

function runBoundaries(cwd) {
  // --skip-infer: the fixture must use THIS repo's turbo binary, not re-resolve
  // one from the fixture (which has no node_modules).
  return spawnSync(turboBin, ['boundaries', '--skip-infer'], { cwd, encoding: 'utf8' });
}

test('MONEY TEST: a fixture workspace with an undeclared import FAILS boundaries (exit != 0)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'boundaries-money-'));
  try {
    writeFixture(dir, { violating: true });
    const result = runBoundaries(dir);
    assert.notEqual(
      result.status,
      0,
      `boundaries must exit non-zero on a violation; got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /issue/i,
      'boundaries should report the issue it found'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('control: the same fixture without the violation passes boundaries (exit 0)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'boundaries-clean-'));
  try {
    writeFixture(dir, { violating: false });
    const result = runBoundaries(dir);
    assert.equal(
      result.status,
      0,
      `boundaries must exit 0 on a clean tree; got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('the Static job runs boundaries BEFORE any step that can materialize dist/', () => {
  const workflow = parseYaml(
    readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8')
  );
  const steps = workflow?.jobs?.static?.steps;
  assert.ok(Array.isArray(steps), 'test.yml must have a static job with steps');

  const runs = steps.map((step) => step.run ?? '');
  const boundariesIndex = runs.findIndex((run) => /turbo boundaries/.test(run));
  assert.notEqual(boundariesIndex, -1, 'Static must run `turbo boundaries` (BST-967)');

  // Any step invoking the turbo task graph (type-check depends on build) or a
  // package build can write dist/ and reintroduce the phantom-violation class.
  const distProducingIndex = runs.findIndex((run) => /type-check|turbo run|run build/.test(run));
  assert.ok(
    distProducingIndex === -1 || boundariesIndex < distProducingIndex,
    `boundaries (step ${boundariesIndex}) must run before dist-producing steps (first at ${distProducingIndex})`
  );
});

test('every @boundaries-ignore in the repo carries a reason', () => {
  const grep = spawnSync(
    'git',
    ['grep', '-n', '@boundaries-ignore', '--', '*.ts', '*.tsx', '*.mts', '*.mjs'],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  // git grep exits 1 on zero matches, which would make this test vacuous the
  // day the last ignore disappears — that is fine (nothing left to justify),
  // but a real error (exit > 1) must surface.
  assert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
  const lines = grep.stdout.split('\n').filter(Boolean);
  // This test file mentions the directive in prose; only source annotations count.
  const annotations = lines.filter((line) => !line.startsWith('scripts/__tests__/'));
  for (const line of annotations) {
    const reason = line.split('@boundaries-ignore')[1]?.trim() ?? '';
    assert.ok(
      reason.length >= 20,
      `@boundaries-ignore must carry a substantive reason (>=20 chars): ${line}`
    );
  }
  // Anti-vacuous floor: the five sanctioned crossings from #2101 exist today.
  // If this number legitimately drops, update it alongside the removal.
  assert.ok(
    annotations.length >= 5,
    `expected at least 5 annotated crossings, found ${annotations.length} — did a sweep remove reasons?`
  );
});

test('the sanctioned-crossing count matches what boundaries actually tolerates', () => {
  // The repo's own source tree must be clean under the gate's conditions. We
  // cannot delete dist/ here (developers' builds live there), so this asserts
  // the SOURCE-side count is zero by checking every reported violation path is
  // inside a dist/ directory. On a fresh CI checkout there is no dist and the
  // exit code alone decides.
  const result = spawnSync(turboBin, ['boundaries', '--skip-infer'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return; // fully clean tree (fresh checkout) — nothing to inspect
  }
  const text = `${result.stdout}\n${result.stderr}`.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI color codes from turbo output
    /\[[0-9;]*m/g,
    ''
  );
  const paths = [...text.matchAll(/,-\[([^\]]+?):\d+:\d+\]/g)].map((match) => match[1]);
  assert.ok(paths.length > 0, 'boundaries failed but no violation paths were parseable');
  const sourceViolations = paths.filter((violationPath) => !/\/dist\//.test(violationPath));
  assert.deepEqual(
    sourceViolations,
    [],
    `source-side boundary violations found (the gate would fail CI):\n${sourceViolations.join('\n')}`
  );
});
