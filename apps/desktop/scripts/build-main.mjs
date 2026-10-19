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
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  AGENT_HOST_PLATFORM_BUILD_OPTIONS,
  MAIN_PROCESS_BUILD_OPTIONS,
} from './build-main-config.mjs';
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
    const fileName = `${entryName}.js`;
    const source = await readFile(path.join(appRoot, 'dist', fileName), 'utf8');
    assertPreloadBundleRequires(fileName, source);
  }
}

/**
 * Every emitted Node-side file is an entry Main, a utility process or a worker
 * loads. None may reach Transformers.js or onnxruntime-node, which the packaged
 * app leaves out (BST-2148). The renderer is a browser bundle and stays out.
 */
async function assertNodeEntriesLoadNoLocalInference() {
  const entries = await readdir(path.join(appRoot, 'dist'), { withFileTypes: true });
  assertNoNodeInferenceImports(
    await findNodeInferenceImports({
      absWorkingDir: appRoot,
      entryPoints: entries
        .filter((entry) => entry.isFile() && /\.(?:c|m)?js$/u.test(entry.name))
        .map((entry) => `dist/${entry.name}`),
    })
  );
}

await cleanMainProcessOutputs();
await build(MAIN_PROCESS_BUILD_OPTIONS);
await build(AGENT_HOST_PLATFORM_BUILD_OPTIONS);
await assertPreloadBundlesAreSandboxSafe();
await assertNodeEntriesLoadNoLocalInference();
