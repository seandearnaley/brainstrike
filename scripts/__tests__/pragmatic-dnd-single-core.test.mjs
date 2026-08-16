import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// BST-1286: `@atlaskit/pragmatic-drag-and-drop`'s element adapter keeps its
// `draggableRegistry` and adapter ledger in MODULE SCOPE. Every guarantee the
// library makes therefore depends on exactly one physical copy being loaded:
// `draggable()` and `dropTargetForElements()` write into that module's registry,
// while `monitorForElements()` and the companions' `autoScrollForElements()`
// read from it. Split the copy and the writes land in one registry while the
// reads happen against another — drags stop working with no type error, no peer
// warning, and no thrown exception. Silent degradation, which AGENTS.md forbids.
//
// The realistic way to split it is the COMPANION packages, not our own imports.
// `-hitbox` and `-auto-scroll` carry their own majors that do NOT move in
// lockstep with core, and they straddled the core-2/core-3 boundary exactly:
//
//   hitbox      2.0.0 -> core ^2.0.0      2.0.1 -> core ^3.0.0
//   auto-scroll 3.0.0 -> core ^2.0.0      3.0.1 -> core ^3.0.0
//
// So a range like `^2.0.0` on hitbox stayed satisfiable by 2.0.0 after core went
// to 3.x, and pnpm would quietly nest a SECOND core 2.x underneath it. Worse,
// both companions declare core as a plain `dependency`, not a `peerDependency`,
// so that nesting produces no unmet-peer warning at all.
//
// WHY THIS LIVES HERE rather than in the app-shell Vitest suite. An
// import-identity test inside `packages/app-shell` cannot see this failure, and
// that is not a fixable detail of how it was written — it is structural. All of
// app-shell's specifiers share one package name resolved from one importer, so
// pnpm gives them one symlink target and the bindings are identical under any
// installation state reachable from that file. MEASURED, not reasoned: with a
// distinct physical core copy planted under BOTH companions (three different
// realpaths), `pragmatic-dnd-entry-points.test.ts` still passed 3/3. Catching a
// split copy requires comparing resolution ACROSS IMPORTERS, which is what this
// file does.
//
// Resolution-level rather than lockfile-level on purpose: this asserts against
// the node_modules tree that actually gets loaded, so it also catches a
// hand-mutated or partially-restored install, not just a lockfile that admits a
// duplicate.
const CORE_PACKAGE = '@atlaskit/pragmatic-drag-and-drop';

// DISCOVERED, not hardcoded, for the same reason the `@types/node` alignment
// contract discovers its manifests: a hardcoded importer list goes stale the day
// a second package adopts drag-and-drop, and it goes stale silently — the guard
// keeps passing while covering nothing. These globs mirror pnpm-workspace.yaml.
function discoverWorkspaceManifests() {
  const roots = ['apps', 'packages', 'packages/config'];
  const manifests = [];
  for (const root of roots) {
    const dir = path.join(repoRoot, root);
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifest = path.join(dir, entry.name, 'package.json');
      if (existsSync(manifest)) {
        manifests.push(manifest);
      }
    }
  }
  return manifests.sort();
}

function declaredDependencies(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

/**
 * Importers that declare core and/or a companion. A companion is any
 * `@atlaskit/pragmatic-drag-and-drop-*` package — discovered by prefix so a
 * newly adopted companion (`-react-beautiful-dnd-migration`, `-flourish`, ...)
 * is covered on the day it lands rather than the day someone remembers.
 */
function discoverDragAndDropConsumers() {
  const consumers = [];
  for (const manifestPath of discoverWorkspaceManifests()) {
    const deps = declaredDependencies(manifestPath);
    const names = Object.keys(deps).filter(
      (name) => name === CORE_PACKAGE || name.startsWith(`${CORE_PACKAGE}-`)
    );
    if (names.length > 0) {
      consumers.push({
        dir: path.dirname(manifestPath),
        packages: names.sort(),
        relative: path.relative(repoRoot, path.dirname(manifestPath)),
      });
    }
  }
  return consumers;
}

/** Resolve a package's real directory as seen FROM `fromDir`. */
function resolvePackageDir(fromDir, packageName) {
  const require_ = createRequire(path.join(fromDir, 'noop.cjs'));
  return path.dirname(realpathSync(require_.resolve(`${packageName}/package.json`)));
}

const consumers = discoverDragAndDropConsumers();

test('the drag-and-drop consumer set is non-empty', () => {
  // Fail loudly rather than vacuously passing: if this repo genuinely drops
  // pragmatic-dnd, delete this file in that change. A guard that silently
  // covers nothing is worse than no guard.
  assert.ok(
    consumers.length > 0,
    `No workspace package declares ${CORE_PACKAGE} or a companion. If drag-and-drop was removed, delete this contract in the same change.`
  );
});

test('node_modules is installed', () => {
  // This contract reads the resolved tree, so an uninstalled repo must error
  // clearly instead of resolving nothing and passing.
  assert.ok(
    existsSync(path.join(repoRoot, 'node_modules')),
    'node_modules is missing — run `pnpm install` before `pnpm test:scripts`.'
  );
});

test('every consumer and companion resolves ONE physical core copy', () => {
  /** @type {Map<string, string[]>} */
  const byRealPath = new Map();
  const record = (realPath, importer) => {
    const importers = byRealPath.get(realPath) ?? [];
    importers.push(importer);
    byRealPath.set(realPath, importers);
  };

  for (const consumer of consumers) {
    for (const packageName of consumer.packages) {
      if (packageName === CORE_PACKAGE) {
        // The workspace package's own view of core.
        record(resolvePackageDir(consumer.dir, CORE_PACKAGE), `${consumer.relative} (direct)`);
        continue;
      }
      // A companion: resolve the companion from the workspace package, then
      // resolve core FROM INSIDE the companion. This second hop is the whole
      // point — it is the only way a nested duplicate becomes visible.
      const companionDir = resolvePackageDir(consumer.dir, packageName);
      record(
        resolvePackageDir(companionDir, CORE_PACKAGE),
        `${packageName} (nested under ${consumer.relative})`
      );
    }
  }

  if (byRealPath.size > 1) {
    const detail = [...byRealPath.entries()]
      .map(
        ([realPath, importers]) =>
          `  ${path.relative(repoRoot, realPath)}\n    <- ${importers.join('\n    <- ')}`
      )
      .join('\n');
    assert.fail(
      `${CORE_PACKAGE} resolved to ${byRealPath.size} physical copies. The element adapter's draggableRegistry is module-scoped, so a split copy breaks drags SILENTLY — no type error, no peer warning.\n${detail}\n\nUsual cause: a companion range that still admits a build keyed to an older core major (see BST-1286). Fix the companion range so it pairs with the installed core, then re-run \`pnpm install\`.`
    );
  }

  assert.equal(byRealPath.size, 1);
});
