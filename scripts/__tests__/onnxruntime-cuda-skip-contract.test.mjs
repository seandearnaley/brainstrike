// BST-2229: onnxruntime-node's postinstall (allowed in pnpm-workspace.yaml's
// allowBuilds) downloads the CUDA GPU runtime from nuget.org on Linux x64 unless
// ONNXRUNTIME_NODE_INSTALL_CUDA=skip. Nothing in the repo uses the GPU runtime,
// and the download failed a Vercel web build when nuget.org was unreachable, so
// every repository install path skips it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');

/** Whether a workflow installs the workspace, directly or through setup-workspace. */
export function installsWorkspace(source) {
  return /\bpnpm install\b/.test(source) || source.includes('./.github/actions/setup-workspace');
}

/** Whether a parsed workflow skips the CUDA download for every job. */
export function workflowSkipsCuda(workflow) {
  return workflow?.env?.ONNXRUNTIME_NODE_INSTALL_CUDA === 'skip';
}

/** Whether a Vercel install command skips the CUDA download for its pnpm install. */
export function vercelInstallSkipsCuda(installCommand) {
  return /\bONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install\b/.test(installCommand ?? '');
}

test('every workflow that installs the workspace skips the onnxruntime CUDA download', () => {
  const installing = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, source: readFileSync(path.join(workflowsDir, name), 'utf8') }))
    .filter(({ source }) => installsWorkspace(source));
  assert.ok(installing.length > 0, 'expected workflows that install the workspace');
  const missing = installing
    .filter(({ source }) => !workflowSkipsCuda(parse(source)))
    .map(({ name }) => name);
  assert.deepEqual(missing, [], 'set workflow-level env ONNXRUNTIME_NODE_INSTALL_CUDA: skip');
});

test('the Vercel web install skips the onnxruntime CUDA download', () => {
  const vercel = JSON.parse(readFileSync(path.join(repoRoot, 'apps/web/vercel.json'), 'utf8'));
  assert.ok(
    vercelInstallSkipsCuda(vercel.installCommand),
    `installCommand must run ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install, got: ${vercel.installCommand}`
  );
});

test('the guards reject installs that would download the CUDA runtime', () => {
  assert.equal(installsWorkspace('steps:\n  - run: pnpm install --frozen-lockfile'), true);
  assert.equal(installsWorkspace('uses: ./.github/actions/setup-workspace'), true);
  assert.equal(installsWorkspace('run: node scripts/check.mjs'), false);
  assert.equal(workflowSkipsCuda({ env: { ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' } }), true);
  assert.equal(workflowSkipsCuda({ env: {} }), false);
  assert.equal(workflowSkipsCuda({ jobs: {} }), false);
  assert.equal(
    vercelInstallSkipsCuda('cd ../.. && ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install'),
    true
  );
  assert.equal(vercelInstallSkipsCuda('cd ../.. && pnpm install'), false);
  assert.equal(vercelInstallSkipsCuda(undefined), false);
});
