#!/usr/bin/env node
// Deletes dist artifacts whose corresponding src file no longer exists.
//
// Why this exists (2026-07-30 cache-poisoning incident): tsc's incremental
// builder never deletes outputs of deleted sources, and several packages build
// into dist without cleaning first. Branch switches therefore leave orphaned
// compiled files in dist — and the nested turbo run by apps/web + apps/desktop
// prebuild/predev snapshots the whole dist/** into the machine-global cache
// (~/Library/Caches/BrainStrike/turbo), immortalizing the orphans: cold runs
// restore them verbatim even after deletion, tripping `turbo boundaries`.
//
// This script runs BEFORE tsc in those packages' build scripts. Unlike a full
// clean it preserves incremental builds, and it is safe under CONCURRENT
// builds of the same package (the reason packages/agent's tsup pins
// `clean: false`): a concurrent build only emits files that DO have a source
// counterpart, so the set pruned here is disjoint from anything it writes.
//
// Assumed layout (uniform across every wired package, enforced by the paired
// contract test): per-file emit from `src/` into `dist/`, no bundler code
// splitting — every artifact maps 1:1 back to a source path. A package that
// breaks that assumption must clean instead of prune. NO SILENT FALLBACKS:
// a missing src/ directory is a misconfigured invocation and throws.
//
// Paired test: scripts/__tests__/prune-stale-dist.test.mjs (behavior,
// entrypoint controls, and the repo-wide wiring contract).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Longest-first so `foo.d.ts.map` strips as a declaration map, not a `.map`
// suffix miss. `.json` is included because tsc copies imported src JSON into
// dist verbatim (e.g. packages/db src/drizzle/migrations.json).
const ARTIFACT_SUFFIXES = [
  '.d.ts.map',
  '.d.mts.map',
  '.d.cts.map',
  '.js.map',
  '.mjs.map',
  '.cjs.map',
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
];

// Any of these source flavors legitimizes a compiled artifact base. `.js` and
// `.jsx` cover checked-in JS sources (e.g. file-explorer's .worker.js entry).
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];

/** Split a dist-relative artifact path into { base, suffix }, or null if the file is not a build artifact. */
function splitArtifact(relPath) {
  for (const suffix of ARTIFACT_SUFFIXES) {
    if (relPath.endsWith(suffix) && relPath.length > suffix.length) {
      return { base: relPath.slice(0, -suffix.length), suffix };
    }
  }
  return null;
}

/** True when some source file that would emit this artifact base still exists. */
function hasSource(srcDir, artifact) {
  if (artifact.suffix === '.json') {
    // JSON is copied verbatim; only an identical src JSON path backs it.
    return fs.existsSync(path.join(srcDir, `${artifact.base}.json`));
  }
  return SOURCE_EXTENSIONS.some((ext) => fs.existsSync(path.join(srcDir, artifact.base + ext)));
}

function walkFiles(root) {
  const files = [];
  const dirs = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs.push(abs);
        stack.push(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  }
  return { dirs, files };
}

export function main({ packageDir = process.cwd(), log = console.log } = {}) {
  const srcDir = path.join(packageDir, 'src');
  const distDir = path.join(packageDir, 'dist');

  if (!fs.existsSync(srcDir)) {
    throw new Error(
      `prune-stale-dist: no src directory at ${srcDir}. This script assumes per-file emit from src/ into ` +
        'dist/; wiring it into a package with a different layout is a misconfiguration, not a no-op.'
    );
  }

  if (!fs.existsSync(distDir)) {
    // First build: nothing has been emitted yet. A well-defined state, not a fallback.
    log('prune-stale-dist: no dist directory yet, nothing to prune.');
    return { deleted: [], removedDirs: [] };
  }

  const { dirs, files } = walkFiles(distDir);

  const deleted = [];
  for (const abs of files) {
    const artifact = splitArtifact(path.relative(distDir, abs));
    if (artifact === null || hasSource(srcDir, artifact)) {
      continue;
    }
    // force:true keeps concurrent prunes of the same package idempotent — the
    // orphan being already gone is success, not an error.
    fs.rmSync(abs, { force: true });
    deleted.push(abs);
    log(`prune-stale-dist: deleted orphaned artifact ${path.relative(packageDir, abs)}`);
  }

  // Remove directories the prune emptied (deepest first) so empty husks are not
  // snapshotted either. rmdir only succeeds on empty dirs, which makes this
  // safe under concurrent builds: a dir a sibling build is writing into is
  // non-empty and is deliberately left alone. The dist root itself is kept.
  const removedDirs = [];
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(dir);
      removedDirs.push(dir);
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT' && error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  if (deleted.length === 0) {
    log('prune-stale-dist: no stale artifacts found.');
  } else {
    log(`prune-stale-dist: deleted ${deleted.length} orphaned artifact(s).`);
  }
  return { deleted, removedDirs };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const extraArgs = process.argv.slice(2);
  if (extraArgs.length > 0) {
    // NO SILENT FALLBACKS: this script takes no arguments (it always operates
    // on cwd's src/ + dist/). Ignoring unknown args would let a typo'd wiring
    // "succeed" while doing something other than what the caller intended.
    console.error(`prune-stale-dist: unexpected argument(s): ${extraArgs.join(' ')}`);
    process.exit(1);
  }
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
