// @vitest-environment node
/**
 * BST-2148: no Node-side context of the desktop app loads Transformers.js or
 * onnxruntime-node, and the packaged app leaves onnxruntime-node out. Its
 * 1.24.1+ releases ship no darwin-x64 binding, so an x64 DMG that carried it
 * would carry an arm64-only addon. The production build (`scripts/build-main.mjs`)
 * walks the real emitted entries; this suite pins that walk on fixtures, so it
 * never depends on a built `dist/` or on workspace package builds.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoNodeInferenceImports,
  findNodeInferenceImports,
} from '../../scripts/node-inference-boundary.mjs';

interface DesktopBuildConfig {
  readonly build: { readonly files: readonly string[] };
}

const desktopPackage = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
) as DesktopBuildConfig;

// Where the collector lands onnxruntime-node: hoisted, and nested under its one dependent.
const ONNXRUNTIME_NODE_FILES = [
  'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
  'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.30.0.dylib',
  'node_modules/onnxruntime-node/dist/index.js',
  'node_modules/@huggingface/transformers/node_modules/onnxruntime-node/package.json',
];
// The web build and its runtime stay: excluding them is not this rule's business.
const RETAINED_FILES = [
  'node_modules/@huggingface/transformers/dist/transformers.web.js',
  'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
  'node_modules/onnxruntime-common/dist/cjs/index.js',
];

/**
 * electron-builder filters node_modules with `**\/*` followed by every `!` pattern
 * in `build.files` (app-builder-lib getNodeModuleFileMatcher), matched with
 * `{ dot: true }` against the file's path inside the app.
 */
function packagedByElectronBuilder(files: readonly string[], file: string): boolean {
  return files
    .filter((pattern) => pattern.startsWith('!'))
    .every((pattern) => !minimatch(file, pattern.slice(1), { dot: true }));
}

function packagedNodeInferenceViolations(config: DesktopBuildConfig): string[] {
  return [
    ...ONNXRUNTIME_NODE_FILES.filter((file) =>
      packagedByElectronBuilder(config.build.files, file)
    ).map((file) => `packaged app ships ${file}`),
    ...RETAINED_FILES.filter((file) => !packagedByElectronBuilder(config.build.files, file)).map(
      (file) => `packaged app drops ${file}`
    ),
  ];
}

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/** A disposable app root holding `files`, relative path to source. */
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bst-node-inference-'));
  cleanupPaths.push(root);
  for (const [relative, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), source);
  }
  return root;
}

const INSTALLED_INFERENCE_PACKAGES = {
  'node_modules/@huggingface/transformers/node.mjs':
    "import { createRequire } from 'node:module';\nexport const ort = createRequire(import.meta.url)('onnxruntime-node');\n",
  'node_modules/@huggingface/transformers/package.json': JSON.stringify({
    exports: { default: './web.js', node: './node.mjs' },
    name: '@huggingface/transformers',
  }),
  'node_modules/@huggingface/transformers/web.js': 'export const web = true;\n',
  'node_modules/onnxruntime-node/index.js': "module.exports = require('./binding.node');\n",
  'node_modules/onnxruntime-node/package.json': JSON.stringify({
    main: 'index.js',
    name: 'onnxruntime-node',
  }),
};

describe('packaged desktop app', () => {
  it('leaves onnxruntime-node out and keeps the web inference runtime', () => {
    expect(packagedNodeInferenceViolations(desktopPackage)).toEqual([]);
  });

  it('money test: dropping the exclusion ships the arm64-only binding again', () => {
    const files = desktopPackage.build.files.filter(
      (pattern) => !pattern.includes('onnxruntime-node')
    );
    expect(packagedNodeInferenceViolations({ build: { files } })).toEqual(
      ONNXRUNTIME_NODE_FILES.map((file) => `packaged app ships ${file}`)
    );
  });
});

describe('Node-side inference boundary', () => {
  it("names the chain to Transformers.js's Node build through a lazy dynamic import", async () => {
    const root = await fixture({
      ...INSTALLED_INFERENCE_PACKAGES,
      'dist/main.js': "require('electron');\nrequire('node:fs');\nrequire('embedding-backend');\n",
      'node_modules/embedding-backend/index.js':
        "exports.load = () => import(/* @vite-ignore */ '@huggingface/transformers');\n",
      'node_modules/embedding-backend/package.json': JSON.stringify({
        main: 'index.js',
        name: 'embedding-backend',
      }),
    });

    expect(
      await findNodeInferenceImports({ absWorkingDir: root, entryPoints: ['dist/main.js'] })
    ).toEqual([
      "dist/main.js -[require-call]-> node_modules/embedding-backend/index.js -[dynamic-import]-> '@huggingface/transformers'",
    ]);
  });

  it('resolves packages as Node does, ignoring tsconfig paths to their source', async () => {
    // apps/desktop/tsconfig.json maps @brainstrike/* to renderer SOURCE; Node never does.
    const root = await fixture({
      ...INSTALLED_INFERENCE_PACKAGES,
      'dist/main.js': "require('embedding-backend');\n",
      'node_modules/embedding-backend/index.js':
        "exports.load = () => import('@huggingface/transformers');\n",
      'node_modules/embedding-backend/package.json': JSON.stringify({
        main: 'index.js',
        name: 'embedding-backend',
      }),
      'src/embedding-backend.ts': 'export const load = () => undefined;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { 'embedding-backend': ['./src/embedding-backend.ts'] } },
      }),
    });

    expect(
      await findNodeInferenceImports({ absWorkingDir: root, entryPoints: ['dist/main.js'] })
    ).toEqual([
      "dist/main.js -[require-call]-> node_modules/embedding-backend/index.js -[dynamic-import]-> '@huggingface/transformers'",
    ]);
  });

  it('follows worker modules a reached module names by URL', async () => {
    const root = await fixture({
      ...INSTALLED_INFERENCE_PACKAGES,
      'dist/host.mjs':
        "import { Worker } from 'node:worker_threads';\nnew Worker(new URL('./writer-worker.mjs', import.meta.url));\n",
      'dist/writer-worker.mjs': "import 'onnxruntime-node';\n",
    });

    expect(
      await findNodeInferenceImports({ absWorkingDir: root, entryPoints: ['dist/host.mjs'] })
    ).toEqual([
      "dist/host.mjs -[new-url]-> dist/writer-worker.mjs -[import-statement]-> 'onnxruntime-node'",
    ]);
  });

  it('passes a graph that reaches neither package, including an unresolvable optional require', async () => {
    const root = await fixture({
      ...INSTALLED_INFERENCE_PACKAGES,
      'dist/main.js': "require('electron');\nrequire('ws-like');\n",
      'node_modules/ws-like/index.js':
        "try { require('bufferutil'); } catch {}\nmodule.exports = require('./addon.node');\n",
      'node_modules/ws-like/package.json': JSON.stringify({ main: 'index.js', name: 'ws-like' }),
    });

    expect(
      await findNodeInferenceImports({ absWorkingDir: root, entryPoints: ['dist/main.js'] })
    ).toEqual([]);
  });

  it('refuses a build with a named error listing every chain', () => {
    expect(() =>
      assertNoNodeInferenceImports([
        "dist/main.js -[require-call]-> '@huggingface/transformers'",
        "dist/worker.mjs -[import-statement]-> 'onnxruntime-node'",
      ])
    ).toThrow(
      [
        'Node-side desktop entries reach a package the packaged app does not ship (BST-2148):',
        "  dist/main.js -[require-call]-> '@huggingface/transformers'",
        "  dist/worker.mjs -[import-statement]-> 'onnxruntime-node'",
        'Local inference runs in hidden renderer hosts on the web build (ADR 0007).',
      ].join('\n')
    );
    expect(() => assertNoNodeInferenceImports([])).not.toThrow();
  });
});
