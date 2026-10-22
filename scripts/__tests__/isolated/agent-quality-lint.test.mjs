import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const biome = path.join(root, 'node_modules/@biomejs/biome/bin/biome');
const assertion =
  "import { expect } from 'vitest'; export function check() { expect(Promise.reject(new Error('failure'))).rejects.toThrow('failure'); }";
const joinedAssertion =
  "import { expect } from 'vitest'; export async function check() { await expect(Promise.reject(new Error('failure'))).rejects.toThrow('failure'); }";

// Real new files exercise the repository's inclusion/override rules and scanner.
// A separate synthetic config or --only would enable rules behind our backs.
const layouts = [
  ['packages/canonical-ingestion/__tests__/nested', '.browser.test.ts'],
  ['packages/canonical-ingestion/__tests__', '.spec.ts'],
  ['packages/canonical-ingestion/__tests__', '.mts'],
  ['packages/canonical-ingestion/__tests__', '.mjs'],
  ['packages/web-writer/src/__tests__/nested', '.browser.test.ts'],
  ['packages/web-writer/src/__tests__', '.spec.ts'],
  ['packages/web-writer/src/__tests__', '.mts'],
  ['packages/web-writer/src/__tests__', '.mjs'],
  ['packages/web-state-store/src/__tests__/nested', '-worker.ts'],
  ['packages/host-lease/__tests__/nested', '.integration.test.ts'],
  ['packages/host-lease/__tests__', '.spec.ts'],
  ['packages/host-lease/__tests__', '.mts'],
  ['packages/host-lease/__tests__', '.mjs'],
  ['packages/assistant-service/src/__tests__/node-workspace-services', '.spec.ts'],
  ['packages/host-capabilities/src/mcp/__tests__/nested', '.test.ts'],
  ['packages/host-capabilities/src/mcp/__tests__', '.spec.ts'],
  ['packages/host-capabilities/src/mcp/__tests__', '.mts'],
  ['packages/host-capabilities/src/mcp/__tests__', '.mjs'],
  ['packages/host-capabilities/__tests__/credentials/nested', '.test.ts'],
  ['packages/host-capabilities/__tests__/provider-auth/nested', '.test.ts'],
  ['packages/host-capabilities/__tests__/provider-auth', '.spec.ts'],
  ['packages/host-capabilities/__tests__/provider-auth', '.mts'],
  ['packages/host-capabilities/__tests__/provider-auth', '.mjs'],
  ['packages/indexer/__tests__/nested', '.test.ts'],
  ['packages/indexer/__tests__', '.spec.ts'],
  ['packages/indexer/__tests__', '.mts'],
  ['packages/indexer/__tests__', '.mjs'],
  ['packages/host-capabilities/src/native-tools/__tests__', '.test.ts'],
  ['packages/host-capabilities/src/native-tools/__tests__/nested', '.spec.ts'],
  ['packages/host-capabilities/src/native-tools/__tests__', '.mts'],
  ['packages/host-capabilities/src/native-tools/__tests__', '.mjs'],
  ['apps/desktop/src/__tests__/assistant-server/agent-quality-lint-layout', '.test.ts'],
  ['packages/effect-kit/src/__tests__', '.test.ts'],
  ['packages/effect-kit/src/__tests__', '.spec.ts'],
  ['packages/agent-host/__tests__', '.test.ts'],
  ['packages/agent-host/__tests__', '.spec.ts'],
  ['packages/assistant-contract/src/__tests__', '.test.ts'],
  ['packages/effect-kit/src/__tests__', '.mts'],
  ['scripts/__tests__', '.mjs'],
  ['packages/agent/src/__tests__', '.spec.ts'],
  ['packages/agent/src/__tests__', '.test.ts'],
  ['packages/agent/src/__tests__', '.mts'],
  ['packages/agent/src/__tests__', '.mjs'],
  ['packages/test-utils/src/__tests__', '.test.ts'],
  ['packages/test-utils/__tests__', '.spec.mts'],
  ['packages/queue/test', '.spec.ts'],
  ['packages/pipeline/__tests__', '.test.ts'],
  ['packages/worker-runtime/src/__tests__', '.test.ts'],
  ['packages/file-tree-worker/src', '.test.ts'],
  ['packages/token-cache/src/__tests__', '.test.tsx'],
  ['packages/chunking-worker/src/__tests__', '.test.ts'],
  ['packages/embedding-worker/test', '.spec.ts'],
  ['packages/embedding-worker/test', '.browser.test.ts'],
  ['packages/embedding-worker/bench', '.spec.ts'],
];

const lifecycleLayouts = [
  ...[
    'embedding-host-manager',
    'hosted-embedding-requests',
    'native-index-catalog-observation',
  ].map((family) => ['apps/desktop/src', family]),
  ...[
    'embedding-host-manager',
    'embedding-host-query-settlement',
    'embedding-host-unresponsive',
    'hosted-embedding-requests',
    'hosted-embeddings',
    'native-index-catalog-observation',
    'native-index-scan-admission',
    'native-index-retry',
    'platform/native-refusal-boundary',
  ].map((family) => ['apps/desktop/src/__tests__', family]),
];

function lint(t, side) {
  // Every layout path carries the token and all of them go on one command line,
  // which Windows caps at 32,767 characters: keep the token short.
  const token = randomBytes(4).toString('hex');
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
  for (const [directory, family] of lifecycleLayouts) {
    const prefix = `${directory}/${family}-agent-quality-lint-${token}`;
    for (const suffix of ['.test.ts', '/nested/future.spec.ts', '/future.mts', '/future.mjs']) {
      for (const entry of [
        {
          bad: assertion,
          good: joinedAssertion,
          name: 'floating',
          rule: 'nursery/noFloatingPromises',
        },
        {
          bad: 'export function check() { return [1, 2].filter(async (value) => value > 0); }',
          good: 'export function check() { return [1, 2].filter((value) => value > 0); }',
          name: 'predicate',
          rule: 'nursery/noMisusedPromises',
        },
        {
          bad: "export function check() { const state = Math.random() > 0.5 ? 'ready' : 'waiting'; switch (state) { case 'ready': return true; } }",
          good: "export function check() { const state = Math.random() > 0.5 ? 'ready' : 'waiting'; switch (state) { case 'ready': return true; case 'waiting': return false; } }",
          name: 'switch',
          rule: 'nursery/useExhaustiveSwitchCases',
        },
      ]) {
        const fixture = `${prefix}-${entry.name}`;
        t.after(() => rmSync(path.join(root, fixture), { force: true, recursive: true }));
        cases.push({ ...entry, path: `${fixture}${suffix}` });
      }
    }
  }
  cases.push({
    bad: assertion,
    good: joinedAssertion,
    path: `packages/host-capabilities/src/shared-flight-agent-quality-lint-${token}.ts`,
    rule: 'nursery/noFloatingPromises',
  });
  cases.push(
    {
      bad: 'export function check() { return [1, 2].filter(async (value) => value > 0); }',
      good: 'export function check() { return [1, 2].filter((value) => value > 0); }',
      path: `packages/host-capabilities/src/shared-flight-predicate-agent-quality-lint-${token}.ts`,
      rule: 'nursery/noMisusedPromises',
    },
    {
      bad: "export function check(state: 'ready' | 'waiting') { switch (state) { case 'ready': return true; } }",
      good: "export function check(state: 'ready' | 'waiting') { switch (state) { case 'ready': return true; case 'waiting': return false; } }",
      path: `packages/host-capabilities/src/shared-flight-switch-agent-quality-lint-${token}.ts`,
      rule: 'nursery/useExhaustiveSwitchCases',
    }
  );
  const nested = `packages/agent/src/__tests__/agent-quality-lint-${token}`;
  t.after(() => rmSync(path.join(root, nested), { force: true, recursive: true }));
  cases.push({
    bad: assertion,
    good: joinedAssertion,
    path: `${nested}/future.spec.ts`,
    rule: 'nursery/noFloatingPromises',
  });
  for (const directory of [
    'packages/canonical-ingestion/src',
    'packages/canonical-ingestion/__tests__',
    'packages/web-writer/src',
    'packages/host-lease/src',
    'packages/host-lease/__tests__',
    'packages/assistant-service/src/__tests__/node-workspace-services',
    'packages/host-capabilities/src/mcp',
    'packages/host-capabilities/src/provider-auth',
    'packages/host-capabilities/__tests__/provider-auth',
    'packages/indexer/src',
    'packages/indexer/__tests__',
    'packages/host-capabilities/src/native-tools',
    'apps/desktop/src/__tests__/assistant-server/agent-quality-lint-layout',
    'packages/agent-host/src',
    'packages/agent/src/__tests__',
    'packages/test-utils/src',
    'packages/queue/test',
    'packages/pipeline/__tests__',
    'packages/worker-runtime/src',
    'packages/file-tree-worker/src',
    'packages/token-cache/src',
    'packages/chunking-worker/src',
    'packages/embedding-worker/src',
    'packages/embedding-worker/test',
  ]) {
    cases.push(
      {
        bad: 'export function check() { return [1, 2].filter(async (value) => value > 0); }',
        good: 'export function check() { return [1, 2].filter((value) => value > 0); }',
        path: `${directory}/agent-quality-lint-predicate-${token}.ts`,
        rule: 'nursery/noMisusedPromises',
      },
      {
        bad: "export function check(state: 'ready' | 'waiting') { switch (state) { case 'ready': return true; } }",
        good: "export function check(state: 'ready' | 'waiting') { switch (state) { case 'ready': return true; case 'waiting': return false; } }",
        path: `${directory}/agent-quality-lint-switch-${token}.ts`,
        rule: 'nursery/useExhaustiveSwitchCases',
      }
    );
  }
  for (const directory of [
    'packages/token-cache/src',
    'packages/embedding-worker/test',
    'packages/host-capabilities/src/native-tools',
  ]) {
    cases.push({
      bad: 'export function check(pending: Promise<void> | null) { if (pending) { return pending; } return null; }',
      good: 'export function check(pending: Promise<void> | null) { if (pending !== null) { return pending; } return null; }',
      path: `${directory}/agent-quality-lint-presence-${token}.ts`,
      rule: 'nursery/noMisusedPromises',
    });
  }
  for (const directory of [
    'packages/effect-kit/src',
    'packages/assistant-contract/src/native-tools/schemas',
    'packages/agent/src/tools',
    'packages/agent-host/src',
  ]) {
    cases.push(
      {
        bad: "export const check = () => Promise.reject('lost stack');",
        good: "export const check = () => Promise.reject(new Error('failure'));",
        path: `${directory}/agent-quality-lint-rejection-${token}.ts`,
        rule: 'nursery/usePromiseRejectErrors',
      },
      {
        bad: 'export const check = () => new Promise((_resolve, reject) => reject(42));',
        good: 'export const check = (reason: unknown) => Promise.reject(reason); export const aborted = (signal: AbortSignal) => new Promise((_resolve, reject) => reject(signal.reason));',
        path: `${directory}/agent-quality-lint-rejection-constructor-${token}.ts`,
        rule: 'nursery/usePromiseRejectErrors',
      }
    );
  }
  cases.push(
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
    const file = path.join(root, entry.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${entry[side]}\n`);
  }
  const relativeFiles = cases.map((entry) => entry.path);
  const result = spawnSync(process.execPath, [biome, 'lint', ...relativeFiles, '--reporter=json'], {
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
