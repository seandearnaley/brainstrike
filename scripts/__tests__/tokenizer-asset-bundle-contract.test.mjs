import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findTokenizerAssetContractViolations } from '../verify-tokenizer-asset-bundle.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tokenizer-asset-'));
});

after(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

test('accepts a deferred tokenizer JSON asset referenced by JavaScript', async () => {
  const goodRoot = path.join(tempRoot, 'good');
  await mkdir(goodRoot);
  await writeFile(path.join(goodRoot, 'o200k_base-asset.json'), 'x'.repeat(2_000_000));
  await writeFile(
    path.join(goodRoot, 'token-utils-accurate-lite.js'),
    'const tokenizerUrl = "./o200k_base-asset.json";\n'
  );

  assert.deepEqual(await findTokenizerAssetContractViolations(goodRoot), []);
});

test('rejects a tokenizer table bundled back into JavaScript', async () => {
  const brokenRoot = path.join(tempRoot, 'broken');
  await mkdir(brokenRoot);
  await writeFile(path.join(brokenRoot, 'o200k_base-table.js'), 'x'.repeat(2000));

  const violations = await findTokenizerAssetContractViolations(brokenRoot);

  assert.equal(
    violations.some((violation) => violation.includes('tokenizer JavaScript payload')),
    true
  );
  assert.equal(
    violations.some((violation) => violation.includes('tokenizer JSON asset')),
    true
  );
});

test('both worker package builds install and verify the shared tokenizer asset plugin', async () => {
  for (const packageName of ['chunking-worker', 'token-cache']) {
    const packageRoot = path.join(repoRoot, 'packages', packageName);
    const tsupConfig = await readFile(path.join(packageRoot, 'tsup.config.ts'), 'utf8');
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

    assert.match(tsupConfig, /tokenizerAssetPlugin/);
    assert.match(packageJson.scripts.build, /verify-tokenizer-asset-bundle\.mjs dist/);
  }
});
