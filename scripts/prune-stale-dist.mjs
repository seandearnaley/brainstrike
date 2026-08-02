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
// The orphan test is TypeScript's exact emit plan, not filesystem existence:
// the package's tsconfig is resolved with the real config loader
// (extends/include/exclude respected), then `getOutputFileNames` supplies the
// artifacts each program source can emit. A bare "does src/<base>.ts exist"
// check wrongly retains both outputs of EXCLUDED sources and obsolete module
// formats after a build-strategy change (for example `index.cjs` left behind
// when a package moves from tsup dual emit to tsc ESM emit).
//
// Two deliberate carve-outs:
//   - Artifacts named by package.json exports/main/module/types, plus outputs
//     of on-disk `.js`/`.jsx` sources outside the program, are kept as bundler
//     outputs. Pruning them would erode the concurrent-build disjointness above.
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

/** Split a dist-relative artifact path into { base, suffix }, or null if the file is not a build artifact. */
function splitArtifact(relPath) {
  for (const suffix of ARTIFACT_SUFFIXES) {
    if (relPath.endsWith(suffix) && relPath.length > suffix.length) {
      return { base: relPath.slice(0, -suffix.length), suffix };
    }
  }
  return null;
}

/** Collect exact dist artifacts declared through Node/package-tool entrypoint fields. */
function resolveDeclaredArtifacts(packageDir, distDir) {
  const packageJsonPath = path.join(packageDir, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `prune-stale-dist: failed to parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const declaredArtifacts = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.includes('*')) {
        return;
      }
      const abs = path.resolve(packageDir, value);
      if (abs.startsWith(distDir + path.sep)) {
        declaredArtifacts.add(path.relative(distDir, abs));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  };

  visit(packageJson.exports);
  visit(packageJson.main);
  visit(packageJson.module);
  visit(packageJson.types);
  return declaredArtifacts;
}

/**
 * Resolve the package's tsc program and ask TypeScript for its exact output
 * filenames. This keeps the pruner aligned with module/declaration/source-map
 * options without duplicating the compiler's extension rules.
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

  const liveArtifacts = new Set();
  let hasJsonSources = false;
  for (const fileName of parsed.fileNames) {
    const abs = path.resolve(fileName);
    if (!abs.startsWith(srcDir + path.sep)) {
      continue;
    }
    if (abs.endsWith('.json')) {
      hasJsonSources = true;
    }
    for (const outputFile of ts.getOutputFileNames(
      parsed,
      abs,
      !ts.sys.useCaseSensitiveFileNames
    )) {
      const outputAbs = path.resolve(outputFile);
      if (outputAbs.startsWith(distDir + path.sep)) {
        liveArtifacts.add(path.relative(distDir, outputAbs));
      }
    }
  }
  for (const declaredArtifact of resolveDeclaredArtifacts(packageDir, distDir)) {
    liveArtifacts.add(declaredArtifact);
  }
  return { hasJsonSources, liveArtifacts };
}

/** True when the current build would still emit this artifact. */
function isLiveArtifact(relPath, artifact, program, srcDir) {
  if (program.liveArtifacts.has(relPath)) {
    return true;
  }
  if (artifact.suffix === '.json') {
    // Json pruning only in packages whose program owns json (see header).
    return !program.hasJsonSources;
  }
  // Bundler entries: checked-in .js/.jsx sources outside the program (see header).
  return (
    fs.existsSync(path.join(srcDir, `${artifact.base}.js`)) ||
    fs.existsSync(path.join(srcDir, `${artifact.base}.jsx`))
  );
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  }
  return files;
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
  const files = walkFiles(distDir);

  const deleted = [];
  for (const abs of files) {
    const relPath = path.relative(distDir, abs);
    const artifact = splitArtifact(relPath);
    if (artifact === null || isLiveArtifact(relPath, artifact, program, srcDir)) {
      continue;
    }
    // force:true keeps concurrent prunes of the same package idempotent — the
    // orphan being already gone is success, not an error.
    fs.rmSync(abs, { force: true });
    deleted.push(abs);
    log(`prune-stale-dist: deleted orphaned artifact ${path.relative(packageDir, abs)}`);
  }

  // Remove directories the prune emptied (deepest first) so empty husks are
  // not snapshotted either. The sweep is scoped to ANCESTORS OF DELETED FILES,
  // not all of dist: a directory a concurrent sibling build has just created
  // is momentarily empty (mkdir and first write are separate syscalls), and an
  // unscoped rmdir walk would delete it out from under the sibling's write.
  // Within that scope, rmdir-only-succeeds-on-empty keeps still-populated
  // ancestors alive. The dist root itself is kept.
  const pruneScopedDirs = new Set();
  for (const abs of deleted) {
    let dir = path.dirname(abs);
    while (dir !== distDir && dir.startsWith(distDir + path.sep)) {
      pruneScopedDirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const removedDirs = [];
  for (const dir of [...pruneScopedDirs].sort((a, b) => b.length - a.length)) {
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
