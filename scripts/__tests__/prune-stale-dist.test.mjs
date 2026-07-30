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
// delete every dist artifact whose corresponding src file no longer exists.
// Unlike a full clean this preserves incremental builds AND is safe under
// concurrent builds of the same package — a concurrent build only emits files
// that DO have a source counterpart, so the prune set is disjoint from it.
//
// Two layers under test here:
//   1. the prune script's behavior (fixture-driven, including entrypoint
//      control tests per the BST-836 guard-script false-green rule), and
//   2. the WIRING CONTRACT: every workspace package whose build script invokes
//      `tsc -b` / `tsc --build` must clean dist or prune stale artifacts
//      BEFORE tsc runs, so no package can silently rejoin the vulnerable class.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

/** Create a temp package dir populated from { 'src/a.ts': '...', 'dist/a.js': '...' } maps. */
function makeFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prune-stale-dist-'));
  for (const [rel, content] of Object.entries(files)) {
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
    'src/keep.ts': 'export {};',
  });

  const result = main({ log: () => {}, packageDir: dir });

  assert.deepEqual(listFiles(path.join(dir, 'dist')), ['keep.d.ts', 'keep.js']);
  assert.equal(result.deleted.length, 12);
  // The now-empty subdirectory is removed so it cannot be snapshotted either.
  assert.equal(existsSync(path.join(dir, 'dist', 'sub')), false);
});

test('keeps artifacts backed by any source flavor (.ts/.tsx/.mts/.js/.json)', () => {
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

const TSC_BUILD_RE = /\btsc (?:-b\b|--build\b)/;

/**
 * A tsc-building package is protected when, BEFORE the first tsc invocation,
 * its build script either:
 *   - cleans dist (inline `node <depth>/scripts/rimraf.mjs dist` or
 *     `pnpm run clean` — the sibling canonical-form contract pins clean to the
 *     rimraf form, so the alias is trustworthy), or
 *   - prunes stale artifacts via `node <depth>/scripts/prune-stale-dist.mjs`
 *     at the CORRECT ../-depth for the package's nesting (a wrong depth would
 *     fail at build time, but only on the machines that build that package).
 * Anything else leaves stale dist files for the nested-turbo cache snapshot.
 */
function classifyBuildScript(build, relDir) {
  const tscMatch = build.search(TSC_BUILD_RE);
  if (tscMatch === -1) {
    return { protected: true, reason: 'no tsc build' };
  }
  const beforeTsc = build.slice(0, tscMatch);
  const depth = '../'.repeat(relDir.split(path.sep).length);
  if (
    new RegExp(`node ${depth.replaceAll('/', '\\/')}scripts\\/prune-stale-dist\\.mjs`).test(
      beforeTsc
    )
  ) {
    return { protected: true, reason: 'prunes stale dist artifacts before tsc' };
  }
  // `(?!\S)` keeps `pnpm run clean:generated` (ui — cleans stray compiled JS in
  // SRC, not dist) from masquerading as a dist clean: `:` is a \b boundary.
  if (
    /scripts\/rimraf\.mjs dist(?!\S)/.test(beforeTsc) ||
    /\bpnpm run clean(?!\S)/.test(beforeTsc)
  ) {
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
});

test('every tsc-building package cleans or prunes dist before tsc runs', () => {
  const violations = [];
  let tscBuilders = 0;
  let prunedBuilders = 0;

  for (const dir of workspacePackageDirs()) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const build = manifest.scripts?.build;
    if (build === undefined || !TSC_BUILD_RE.test(build)) {
      continue;
    }
    tscBuilders += 1;
    const relDir = path.relative(REPO_ROOT, dir);
    const verdict = classifyBuildScript(build, relDir);
    if (!verdict.protected) {
      violations.push(
        `${relDir} (${manifest.name}) has build = ${JSON.stringify(build)}, which runs tsc into dist without ` +
          'cleaning or pruning first. Stale artifacts from deleted sources will be snapshotted into the ' +
          'machine-global turbo cache and resurrected on cold runs (2026-07-30 poisoning incident). Prepend ' +
          '`node <depth>/scripts/prune-stale-dist.mjs && ` (preserves incremental builds) or a dist clean.'
      );
    } else if (verdict.reason.startsWith('prunes')) {
      prunedBuilders += 1;
    }
  }

  assert.deepEqual(violations, [], `Unguarded tsc builds:\n${violations.join('\n')}`);

  // Anti-vacuous-green floors: if enumeration or the tsc regex silently breaks,
  // the loop above passes while checking nothing.
  assert.ok(
    tscBuilders >= 15,
    `Only ${tscBuilders} tsc-building package(s) discovered (expected >= 15) — enumeration or TSC_BUILD_RE broke.`
  );
  assert.ok(
    prunedBuilders >= 8,
    `Only ${prunedBuilders} package(s) wire prune-stale-dist (expected >= 8) — the guard was unwired somewhere.`
  );
});

// --- Cache-hash coverage: editing the pruner must invalidate cached builds ---

test('turbo.jsonc hashes prune-stale-dist.mjs into build tasks via globalDependencies', () => {
  // The pruner is invoked by package build scripts, but repo-root scripts live
  // outside every package's $TURBO_DEFAULT$ inputs. Without a globalDependencies
  // entry, editing the pruner would replay stale cached builds — the invisible-
  // input class (#1066/#1207); same precedent as verify-no-cross-chunk-cycles.mjs.
  const turboConfig = readFileSync(path.join(REPO_ROOT, 'turbo.jsonc'), 'utf8');
  assert.match(turboConfig, /"scripts\/prune-stale-dist\.mjs"/);
});
