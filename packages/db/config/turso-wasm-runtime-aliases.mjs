// Shared Vite/Vitest alias map for the @tursodatabase/database-wasm runtime
// dependency graph. Used by BOTH packages/db/vitest.config.mts (browser test
// project) and apps/web/vite.config.mts (production web build) so tests and
// the shipped bundle resolve the SAME wasm-runtime module graph.
//
// Why these aliases exist (see docs/turso-migration/migration-ledger.md,
// "Browser Journal-Mode Contract Decision"):
//
// 1. @emnapi/* version pinning: database-wasm-common's emnapi imports flow
//    through @napi-rs/wasm-runtime, whose looser ^ range resolves a NEWER
//    @emnapi/core than the exact 1.8.x the turso wasm binary was built
//    against. @emnapi/core >= 1.10 rewrote the async-work pool: its
//    `initWorkers` dereferences `PThread.pthreads[tid].whenLoaded`, which
//    faults DETERMINISTICALLY against turso's wasm (store open never
//    succeeds). Aliasing the three emnapi packages to the copies nested next
//    to database-wasm-common honors upstream's own pins and self-heals on
//    vendor upgrades.
//
// 2. @tybys/wasm-util absolute-path pinning: @napi-rs/wasm-runtime's
//    runtime.js imports the bare specifier '@tybys/wasm-util'. Vite 8's
//    worker sub-build (vite:worker-import-meta-url processes database-wasm's
//    `new Worker(new URL('./worker.js', import.meta.url))`) resolves that
//    bare import from inside the pnpm store; on Vercel that store-sibling
//    lookup failed ("Rolldown failed to resolve import \"@tybys/wasm-util\"")
//    even though the lockfile declares the dependency at every level. The
//    alias resolves it to an absolute file at config-eval time so the worker
//    sub-build never depends on nested-store sibling resolution.
//
// All resolution here is anchored at the packages the vendors themselves
// declare (Node-style node_modules walk from the DEPENDENT package), so a
// vendor version bump automatically re-pins.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Build the alias map, resolving the graph relative to `fromDir` (a directory
 * that can resolve `@tursodatabase/database-wasm`, e.g. packages/db).
 *
 * @param {string} fromDir
 * @returns {Record<string, string>}
 */
export function createTursoWasmRuntimeAliasMap(fromDir) {
  // database-wasm-common is a transitive dependency (via database-wasm), so
  // resolve it the way node would: from the database-wasm package dir.
  const wasmDir = resolveNodePackageDir('@tursodatabase/database-wasm', fromDir);
  const wasmCommonDir = resolveNodePackageDir('@tursodatabase/database-wasm-common', wasmDir);
  const coreDir = resolveNodePackageDir('@emnapi/core', wasmCommonDir);
  const runtimeDir = resolveNodePackageDir('@emnapi/runtime', wasmCommonDir);
  // wasi-threads is a dependency of @emnapi/core, so resolve it from there.
  const wasiThreadsDir = resolveNodePackageDir('@emnapi/wasi-threads', coreDir);
  // wasm-util is a dependency of @napi-rs/wasm-runtime, so resolve it from there.
  const napiWasmRuntimeDir = resolveNodePackageDir('@napi-rs/wasm-runtime', wasmCommonDir);
  const wasmUtilDir = resolveNodePackageDir('@tybys/wasm-util', napiWasmRuntimeDir);
  return {
    '@emnapi/core': requireEsmDist(coreDir, 'dist/emnapi-core.mjs'),
    '@emnapi/runtime': requireEsmDist(runtimeDir, 'dist/emnapi.mjs'),
    '@emnapi/wasi-threads': requireEsmDist(wasiThreadsDir, 'dist/wasi-threads.mjs'),
    '@tybys/wasm-util': requireEsmDist(wasmUtilDir, 'dist/wasm-util.esm-bundler.js'),
  };
}

/**
 * Node-style node_modules walk. The turso wasm chain packages expose
 * import-only `exports` maps, so createRequire cannot resolve them.
 *
 * @param {string} packageName
 * @param {string} fromDir
 * @returns {string}
 */
function resolveNodePackageDir(packageName, fromDir) {
  let dir = fs.realpathSync(fromDir);
  for (;;) {
    const base = path.basename(dir) === 'node_modules' ? dir : path.join(dir, 'node_modules');
    const candidate = path.join(base, ...packageName.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not resolve ${packageName} from ${fromDir} for the turso wasm runtime aliases.`
      );
    }
    dir = parent;
  }
}

/**
 * @param {string} packageDir
 * @param {string} distRelativePath
 * @returns {string}
 */
function requireEsmDist(packageDir, distRelativePath) {
  const target = path.join(packageDir, distRelativePath);
  if (!fs.existsSync(target)) {
    throw new Error(
      `Expected ESM dist at ${target}; the wasm-runtime packaging layout changed — update packages/db/config/turso-wasm-runtime-aliases.mjs.`
    );
  }
  return target;
}
