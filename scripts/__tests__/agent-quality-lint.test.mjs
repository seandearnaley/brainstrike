import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const biome = path.join(repo, 'node_modules/@biomejs/biome/bin/biome');
const assertion =
  "import { expect } from 'vitest'; export function check() { expect(Promise.reject(new Error('failure'))).rejects.toThrow('failure'); }";
const joinedAssertion =
  "import { expect } from 'vitest'; export async function check() { await expect(Promise.reject(new Error('failure'))).rejects.toThrow('failure'); }";

// Real new files exercise the repository's inclusion/override rules and scanner.
// A separate synthetic config or --only would enable rules behind our backs.
// They are written to a copy of the workspace layout under the OS temp
// directory, never into the checkout: sibling suites read the real tree, and a
// file created and deleted there fails those reads with ENOENT (BST-2076). The
// copy carries the repository's own biome.json and each enclosing package
// manifest, and links that package's installed dependencies, so includes,
// overrides and module resolution see the same relative paths as the checkout.
const layouts = [
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
];

function packageDirectory(relativePath) {
  for (let directory = path.dirname(relativePath); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(repo, directory, 'package.json'))) {
      return directory;
    }
    if (directory === '.') {
      throw new Error(`no package encloses ${relativePath}`);
    }
  }
}

// pnpm links a package's dependencies relatively into the root store
// (`../../node_modules/.pnpm/...`). Recreating each link, instead of linking
// the node_modules directory itself, keeps the resolved paths inside the copy;
// Biome reads no dependency types from outside its project root, so
// `expect(...).rejects` would otherwise never be seen as a Promise.
function linkDependencies(from, to) {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else if (entry.name.startsWith('@')) {
      linkDependencies(source, target);
    } else {
      symlinkSync(source, target);
    }
  }
}

function workspaceCopy(t, relativePaths) {
  // The real path: below macOS's symlinked /var, Biome finds no package manifest.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agent-quality-lint-')));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  copyFileSync(path.join(repo, 'biome.json'), path.join(root, 'biome.json'));
  for (const directory of new Set(['.', ...relativePaths.map(packageDirectory)])) {
    mkdirSync(path.join(root, directory), { recursive: true });
    copyFileSync(
      path.join(repo, directory, 'package.json'),
      path.join(root, directory, 'package.json')
    );
    linkDependencies(
      path.join(repo, directory, 'node_modules'),
      path.join(root, directory, 'node_modules')
    );
  }
  return root;
}

function lint(t, side) {
  const token = randomUUID();
  const declaration = `packages/effect-kit/src/agent-quality-lint-declaration-${token}.ts`;
  const cases = layouts.map(([directory, suffix]) => ({
    bad: assertion,
    good: joinedAssertion,
    path: `${directory}/agent-quality-lint-${token}${suffix}`,
    rule: 'nursery/noFloatingPromises',
  }));
  const nested = `packages/agent/src/__tests__/agent-quality-lint-${token}`;
  cases.push({
    bad: assertion,
    good: joinedAssertion,
    path: `${nested}/future.spec.ts`,
    rule: 'nursery/noFloatingPromises',
  });
  for (const directory of ['packages/agent-host/src', 'packages/agent/src/__tests__']) {
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
  const root = workspaceCopy(t, [declaration, ...cases.map((entry) => entry.path)]);
  const files = cases.map((entry) => path.join(root, entry.path));
  for (const entry of cases) {
    const file = path.join(root, entry.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${entry[side]}\n`);
  }
  writeFileSync(
    path.join(root, declaration),
    `/** @${side === 'bad' ? 'private' : 'public'} */\nexport const internalValue = 1;\n`
  );
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
