#!/usr/bin/env node
// Deletes dist artifacts that the package's tsc program no longer emits.
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
// `clean: false`): a concurrent build only emits files whose sources are in
// the current program, so the set pruned here is disjoint from anything it
// writes.
//
// The orphan test is PROGRAM membership, not filesystem existence: the
// package's tsconfig is resolved with the real TypeScript config loader
// (extends/include/exclude respected), and an artifact is stale when no
// program source would emit it. A bare "does src/<base>.ts exist" check
// wrongly retains artifacts of sources that exist but are EXCLUDED — e.g. a
// dist/foo.test.js left from before a `**/*.test.*` exclude landed, which is
// exactly the vitest-importing shape that trips `turbo boundaries`.
//
// Two deliberate carve-outs:
//   - Outputs of on-disk `.js`/`.jsx` sources are kept even outside the
//     program: they are bundler entries (file-explorer's .worker.js), and
//     pruning them would erode the concurrent-build disjointness above.
//   - `.json` pruning activates only when the program itself contains json
//     sources (tsc copies included json verbatim — packages/db's
//     drizzle/migrations.json). In packages whose tsc does not own json, a
//     dist json (a generated {"type":"commonjs"} marker, a copied manifest)
//     is produced rather than compiled, and deleting it would not self-heal.
//
// Assumed layout (enforced, not assumed silently): tsconfig.json at the
// package root with rootDir src and outDir dist, per-file emit, no bundler
// code splitting. NO SILENT FALLBACKS: a missing src/, missing tsconfig.json,
// or divergent rootDir/outDir throws — a package that breaks the layout must
// clean instead of prune.
//
// Paired test: scripts/__tests__/prune-stale-dist.test.mjs (behavior,
// entrypoint controls, and the repo-wide wiring contract).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Longest-first so `foo.d.ts.map` strips as a declaration map, not a `.map`
// suffix miss.
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

const PROGRAM_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];

/** Split a dist-relative artifact path into { base, suffix }, or null if the file is not a build artifact. */
function splitArtifact(relPath) {
  for (const suffix of ARTIFACT_SUFFIXES) {
    if (relPath.endsWith(suffix) && relPath.length > suffix.length) {
      return { base: relPath.slice(0, -suffix.length), suffix };
    }
  }
  return null;
}

/**
 * Resolve the package's tsc program and reduce it to the emit-relevant view:
 * src-relative artifact bases plus the set of src-relative json paths tsc
 * copies verbatim.
 */
function resolveProgram(packageDir, srcDir, distDir) {
  const tsconfigPath = path.join(packageDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    throw new Error(
      `prune-stale-dist: no tsconfig.json at ${tsconfigPath}. The orphan test is tsc-program membership; ` +
        'without the config there is no program to consult. A package without a root tsconfig must clean ' +
        'instead of prune.'
    );
  }

  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        `prune-stale-dist: failed to parse ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          '\n'
        )}`
      );
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, host);
  if (!parsed) {
    throw new Error(`prune-stale-dist: failed to parse ${tsconfigPath}.`);
  }

  const resolvedOutDir = parsed.options.outDir ? path.resolve(parsed.options.outDir) : null;
  const resolvedRootDir = parsed.options.rootDir ? path.resolve(parsed.options.rootDir) : null;
  if (resolvedOutDir !== distDir || resolvedRootDir !== srcDir) {
    throw new Error(
      `prune-stale-dist: ${tsconfigPath} must declare rootDir src and outDir dist (found rootDir=` +
        `${resolvedRootDir ?? '<unset>'}, outDir=${resolvedOutDir ?? '<unset>'}). This script only ` +
        'understands the uniform src->dist per-file layout; a divergent package must clean instead.'
    );
  }

  const bases = new Set();
  const jsonSources = new Set();
  for (const fileName of parsed.fileNames) {
    const abs = path.resolve(fileName);
    if (!abs.startsWith(srcDir + path.sep)) {
      continue;
    }
    const rel = path.relative(srcDir, abs);
    if (rel.endsWith('.json')) {
      jsonSources.add(rel);
      continue;
    }
    const ext = PROGRAM_SOURCE_EXTENSIONS.find((candidate) => rel.endsWith(candidate));
    if (ext) {
      bases.add(rel.slice(0, -ext.length));
    }
  }
  return { bases, jsonSources };
}

/** True when the current build would still emit this artifact. */
function isLiveArtifact(artifact, program, srcDir) {
  if (artifact.suffix === '.json') {
    // Json pruning only in packages whose program owns json (see header).
    if (program.jsonSources.size === 0) {
      return true;
    }
    return program.jsonSources.has(`${artifact.base}.json`);
  }
  if (program.bases.has(artifact.base)) {
    return true;
  }
  // Bundler entries: checked-in .js/.jsx sources outside the program (see header).
  return (
    fs.existsSync(path.join(srcDir, `${artifact.base}.js`)) ||
    fs.existsSync(path.join(srcDir, `${artifact.base}.jsx`))
  );
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

  const program = resolveProgram(packageDir, srcDir, distDir);
  const { dirs, files } = walkFiles(distDir);

  const deleted = [];
  for (const abs of files) {
    const artifact = splitArtifact(path.relative(distDir, abs));
    if (artifact === null || isLiveArtifact(artifact, program, srcDir)) {
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
