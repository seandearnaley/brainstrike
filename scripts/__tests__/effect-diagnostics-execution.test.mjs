import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const consumer = path.join(root, 'packages/effect-kit');
const checker = path.join(consumer, 'node_modules/@effect/tsgo/dist/effect-tsgo.cjs');

// These programs exercise the installed checker through the real consumer's
// inherited test configuration. No replacement plugin configuration can make
// an excluded test or a disabled production rule pass this contract.
const cases = [
  ['floatingEffect', 'floating.ts', 'Effect.succeed(1);', 'export const work = Effect.succeed(1);'],
  [
    'floatingEffectInVitest',
    'callback.test.ts',
    "import { it } from 'vitest'; it('lazy', () => Effect.void);",
    "import { it } from 'vitest'; it('joined', () => Effect.runPromise(Effect.void));",
  ],
  [
    'missingStarInYieldEffectGen',
    'yield.ts',
    'export const work = Effect.gen(function* () { const n = yield Effect.succeed(1); return n; });',
    'export const work = Effect.gen(function* () { const n = yield* Effect.succeed(1); return n; });',
  ],
  [
    'returnEffectInGen',
    'return.ts',
    'export const work = Effect.gen(function* () { return Effect.succeed(1); });',
    'export const work = Effect.gen(function* () { return yield* Effect.succeed(1); });',
  ],
  [
    'promiseInEffectSuccess',
    'promise.ts',
    'export const work = Effect.succeed(1).pipe(Effect.map(async (n) => n));',
    'export const work = Effect.succeed(1).pipe(Effect.flatMap((n) => Effect.promise(async () => n)));',
  ],
  [
    'unsafeEffectTypeAssertion',
    'assertion.ts',
    "declare const work: Effect.Effect<string, 'failure'>; export const narrowed = work as Effect.Effect<string>;",
    "declare const work: Effect.Effect<string, 'failure'>; export const retained = work;",
  ],
  [
    'missingEffectContext',
    'context.ts',
    "import { Context } from 'effect'; class Db extends Context.Service<Db>()('Db', {}) {} export const work: Effect.Effect<void> = Db.pipe(Effect.asVoid);",
    "import { Context } from 'effect'; class Db extends Context.Service<Db>()('Db', {}) {} export const work: Effect.Effect<void, never, Db> = Db.pipe(Effect.asVoid);",
  ],
  [
    'missingEffectError',
    'error.ts',
    "declare const work: Effect.Effect<number, 'failure'>; export const get: () => Effect.Effect<number> = () => work;",
    "declare const work: Effect.Effect<number, 'failure'>; export const get: () => Effect.Effect<number, 'failure'> = () => work;",
  ],
  [
    'unstableApiUsage',
    'unstable.ts',
    '/** @stability unstable */\nexport const api = () => 1; export const used = api();',
    '/** @stability stable */\nexport const api = () => 1; export const used = api();',
  ],
  [
    'experimentalApiUsage',
    'experimental.ts',
    '/** @stability experimental */\nexport const api = () => 1; export const used = api();',
    '/** @stability stable */\nexport const api = () => 1; export const used = api();',
  ],
  [
    'apiStabilityLeak',
    'leak.ts',
    '/** @stability unstable */\nexport interface Internal { readonly value: string }\nexport interface Public { readonly value: Internal }',
    'export interface Public { readonly value: string }',
  ],
];

function checkFixture(t, side) {
  const directory = mkdtempSync(path.join(tmpdir(), 'brainstrike-effect-diagnostics-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  symlinkSync(
    path.join(consumer, 'node_modules'),
    path.join(directory, 'node_modules'),
    'junction'
  );
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'brainstrike-diagnostic-fixture', type: 'module', version: '1.0.0' })
  );
  writeFileSync(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        composite: false,
        declaration: false,
        declarationMap: false,
        incremental: false,
        noEmit: true,
        rootDir: directory,
      },
      extends: path.join(consumer, 'tsconfig.test.json'),
      include: ['*.ts'],
    })
  );
  for (const [, file, bad, good] of cases) {
    writeFileSync(
      path.join(directory, file),
      `import { Effect } from 'effect';\n${side === 'bad' ? bad : good}\n`
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      checker,
      'diagnostics',
      '--project',
      path.join(directory, 'tsconfig.json'),
      '--strict',
      '--format',
      'json',
    ],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(
    output.summary.filesChecked,
    cases.length,
    'every fixture, including the Vitest callback, is checked'
  );
  assert.equal(output.summary.filesWithoutPlugin, 0);
  return { ...result, ...output, directory };
}

test('the configured Effect checker rejects each correctness failure, including test callbacks', (t) => {
  const result = checkFixture(t, 'bad');
  assert.equal(result.status, 1, result.stderr);
  for (const [name, file] of cases) {
    const diagnostic = result.diagnostics.find(
      (entry) => entry.name === name && path.basename(entry.file) === file
    );
    assert.ok(diagnostic, `${name} must report in ${file}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(diagnostic.severity, 'error');
    assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.length > 0);
  }
  const leak = result.diagnostics.find((entry) => entry.name === 'apiStabilityLeak');
  assert.ok(
    leak.relatedInformation?.some(
      (entry) => path.basename(entry.file) === 'leak.ts' && entry.line > 0
    ),
    'stability leaks retain the related declaration location for the coding agent'
  );
});

test('the same inherited program accepts the corrected positive controls', (t) => {
  const result = checkFixture(t, 'good');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.warnings, 0);
});

test('the diagnostics package stays on the qualified release', () => {
  assert.equal(
    JSON.parse(readFileSync(path.join(consumer, 'node_modules/@effect/tsgo/package.json'), 'utf8'))
      .version,
    '0.53.3'
  );
});
