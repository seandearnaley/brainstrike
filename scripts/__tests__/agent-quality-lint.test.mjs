import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const biome = path.join(root, 'node_modules/@biomejs/biome/bin/biome');
const assertion =
  "import { expect } from 'vitest'; export function check() { expect(Promise.reject(new Error('failure'))).rejects.toThrow('failure'); }";
const joinedAssertion =
  "import { expect } from 'vitest'; export async function check() { await expect(Promise.reject(new Error('failure'))).rejects.toThrow('failure'); }";

// Real new files exercise the repository's inclusion/override rules and scanner.
// A separate synthetic config or --only would enable rules behind our backs.
const layouts = [
  ['packages/effect-kit/src/__tests__', '.test.ts'],
  ['packages/effect-kit/src/__tests__', '.spec.ts'],
  ['packages/agent-host/__tests__', '.test.ts'],
  ['packages/agent-host/__tests__', '.spec.ts'],
  ['packages/assistant-contract/src/__tests__', '.test.ts'],
  ['packages/effect-kit/src/__tests__', '.mts'],
  ['scripts/__tests__', '.mjs'],
];

function lint(t, side) {
  const token = randomUUID();
  const declaration = path.join(
    root,
    `packages/effect-kit/src/agent-quality-lint-declaration-${token}.ts`
  );
  t.after(() => rmSync(declaration, { force: true }));
  writeFileSync(
    declaration,
    `/** @${side === 'bad' ? 'private' : 'public'} */\nexport const internalValue = 1;\n`
  );
  const cases = layouts.map(([directory, suffix]) => ({
    bad: assertion,
    good: joinedAssertion,
    path: `${directory}/agent-quality-lint-${token}${suffix}`,
    rule: 'nursery/noFloatingPromises',
  }));
  cases.push(
    {
      bad: 'export function check() { return [1, 2].filter(async (value) => value > 0); }',
      good: 'export function check() { return [1, 2].filter((value) => value > 0); }',
      path: `packages/agent-host/src/agent-quality-lint-predicate-${token}.ts`,
      rule: 'nursery/noMisusedPromises',
    },
    {
      bad: "export function check(state: 'ready' | 'waiting') { switch (state) { case 'ready': return true; } }",
      good: "export function check(state: 'ready' | 'waiting') { switch (state) { case 'ready': return true; case 'waiting': return false; } }",
      path: `packages/agent-host/src/agent-quality-lint-switch-${token}.ts`,
      rule: 'nursery/useExhaustiveSwitchCases',
    },
    {
      bad: "export function check(run: () => void) { try { run(); } catch { throw new Error('failed'); } }",
      good: "export function check(run: () => void) { try { run(); } catch (cause) { throw new Error('failed', { cause }); } }",
      path: `packages/effect-kit/src/agent-quality-lint-cause-${token}.ts`,
      rule: 'style/useErrorCause',
    },
    {
      bad: 'export function check(value: number | undefined) { if (value) { return 1; } return 0; }',
      good: 'export function check(value: number | undefined) { if (value !== undefined && value > 0) { return 1; } return 0; }',
      path: `packages/effect-kit/src/agent-quality-lint-boolean-${token}.ts`,
      rule: 'nursery/useStrictBooleanExpressions',
    },
    {
      bad: `import { internalValue } from './agent-quality-lint-declaration-${token}.js'; export const value = internalValue;`,
      good: `import { internalValue } from './agent-quality-lint-declaration-${token}.js'; export const value = internalValue;`,
      path: `packages/effect-kit/src/agent-quality-lint-private-${token}.ts`,
      rule: 'correctness/noPrivateImports',
    },
    {
      bad: "import { missing } from './does-not-exist.js'; export const work = missing;",
      good: "import { Effect } from 'effect'; export const work = Effect.succeed(1);",
      path: `packages/effect-kit/src/agent-quality-lint-import-${token}.ts`,
      rule: 'correctness/noUnresolvedImports',
    }
  );
  const files = cases.map((entry) => path.join(root, entry.path));
  t.after(() => {
    for (const file of files) {
      rmSync(file, { force: true });
    }
  });
  for (const entry of cases) {
    writeFileSync(path.join(root, entry.path), `${entry[side]}\n`);
  }
  const result = spawnSync(process.execPath, [biome, 'lint', ...files, '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.unchanged, cases.length, 'every intended new-file layout was linted');
  assert.equal(output.summary.skipped, 0);
  return { ...result, ...output, cases };
}

test('agent quality rules reject unawaited assertions and incorrect control flow in actual file layouts', (t) => {
  const result = lint(t, 'bad');
  assert.equal(result.status, 1, result.stderr);
  for (const entry of result.cases) {
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.category === `lint/${entry.rule}` &&
          diagnostic.location.path.replaceAll('\\', '/').endsWith(entry.path) &&
          diagnostic.severity === 'error'
      ),
      `${entry.rule} must reject ${entry.path}: ${JSON.stringify(result.diagnostics)}`
    );
  }
});

test('joined assertions, exhaustive cases, retained causes and valid imports pass the same lane', (t) => {
  const result = lint(t, 'good');
  assert.equal(result.status, 0, JSON.stringify(result.diagnostics));
  assert.equal(result.summary.errors, 0);
});
