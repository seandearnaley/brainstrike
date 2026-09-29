// Guards the stale-dist cache-poisoning class (2026-07-30 incident):
//
// tsc's incremental builder never deletes outputs whose sources are gone, and
// several packages build into dist WITHOUT cleaning first (packages/db is bare
// `tsc --build`; packages/agent's tsup pins `clean: false` because concurrent
// app prebuilds would unlink each other's outputs mid-run). Branch switches
// therefore leave orphaned compiled files in dist — and the nested turbo run by
// apps/web + apps/desktop prebuild/predev snapshots the WHOLE dist/** into the
// machine-global cache (~/Library/Caches/BrainStrike/turbo), immortalizing the
// orphans: cold runs restore them verbatim even after deletion, tripping
// `turbo boundaries` (16 issues, 125 poisoned archives purged).
//
// The durable guard is scripts/prune-stale-dist.mjs: before a tsc-based build,
// delete every dist artifact absent from TypeScript's exact emit plan. Unlike a
// full clean this preserves incremental builds AND is safe under concurrent
// builds of the same package — a concurrent build only writes files in that
// emit plan or the package's declared bundler entrypoints, so the prune set is
// disjoint from it.
//
// Two layers under test here:
//   1. the prune script's behavior (fixture-driven, including entrypoint
//      control tests per the BST-836 guard-script false-green rule), and
//   2. the WIRING CONTRACT: every build-chain script (build/prebuild/
//      postbuild/build:*) that runs an EMITTING tsc (any form — `-b`,
//      `--build`, `--project`, bare `tsc`; anything without `--noEmit`) must
//      clean dist or prune stale artifacts first. Scope note: non-build-chain
//      scripts (e.g. type-check) are deliberately not scanned — only the
//      `build` task's dist/** outputs are snapshotted by the nested turbo,
//      and an emitting tsc cannot CREATE orphans (it only emits current
//      program outputs); the prune before every snapshot-producing build is
//      what launders dist before archiving.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const PRUNE_SCRIPT = path.join(SCRIPTS_DIR, 'prune-stale-dist.mjs');

const { main } = await import(PRUNE_SCRIPT);

/**
 * Create a temp package dir populated from { 'src/a.ts': '...', 'dist/a.js': '...' } maps.
 * A minimal src->dist tsconfig is written unless the files map provides its own —
 * the pruner resolves the real tsc program (include/exclude respected), so every
 * fixture needs one, exactly like every wired package has one.
 */
function makeFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prune-stale-dist-'));
  const withConfig = {
    'package.json': '{}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        declaration: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        outDir: 'dist',
        resolveJsonModule: true,
        rootDir: 'src',
        skipLibCheck: true,
        sourceMap: true,
        target: 'es2022',
      },
      include: ['src/**/*', 'src/**/*.json'],
    }),
    ...files,
  };
  for (const [rel, content] of Object.entries(withConfig)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function listFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else {
        out.push(path.relative(root, abs));
      }
    }
  }
  return out.sort();
}

test('prunes every dist artifact flavor whose source file is gone', () => {
  const dir = makeFixture({
    'dist/gone.d.ts': '',
    'dist/gone.d.ts.map': '',
    'dist/gone.js': '',
    'dist/gone.js.map': '',
    'dist/gone2.cjs': '',
    'dist/gone2.cjs.map': '',
    'dist/gone2.mjs': '',
    'dist/gone2.mjs.map': '',
    'dist/gone3.d.mts': '',
    'dist/gone4.json': '{}',
    'dist/keep.d.ts': '',
    'dist/keep.js': '',
    'dist/sub/gone5.d.ts': '',
    'dist/sub/gone5.js': '',
    // A json source in the program activates json-orphan pruning (see the
    // "compiles no json" test for the inverse).
    'src/data.json': '{}',
    'src/keep.ts': 'export {};',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['keep.d.ts', 'keep.js']);
  assert.equal(result.deleted.length, 12);
  // The now-empty subdirectory is removed so it cannot be snapshotted either.
  assert.equal(existsSync(path.join(dir, 'dist', 'sub')), false);
});

test('keeps exact TypeScript outputs backed by each source flavor (.ts/.tsx/.mts/.js/.json)', () => {
  const dir = makeFixture({
    'dist/component.d.ts': '',
    'dist/component.js': '',
    'dist/data.json': '{}',
    'dist/module.d.mts': '',
    'dist/module.mjs': '',
    'dist/plain.d.ts': '',
    'dist/plain.js': '',
    'dist/worker.worker.js': '',
    'dist/worker.worker.mjs': '',
    'src/component.tsx': '',
    'src/data.json': '{}',
    'src/module.mts': '',
    'src/plain.ts': '',
    'src/worker.worker.js': '',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(result.deleted, []);
  assert.equal(listFiles(path.join(dir, 'dist')).length, 9);
});

test('MONEY TEST: prunes obsolete module formats even when the source basename is live', () => {
  // BST-1014 moved ordinary libraries from tsup dual emit to tsc ESM emit.
  // Basename-only liveness kept the old CJS/MJS siblings forever because
  // src/index.ts still existed, allowing stale imports to poison Turbo caches.
  const dir = makeFixture({
    'dist/index.cjs': 'require("@brainstrike/removed-fork")',
    'dist/index.cjs.map': '',
    'dist/index.d.cts': '',
    'dist/index.d.mts': '',
    'dist/index.d.ts': '',
    'dist/index.js': '',
    'dist/index.js.map': '',
    'dist/index.mjs': '',
    'dist/index.mjs.map': '',
    'src/index.ts': 'export {};',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['index.d.ts', 'index.js', 'index.js.map']);
  assert.equal(result.deleted.length, 6);
});

test('keeps package-declared bundler formats outside the TypeScript emit plan', () => {
  // agent/file-explorer intentionally run tsc plus a non-splitting tsup bundle
  // in the same dist. Their package exports are the native source of truth for
  // the additional format that a concurrent bundle build may be writing.
  const dir = makeFixture({
    'dist/index.d.ts': '',
    'dist/index.js': '',
    'dist/index.js.map': '',
    'dist/index.mjs': '',
    'package.json': JSON.stringify({
      exports: {
        '.': {
          import: './dist/index.mjs',
          require: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
      scripts: { build: 'node ../../scripts/prune-stale-dist.mjs && tsc -b . && tsup' },
    }),
    'src/index.ts': 'export {};',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(result.deleted, []);
});

test('MONEY TEST: declared-but-sourceless artifacts are pruned, even in a bundler package', () => {
  // package.json is a routing contract, not proof that a source still exists.
  // Letting it define liveness would keep a deleted export's stale JS/types in
  // dist forever and allow Turbo to cache the orphan.
  const dir = makeFixture({
    'dist/collator.d.ts': '',
    'dist/collator.js': '',
    'dist/collator.mjs': '',
    'dist/index.d.ts': '',
    'dist/index.js': '',
    'dist/index.mjs': '',
    'package.json': JSON.stringify({
      exports: {
        '.': {
          import: './dist/index.mjs',
          require: './dist/index.js',
          types: './dist/index.d.ts',
        },
        './collator': {
          import: './dist/collator.mjs',
          require: './dist/collator.js',
          types: './dist/collator.d.ts',
        },
      },
      scripts: { build: 'node ../../scripts/prune-stale-dist.mjs && tsc -b . && tsup' },
    }),
    'src/index.ts': 'export {};',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['index.d.ts', 'index.js', 'index.mjs']);
  assert.equal(result.deleted.length, 3);
});

test('prunes artifacts whose source exists on disk but is excluded from the tsc program', () => {
  // The review-found residual class: 9 of the 10 wired packages exclude
  // `**/*.test.*` from tsconfig. A dist test artifact left from before the
  // exclude landed looks "live" to a filesystem existence check because
  // src/foo.test.ts is still on disk — but tsc will never emit it again, and
  // compiled tests are exactly the vitest-importing shape that trips
  // `turbo boundaries`. Pruning must follow the PROGRAM, not the filesystem.
  const dir = makeFixture({
    'dist/foo.test.d.ts': '',
    'dist/foo.test.js': '',
    'dist/keep.d.ts': '',
    'dist/keep.js': '',
    'src/foo.test.ts': '',
    'src/keep.ts': '',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { outDir: 'dist', rootDir: 'src', skipLibCheck: true },
      exclude: ['**/*.test.ts'],
      include: ['src/**/*'],
    }),
  });

  main({ log: () => {}, packageDir: dir });

  // This fixture's explicit tsconfig does not enable declaration emit, so an
  // old keep.d.ts is stale even though keep.ts remains in the program.
  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['keep.js']);
});

test('keeps outputs of on-disk .js sources outside the program (bundler entries)', () => {
  // packages/file-explorer bundles src/worker-storage.worker.js via tsup, but
  // its tsconfig include only covers .ts/.tsx — the worker is NOT a program
  // member. Its dist outputs must survive, or every build would delete and
  // re-emit them, eroding the concurrent-build disjointness guarantee.
  const dir = makeFixture({
    'dist/worker.worker.js': '',
    'dist/worker.worker.mjs': '',
    'src/index.ts': '',
    'src/worker.worker.js': '',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { outDir: 'dist', rootDir: 'src', skipLibCheck: true },
      include: ['src/**/*.ts'],
    }),
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(result.deleted, []);
});

test('leaves dist json alone when the program compiles no json', () => {
  // A dist json without a src twin is NOT necessarily an orphan: a
  // {"type":"commonjs"} marker or generated manifest is produced, not
  // compiled, and would only come back if its producing step reran. Json
  // pruning therefore activates only when the package's tsc program
  // demonstrably owns json emission (contains at least one json source).
  const dir = makeFixture({
    'dist/marker.json': '{"type":"commonjs"}',
    'src/index.ts': '',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(result.deleted, []);
  assert.equal(existsSync(path.join(dir, 'dist', 'marker.json')), true);
});

test('throws when tsconfig.json is missing (misconfigured wiring, no silent fallback)', () => {
  const dir = makeFixture({ 'dist/gone.js': '', 'src/index.ts': '' });
  rmSync(path.join(dir, 'tsconfig.json'));

  assert.throws(() => main({ log: () => {}, packageDir: dir }), /tsconfig/);
  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['gone.js']);
});

test('never touches non-artifact files, even without a source counterpart', () => {
  const dir = makeFixture({
    'dist/.tsbuildinfo': '{}',
    'dist/notes.txt': '',
    'dist/styles.css': '',
    'src/index.ts': '',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(result.deleted, []);
  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['.tsbuildinfo', 'notes.txt', 'styles.css']);
});

test('removes only directories the prune itself emptied', () => {
  // The dir sweep must be scoped to ancestors of deleted files: a directory a
  // concurrent sibling build has just created (mkdir and first write are
  // separate syscalls) is momentarily empty, and an unscoped rmdir walk over
  // all of dist would delete it out from under the sibling's write.
  const dir = makeFixture({
    'dist/sub/gone.js': '',
    'src/index.ts': '',
  });
  mkdirSync(path.join(dir, 'dist', 'fresh-sibling-dir'));

  main({ log: () => {}, packageDir: dir });

  assert.equal(existsSync(path.join(dir, 'dist', 'sub')), false);
  assert.equal(existsSync(path.join(dir, 'dist', 'fresh-sibling-dir')), true);
});

test('keeps the dist root even when every artifact is pruned', () => {
  const dir = makeFixture({
    'dist/gone.js': '',
    'src/index.ts': '',
  });

  main({ log: () => {}, packageDir: dir });

  assert.equal(existsSync(path.join(dir, 'dist')), true);
  assert.deepEqual(listFiles(path.join(dir, 'dist')), []);
});

test('throws when the src directory is missing (misconfigured wiring, no silent fallback)', () => {
  const dir = makeFixture({ 'dist/gone.js': '' });

  assert.throws(() => main({ log: () => {}, packageDir: dir }), /src/);
  // A misconfigured invocation must not delete anything.
  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['gone.js']);
});

test('no-op when dist does not exist yet (first build)', () => {
  const dir = makeFixture({ 'src/index.ts': '' });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(result.deleted, []);
});

// --- Entrypoint control tests (BST-836: a guard that cannot go red is not a guard) ---

test('direct execution prunes and exits 0 with observable output', () => {
  const dir = makeFixture({
    'dist/gone.js': '',
    'src/index.ts': '',
  });

  const result = spawnSync(process.execPath, [PRUNE_SCRIPT], { cwd: dir, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(`${result.stdout}${result.stderr}`, /gone\.js/);
  assert.equal(existsSync(path.join(dir, 'dist', 'gone.js')), false);
});

test('direct execution exits non-zero when src is missing (the gate can go red)', () => {
  const dir = makeFixture({ 'dist/gone.js': '' });

  const result = spawnSync(process.execPath, [PRUNE_SCRIPT], { cwd: dir, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src/);
});

test('direct execution rejects unexpected arguments instead of ignoring them', () => {
  const dir = makeFixture({ 'dist/gone.js': '', 'src/index.ts': '' });

  const result = spawnSync(process.execPath, [PRUNE_SCRIPT, '--dist=elsewhere'], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  // Ignored args must not silently prune anyway.
  assert.equal(existsSync(path.join(dir, 'dist', 'gone.js')), true);
});

// --- Wiring contract: no package may run a tsc build into dist without clean or prune ---

/**
 * Workspace package dirs, enumerated from pnpm-workspace.yaml exactly like
 * package-scripts-canonical-form-contract.test.mjs does (same throw-on-unknown
 * glob discipline: an unparseable glob must fail loudly, not under-enumerate).
 */
function workspacePackageDirs() {
  const yaml = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const item = rawLine.match(/^\s+-\s+['"]?([^'"]+?)['"]?\s*$/);
    if (item) {
      globs.push(item[1]);
      continue;
    }
    if (/^\S/.test(rawLine)) {
      break;
    }
  }

  const dirs = [];
  for (const glob of globs) {
    const match = glob.match(/^(.+)\/\*$/);
    if (!match) {
      throw new Error(
        `pnpm-workspace.yaml contains the package glob "${glob}", which this contract does not know how to ` +
          'enumerate. Update workspacePackageDirs() in scripts/__tests__/prune-stale-dist.test.mjs before this ' +
          'glob can hide a package from the stale-dist wiring contract.'
      );
    }
    const groupDir = path.join(REPO_ROOT, match[1]);
    let entries;
    try {
      entries = readdirSync(groupDir);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(groupDir, entry);
      try {
        if (statSync(dir).isDirectory() && statSync(path.join(dir, 'package.json')).isFile()) {
          dirs.push(dir);
        }
      } catch {
        // not a package dir
      }
    }
  }
  return dirs;
}

/**
 * Script names participating in a package's BUILD CHAIN. The scan is scoped to
 * these rather than all scripts because cache poisoning happens exclusively
 * through the `build` task — its `outputs: ["dist/**"]` is what the nested
 * turbo snapshots (`type-check` and `test` have `outputs: []` in turbo.jsonc).
 * An emitting tsc elsewhere (e.g. apps/web's `type-check` running
 * `tsc --build` over referenced packages) can refresh dist but cannot
 * create orphans (tsc only emits current program outputs) and cannot be
 * snapshotted; the prune preceding every snapshot-producing build launders
 * dist before archiving.
 */
const BUILD_CHAIN_SCRIPT = /^(?:build|prebuild|postbuild|build:.+)$/;

/**
 * An EMITTING tsc invocation, judged per &&/;/| command segment: any `tsc`
 * without `--noEmit` and without `--watch`. This deliberately catches plain
 * `tsc`, `tsc -b`/`--build`, AND `tsc --project ... --emitDeclarationOnly` —
 * the review found `build:types` scripts using the `--project` form that a
 * `-b`-only regex was blind to.
 */
function isEmittingTsc(segment) {
  return /\btsc\b/.test(segment) && !(segment.includes('--noEmit') || segment.includes('--watch'));
}

/**
 * A build-chain script is protected when, in a segment BEFORE its first
 * emitting tsc invocation, it either:
 *   - cleans dist (inline `node <depth>/scripts/rimraf.mjs dist` or
 *     `pnpm run clean` — the sibling canonical-form contract pins clean to the
 *     rimraf form, so the alias is trustworthy), or
 *   - prunes stale artifacts via `node <depth>/scripts/prune-stale-dist.mjs`
 *     at the CORRECT ../-depth for the package's nesting (a wrong depth would
 *     fail at build time, but only on the machines that build that package).
 * Anything else leaves stale dist files for the nested-turbo cache snapshot.
 */
function classifyBuildScript(script, relDir) {
  const segments = script.split(/&&|;|\|/);
  const tscIndex = segments.findIndex((segment) => isEmittingTsc(segment));
  if (tscIndex === -1) {
    return { protected: true, reason: 'no emitting tsc invocation' };
  }
  const before = segments.slice(0, tscIndex).join(' && ');
  // Escape `.` as well as `/`: an unescaped `.` matches any character, so
  // `node ab/cd/scripts/prune-stale-dist.mjs` would satisfy a `../../` check.
  const depthPattern = '../'
    .repeat(relDir.split(path.sep).length)
    .replaceAll('.', '\\.')
    .replaceAll('/', '\\/');
  if (new RegExp(`node ${depthPattern}scripts\\/prune-stale-dist\\.mjs`).test(before)) {
    return { protected: true, reason: 'prunes stale dist artifacts before tsc' };
  }
  // `(?!\S)` keeps `pnpm run clean:generated` (ui — cleans stray compiled JS in
  // SRC, not dist) from masquerading as a dist clean: `:` is a \b boundary.
  if (/scripts\/rimraf\.mjs dist(?!\S)/.test(before) || /\bpnpm run clean(?!\S)/.test(before)) {
    return { protected: true, reason: 'cleans dist before tsc' };
  }
  return { protected: false };
}

test('control: the classifier flags an unguarded tsc build (this contract can go red)', () => {
  assert.equal(classifyBuildScript('tsc --build', path.join('packages', 'db')).protected, false);
  assert.equal(
    classifyBuildScript('tsc -b . && tsup', path.join('packages', 'agent')).protected,
    false
  );
  // A prune invocation at the WRONG nesting depth is not protection.
  assert.equal(
    classifyBuildScript(
      'node ../../scripts/prune-stale-dist.mjs && tsc -b .',
      path.join('packages', 'config', 'tsconfig')
    ).protected,
    false
  );
  // Clean/prune must run BEFORE tsc, not after.
  assert.equal(
    classifyBuildScript(
      'tsc -b . && node ../../scripts/prune-stale-dist.mjs',
      path.join('packages', 'db')
    ).protected,
    false
  );
  // `pnpm run clean:generated` (ui) cleans stray compiled JS in SRC, not dist —
  // ui's dist/prompt-management was a proven poisoning vector behind exactly
  // this script prefix. It must not satisfy the contract.
  assert.equal(
    classifyBuildScript('pnpm run clean:generated && tsc -b .', path.join('packages', 'ui'))
      .protected,
    false
  );
  // A same-length path with different characters must not satisfy the depth
  // check — unescaped `.` in the generated pattern would match any character.
  assert.equal(
    classifyBuildScript(
      'node ab/cd/scripts/prune-stale-dist.mjs && tsc -b .',
      path.join('packages', 'db')
    ).protected,
    false
  );
  // The `--project ... --emitDeclarationOnly` form emits into dist too (the
  // build:types shape the review found); a `-b`-only regex is blind to it.
  assert.equal(
    classifyBuildScript(
      'tsc --project tsconfig.json --declaration --emitDeclarationOnly',
      path.join('packages', 'storage')
    ).protected,
    false
  );
  // `tsc --noEmit` cannot poison dist and must not be flagged.
  assert.equal(classifyBuildScript('tsc --noEmit', path.join('packages', 'db')).protected, true);
  // The splitting pin can go red too.
  assert.equal(tsupPinsNoSplitting('export default { splitting: true }'), false);
  assert.equal(tsupPinsNoSplitting('export default { entry: ["src/index.ts"] }'), false);
  assert.equal(tsupPinsNoSplitting('export default { splitting: false }'), true);
});

/**
 * The pruner's concurrent-build safety argument ("the prune set is disjoint
 * from a sibling build's writes") silently depends on tsup NOT code-splitting:
 * hashed split chunks have no source counterpart and would be deleted out from
 * under a sibling build. Every tsup config sharing a dist with the pruner must
 * pin `splitting: false` explicitly (tsup defaults esm output to splitting on).
 */
function tsupPinsNoSplitting(configText) {
  return /splitting:\s*false/.test(configText);
}

// BST-1014 removed tsup from ordinary libraries. Only agent and file-explorer
// now combine prune-stale-dist with a real bundle boundary; this floor pins the
// complete live intersection so discovery cannot silently collapse to one/zero.
const MIN_PRUNED_TSUP_CONFIGS = 2;

test('every pruned package with a tsup config pins splitting: false', () => {
  const violations = [];
  let checkedConfigs = 0;
  for (const dir of workspacePackageDirs()) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const relDir = path.relative(REPO_ROOT, dir);
    const build = manifest.scripts?.build;
    if (build === undefined || !classifyBuildScript(build, relDir).reason?.startsWith('prunes')) {
      continue;
    }
    const tsupConfigPath = path.join(dir, 'tsup.config.ts');
    if (!existsSync(tsupConfigPath)) {
      continue;
    }
    checkedConfigs += 1;
    if (!tsupPinsNoSplitting(readFileSync(tsupConfigPath, 'utf8'))) {
      violations.push(
        `${relDir} (${manifest.name}) prunes stale dist artifacts but its tsup.config.ts does not pin ` +
          '`splitting: false`. Hashed split chunks have no source counterpart, so the pruner would delete ' +
          "them out from under a concurrent sibling build — breaking the disjointness guarantee the wiring's " +
          'prune-not-clean choice rests on. Pin splitting: false, or switch the package to a dist clean.'
      );
    }
  }
  assert.deepEqual(violations, [], `Unpinned tsup splitting:\n${violations.join('\n')}`);
  assert.ok(
    checkedConfigs >= MIN_PRUNED_TSUP_CONFIGS,
    `Only ${checkedConfigs} pruned tsup config(s) checked (expected >= ${MIN_PRUNED_TSUP_CONFIGS}) — discovery broke.`
  );
});

test('every build-chain script with an emitting tsc cleans or prunes dist first', () => {
  const violations = [];
  let emittingScripts = 0;
  let prunedScripts = 0;

  for (const dir of workspacePackageDirs()) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const relDir = path.relative(REPO_ROOT, dir);
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      if (!BUILD_CHAIN_SCRIPT.test(name)) {
        continue;
      }
      const verdict = classifyBuildScript(script, relDir);
      if (verdict.reason === 'no emitting tsc invocation') {
        continue;
      }
      emittingScripts += 1;
      if (!verdict.protected) {
        violations.push(
          `${relDir} (${manifest.name}) has ${name} = ${JSON.stringify(script)}, which runs an emitting tsc ` +
            'into dist without cleaning or pruning first. Stale artifacts from deleted sources will be ' +
            'snapshotted into the machine-global turbo cache and resurrected on cold runs (2026-07-30 ' +
            'poisoning incident). Prepend `node <depth>/scripts/prune-stale-dist.mjs && ` (preserves ' +
            'incremental builds) or a dist clean. (Scope note: only build-chain scripts are scanned — the ' +
            "`build` task's dist/** outputs are the only thing the nested turbo snapshots; an emitting tsc " +
            'in type-check cannot create orphans or archives.)'
        );
      } else if (verdict.reason.startsWith('prunes')) {
        prunedScripts += 1;
      }
    }
  }

  assert.deepEqual(violations, [], `Unguarded emitting tsc invocations:\n${violations.join('\n')}`);

  // Anti-vacuous-green floors: if enumeration or the emit detection silently
  // breaks, the loop above passes while checking nothing.
  assert.ok(
    emittingScripts >= 15,
    `Only ${emittingScripts} emitting build-chain script(s) discovered (expected >= 15) — enumeration or ` +
      'isEmittingTsc() broke.'
  );
  assert.ok(
    prunedScripts >= 8,
    `Only ${prunedScripts} script(s) wire prune-stale-dist (expected >= 8) — the guard was unwired somewhere.`
  );
});

// --- Cache-hash coverage: editing the pruner must invalidate cached builds ---

test('turbo.jsonc hashes prune-stale-dist.mjs into build tasks via global.inputs', () => {
  // The pruner is invoked by package build scripts, but repo-root scripts live
  // outside every package's $TURBO_DEFAULT$ inputs. Without a global.inputs
  // entry, editing the pruner would replay stale cached builds — the invisible-
  // input class (#1066/#1207); same precedent as verify-no-cross-chunk-cycles.mjs.
  const turboConfig = readFileSync(path.join(REPO_ROOT, 'turbo.jsonc'), 'utf8');
  assert.match(turboConfig, /"scripts\/prune-stale-dist\.mjs"/);
});
