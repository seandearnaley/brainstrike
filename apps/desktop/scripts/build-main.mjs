/**
 * Bundle the Electron main-process code with esbuild (Electron performance
 * checklist recipe 7: "Bundle your code" — a single file per entry avoids the
 * per-file require() cost of the previous unbundled tsc output, ~80 modules at
 * cold start).
 *
 * Type checking is NOT done here — `pnpm type-check:main` runs
 * `tsc --noEmit --project tsconfig.main.json` for the CJS-mode type contract.
 *
 * The build options + entry list live in ./build-main-config.mjs (pure data,
 * pinned by src/__tests__/build-main-config.test.ts).
 */
import { existsSync } from 'node:fs';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NODE_BUILDS, PROCESS_LAUNCHERS } from './build-main-config.mjs';
import {
  assertNoNodeInferenceImports,
  findNodeInferenceImports,
} from './node-inference-boundary.mjs';
import {
  assertPreloadBundleRequires,
  PRELOAD_BUNDLE_ENTRY_NAMES,
} from './preload-bundle-contract.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Remove everything in dist/ EXCEPT the vite renderer output, so stale
 * per-file artifacts from the previous tsc layout (dist/ipc-*.js,
 * dist/assistant-server/**, …) cannot shadow or confuse the bundled build.
 */
async function cleanMainProcessOutputs() {
  const distDir = path.join(appRoot, 'dist');
  if (!existsSync(distDir)) {
    return;
  }
  const entries = await readdir(distDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== 'renderer')
      .map((entry) => rm(path.join(distDir, entry.name), { force: true, recursive: true }))
  );
}

/**
 * The preloads run sandboxed: `require` resolves nothing but `electron`
 * there, so a bundle that requires anything else is a launch-time failure.
 * Refuse to ship it (BST-1648).
 */
async function assertPreloadBundlesAreSandboxSafe() {
  for (const entryName of PRELOAD_BUNDLE_ENTRY_NAMES) {
    const fileName = `${entryName}.cjs`;
    const source = await readFile(path.join(appRoot, 'dist', fileName), 'utf8');
    assertPreloadBundleRequires(fileName, source);
  }
}

/**
 * The indexer host chunks code in Node, where the bundled tree-sitter loader
 * reads its vendored grammars from `grammars/` beside itself.
 */
async function copyNodeGrammars() {
  await cp(
    path.resolve(appRoot, '../../packages/chunking-worker/grammars'),
    path.join(appRoot, 'dist', 'grammars'),
    { recursive: true }
  );
}

/** Each launcher is its imports, in order (see PROCESS_LAUNCHERS). */
async function writeProcessLaunchers() {
  for (const [name, imports] of Object.entries(PROCESS_LAUNCHERS)) {
    const source = imports.map((specifier) => `import '${specifier}';\n`).join('');
    await writeFile(path.join(appRoot, 'dist', `${name}.js`), source);
  }
}

await cleanMainProcessOutputs();
// Every Node-side entry Main, a utility process, a worker or the Windows command
// path loads. None may reach Transformers.js or onnxruntime-node, which the
// packaged app leaves out (BST-2148); the gate reads each build's own metafile.
const builds = [];
for (const options of NODE_BUILDS) {
  builds.push((await build({ ...options, metafile: true })).metafile);
}
await writeProcessLaunchers();
await copyNodeGrammars();
await assertPreloadBundlesAreSandboxSafe();
assertNoNodeInferenceImports(await findNodeInferenceImports({ absWorkingDir: appRoot, builds }));
