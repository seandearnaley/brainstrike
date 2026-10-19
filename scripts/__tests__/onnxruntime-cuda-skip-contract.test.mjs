// BST-2229: onnxruntime-node's postinstall only downloads the optional CUDA 12
// provider on Linux x64 (the CPU runtime is bundled for every platform). Vercel
// runs a second `pnpm install` for its functions without our install command's
// environment, so an env-var skip cannot reach every install; pnpm's reviewed
// build verdict can. This pins that verdict and the package fact it rests on.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Whether the workspace's reviewed build verdicts deny `name`'s install scripts. */
export function deniesBuild(workspace, name) {
  return workspace?.allowBuilds?.[name] === false;
}

/** The platforms whose onnxruntime-node postinstall would download anything. */
export function platformsNeedingInstall(requirements) {
  return Object.entries(requirements ?? {})
    .filter(([, names]) => Array.isArray(names) && names.length > 0)
    .map(([platform, names]) => `${platform}:${names.join(',')}`);
}

test('pnpm never runs onnxruntime-node install scripts', () => {
  const workspace = parse(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  assert.equal(
    deniesBuild(workspace, 'onnxruntime-node'),
    true,
    'allowBuilds.onnxruntime-node must be false'
  );
});

test("onnxruntime-node's postinstall would only fetch the optional Linux x64 CUDA provider", () => {
  // The day a release needs its postinstall for anything else, this goes red
  // and the verdict above has to be reviewed again.
  const store = path.join(repoRoot, 'node_modules/.pnpm');
  const installed = readdirSync(store).filter((entry) => entry.startsWith('onnxruntime-node@'));
  assert.equal(installed.length, 1, `expected one installed onnxruntime-node, found ${installed}`);
  const metadata = path.join(
    store,
    installed[0],
    'node_modules/onnxruntime-node/script/install-metadata.js'
  );
  const { requirements } = createRequire(import.meta.url)(metadata);
  assert.deepEqual(platformsNeedingInstall(requirements), ['linux/x64:cuda12']);
});

test('the guards reject a build verdict or metadata that would download at install', () => {
  assert.equal(
    deniesBuild({ allowBuilds: { 'onnxruntime-node': false } }, 'onnxruntime-node'),
    true
  );
  assert.equal(
    deniesBuild({ allowBuilds: { 'onnxruntime-node': true } }, 'onnxruntime-node'),
    false
  );
  assert.equal(deniesBuild({ allowBuilds: {} }, 'onnxruntime-node'), false);
  assert.deepEqual(platformsNeedingInstall({ 'darwin/arm64': [], 'linux/x64': ['cuda12'] }), [
    'linux/x64:cuda12',
  ]);
  assert.deepEqual(platformsNeedingInstall({ 'darwin/x64': ['cpu'] }), ['darwin/x64:cpu']);
});
