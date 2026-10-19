import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DESKTOP_TYPED_PRODUCER_FILES } from '../effect-typed-producer-cohorts.mjs';
import { runTsc } from '../verify-test-tsconfig-program.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const consumer = path.join(root, 'packages/effect-kit');

function diagnostics(project, cwd = consumer) {
  const checker = path.join(cwd, 'node_modules/@effect/tsgo/dist/effect-tsgo.cjs');
  const result = spawnSync(
    process.execPath,
    [checker, 'diagnostics', '--project', project, '--strict', '--format', 'json'],
    { cwd, encoding: 'utf8', timeout: 30_000 }
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, ...JSON.parse(result.stdout) };
}

// These programs exercise the installed checker through the real consumer's
// inherited test configuration. No replacement plugin configuration can make
// an excluded test or a disabled production rule pass this contract.
const cases = [
  [
    'preferTypedSchemaDecoder',
    'producer.ts',
    "import { Schema } from 'effect'; export const value = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))({ name: 'Ada' });",
    "import { Schema } from 'effect'; export const value = Schema.decodeSync(Schema.Struct({ name: Schema.String }))({ name: 'Ada' });",
  ],
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
  const result = diagnostics(path.join(directory, 'tsconfig.json'));
  assert.equal(
    result.summary.filesChecked,
    cases.length,
    'every fixture, including the Vitest callback, is checked'
  );
  assert.equal(result.summary.filesWithoutPlugin, 0);
  return { ...result, directory };
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

test('the actual shared schema rejects wrong Encoded fields without erasing unknown receivers', (t) => {
  // Ignored by repository scans, on the same drive as the imported owning source.
  const cache = path.join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, 'brainstrike-schema-encoded-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const owner = path.join(root, 'packages/assistant-contract');
  symlinkSync(path.join(owner, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  const project = path.join(directory, 'tsconfig.json');
  writeFileSync(
    project,
    JSON.stringify({
      compilerOptions: {
        composite: false,
        declaration: false,
        declarationMap: false,
        incremental: false,
        noEmit: true,
        rootDir: root,
      },
      extends: path.join(owner, 'tsconfig.test.json'),
      files: ['probe.ts'],
      include: [],
      references: [],
    })
  );
  const imports = `import { Schema } from 'effect';\nimport { McpHostErrorSchema } from ${JSON.stringify(path.join(owner, 'src/mcp-host.js'))};\n`;
  const check = (source) => {
    writeFileSync(path.join(directory, 'probe.ts'), imports + source);
    const result = runTsc(['--noEmit', '--incremental', 'false', '--project', project]);
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  const invalid = check(
    "export const value = Schema.decodeSync(McpHostErrorSchema)({ category: 'configuration', code: 123, message: 'refused' });"
  );
  assert.equal(invalid.status, 1, 'the actual schema must retain its Encoded field types');
  assert.match(invalid.stdout, /TS2322/u);
  assert.match(invalid.stdout, /probe\.ts/u);
  const valid = check(
    "export const value = Schema.decodeSync(McpHostErrorSchema)({ category: 'configuration', code: 'refused', message: 'refused' });"
  );
  assert.equal(valid.status, 0, valid.stdout || valid.stderr);
  const unknown = check(
    "const wire: unknown = { category: 'configuration', code: 123, message: 'refused' }; export const value = Schema.decodeUnknownResult(McpHostErrorSchema)(wire);"
  );
  assert.equal(unknown.status, 0, unknown.stdout || unknown.stderr);
  const erased = check(
    "const erased: Schema.ConstraintDecoder<(typeof McpHostErrorSchema)['Type']> = McpHostErrorSchema; export const value = Schema.decodeSync(erased)({ category: 'configuration', code: 123, message: 'refused' });"
  );
  assert.equal(erased.status, 0, 'a decoder name alone cannot prove typed input after erasure');
});

function desktopFixture(t) {
  const cache = path.join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, 'brainstrike-desktop-producers-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  // Copy the actual config chain byte-for-byte. The exact relative override paths
  // now address disposable files without mutating the checkout or inventing rules.
  for (const file of [
    'apps/desktop/tsconfig.test.json',
    'apps/desktop/tsconfig.json',
    'packages/config/tsconfig/base.json',
  ]) {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, file), destination);
  }
  const desktop = path.join(directory, 'apps/desktop');
  symlinkSync(
    path.join(root, 'apps/desktop/node_modules'),
    path.join(desktop, 'node_modules'),
    'junction'
  );
  writeFileSync(path.join(desktop, 'package.json'), '{"type":"module"}');
  return {
    desktop,
    diagnostics() {
      return diagnostics(this.project, desktop);
    },
    project: path.join(desktop, 'tsconfig.test.json'),
    write(file, source) {
      const destination = path.join(desktop, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, source);
    },
  };
}

test('desktop inherited overrides reject authored unknown decoders only in the admitted files', (t) => {
  const fixture = desktopFixture(t);
  const outside = 'src/__tests__/outside-producer-cohort.test.ts';
  const prelude =
    "import { Schema } from 'effect'; const Person = Schema.Struct({ name: Schema.String });\n";
  const bad = `${prelude}export const value = Schema.decodeUnknownSync(Person)({ name: 'Ada' });`;
  for (const file of [...DESKTOP_TYPED_PRODUCER_FILES, outside]) {
    fixture.write(file, bad);
  }
  const rejected = fixture.diagnostics();
  assert.equal(
    rejected.status,
    1,
    'configured desktop producer paths must reject unknown decoders'
  );
  assert.equal(rejected.summary.filesChecked, DESKTOP_TYPED_PRODUCER_FILES.length + 1);
  assert.equal(rejected.summary.filesWithoutPlugin, 0);
  for (const file of DESKTOP_TYPED_PRODUCER_FILES) {
    const diagnostic = rejected.diagnostics.find(
      (entry) => entry.file === path.join(fixture.desktop, file)
    );
    assert.equal(diagnostic?.name, 'preferTypedSchemaDecoder', file);
    assert.equal(diagnostic.severity, 'error', file);
    assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.length > 0);
  }
  const unchanged = rejected.diagnostics.find(
    (entry) => entry.file === path.join(fixture.desktop, outside)
  );
  assert.equal(unchanged?.name, 'preferTypedSchemaDecoder');
  assert.equal(
    unchanged.severity,
    'message',
    'unadmitted desktop files retain their default suggestion'
  );
  for (const file of DESKTOP_TYPED_PRODUCER_FILES) {
    fixture.write(
      file,
      `${prelude}export const value = Schema.decodeSync(Person)({ name: 'Ada' }); const wire: unknown = { name: 123 }; export const received = Schema.decodeUnknownResult(Person)(wire);`
    );
  }
  const accepted = fixture.diagnostics();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.summary.errors, 0);
  assert.equal(accepted.summary.warnings, 0);
  assert.equal(accepted.diagnostics.length, 1, 'only the outside-cohort suggestion remains');
});

test('the actual desktop selection schema keeps useful Encoded input under the canonical compiler', (t) => {
  const fixture = desktopFixture(t);
  const file = DESKTOP_TYPED_PRODUCER_FILES[0];
  const imports = `import { Schema } from 'effect';\nimport { PlatformSelectionSchema } from ${JSON.stringify(path.join(root, 'apps/desktop/src/agent-host-platform/platform-wire.ts'))};\n`;
  const check = (source) => {
    fixture.write(file, imports + source);
    const result = runTsc(['--noEmit', '--incremental', 'false', '--project', fixture.project]);
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  const producer =
    "declare const selected: (typeof PlatformSelectionSchema)['Encoded']; export const value = Schema.decodeSync(PlatformSelectionSchema)({ ...selected, contextWindow: ";
  const invalid = check(`${producer}'wrong' });`);
  assert.equal(invalid.status, 1, 'wrong real desktop fields must fail the canonical compiler');
  assert.match(invalid.stdout, /TS2322/u);
  assert.match(invalid.stdout, /host-permission-policy\.test\.ts/u);
  const valid = check(`${producer}32000 });`);
  assert.equal(valid.status, 0, valid.stdout || valid.stderr);
  const unknown = check(
    "const wire: unknown = { contextWindow: 'wrong' }; export const value = Schema.decodeUnknownResult(PlatformSelectionSchema)(wire);"
  );
  assert.equal(unknown.status, 0, unknown.stdout || unknown.stderr);
});

test('the diagnostics package stays on the qualified release', () => {
  assert.equal(
    JSON.parse(readFileSync(path.join(consumer, 'node_modules/@effect/tsgo/package.json'), 'utf8'))
      .version,
    '0.53.3'
  );
});
