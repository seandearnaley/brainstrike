import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  discoverMutationContracts,
  evaluateMutationContract,
  SUPPORTED_REPORTERS,
  verifyMutationContracts,
} from '../verify-stryker-mutation-contracts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ESM_CONFIG = `export default {
  reporters: ['clear-text', 'html', 'progress'],
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts' },
};
`;

const CJS_CONFIG = `'use strict';
module.exports = {
  reporters: ['clear-text', 'progress'],
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts' },
};
`;

/**
 * Build a throwaway packages tree. `files` maps relative paths to contents;
 * every package gets a `vitest.mutation.config.ts` stub unless it supplies
 * its own.
 */
async function writeFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bst-1331-guard-'));
  const packagesRoot = path.join(root, 'packages');
  await mkdir(packagesRoot, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(packagesRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return packagesRoot;
}

function alphaFiles(script, configContents) {
  return {
    'alpha/package.json': JSON.stringify({
      name: '@brainstrike/alpha',
      scripts: { mutation: script },
      type: 'module',
    }),
    ...(configContents === undefined ? {} : { 'alpha/stryker.config.js': configContents }),
  };
}

test('real tree: all eight current packages have sound mutation contracts', async () => {
  const { contracts, violations } = await verifyMutationContracts({
    packagesRoot: path.join(REPO_ROOT, 'packages'),
  });
  assert.deepEqual(
    contracts.map((contract) => contract.packageName),
    [
      '@brainstrike/db',
      '@brainstrike/file-explorer',
      '@brainstrike/file-explorer-hooks',
      '@brainstrike/file-system',
      '@brainstrike/hooks',
      '@brainstrike/test-utils',
      '@brainstrike/utils',
      '@brainstrike/workers',
    ]
  );
  assert.deepEqual(
    violations,
    [],
    `Mutation-lane contract drift:\n${violations.map((v) => `  - ${v}`).join('\n')}`
  );
});

test('DISCOVERY: a package without a mutation script is not part of the contract', async () => {
  const packagesRoot = await writeFixture({
    ...alphaFiles('stryker run', ESM_CONFIG),
    'beta/package.json': JSON.stringify({ name: '@brainstrike/beta' }),
  });
  const contracts = await discoverMutationContracts({ packagesRoot });
  assert.deepEqual(
    contracts.map((contract) => contract.packageName),
    ['@brainstrike/alpha']
  );
});

test('RED CLASS: an npx registry-resolved mutation script fails the guard', async () => {
  const packagesRoot = await writeFixture({
    ...alphaFiles('npx @stryker-mutator/core run', ESM_CONFIG),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ packagesRoot });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /resolves @stryker-mutator\/core from the registry/);
});

test('RED CLASS: a missing stryker config fails loudly instead of passing vacuously', async () => {
  const packagesRoot = await writeFixture(alphaFiles('stryker run'));
  const [contract] = await discoverMutationContracts({ packagesRoot });
  assert.equal(contract.configPath, undefined);
  const violations = await evaluateMutationContract(contract);
  assert.match(violations[0], /no stryker\.config\.\{js,cjs,mjs\} found/);
});

test('RED CLASS: a config that cannot load under ESM semantics fails with the cause', async () => {
  // `"type": "module"` + CommonJS syntax in a .js file = SyntaxError on import.
  const packagesRoot = await writeFixture(
    alphaFiles('stryker run', CJS_CONFIG.replace("'use strict';\n", ''))
  );
  const [contract] = await discoverMutationContracts({ packagesRoot });
  const violations = await evaluateMutationContract(contract);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /failed to load under its ESM\/CJS semantics/);
});

test('the CJS escape hatch (.cjs) loads CommonJS configs cleanly', async () => {
  const packagesRoot = await writeFixture({
    'alpha/package.json': JSON.stringify({
      name: '@brainstrike/alpha',
      scripts: { mutation: 'stryker run' },
    }),
    'alpha/stryker.config.cjs': CJS_CONFIG,
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ packagesRoot });
  assert.deepEqual(violations, []);
});

test('RED CLASS: a Vitest-4-unsupported reporter (basic) fails the guard', async () => {
  const packagesRoot = await writeFixture({
    ...alphaFiles(
      'stryker run',
      `export default {
        reporters: ['basic'],
        vitest: { configFile: 'vitest.mutation.config.ts' },
      };
`
    ),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ packagesRoot });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reporter "basic" is not in the supported set/);
});

test('RED CLASS: object-style reporter entries are validated too', async () => {
  const packagesRoot = await writeFixture({
    ...alphaFiles(
      'stryker run',
      `export default {
        reporters: [{ name: 'html' }, { name: 'basic' }],
        vitest: { configFile: 'vitest.mutation.config.ts' },
      };
`
    ),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ packagesRoot });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reporter "basic"/);
});

test('RED CLASS: dropping the per-package mutation vitest wiring fails two ways', async () => {
  const packagesRoot = await writeFixture(
    alphaFiles(
      'stryker run',
      `export default {
        reporters: ['html'],
        vitest: { configFile: 'vitest.renamed.config.ts' },
      };
`
    )
  );
  const { violations } = await verifyMutationContracts({ packagesRoot });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must point vitest\.configFile at vitest\.mutation\.config\.ts/);

  const dangling = await writeFixture(
    alphaFiles(
      'stryker run',
      `export default {
        reporters: ['html'],
        vitest: { configFile: 'vitest.mutation.config.ts' },
      };
`
    )
  );
  const { violations: danglingViolations } = await verifyMutationContracts({
    packagesRoot: dangling,
  });
  assert.equal(danglingViolations.length, 1);
  assert.match(danglingViolations[0], /does not exist/);
});

test('a supported-reporter config with real vitest wiring passes end to end', async () => {
  const packagesRoot = await writeFixture({
    'alpha/package.json': JSON.stringify({
      name: '@brainstrike/alpha',
      scripts: { mutation: 'stryker run' },
      type: 'module',
    }),
    'alpha/stryker.config.js': ESM_CONFIG,
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { contracts, violations } = await verifyMutationContracts({ packagesRoot });
  assert.equal(contracts.length, 1);
  assert.deepEqual(violations, []);
});

test('the supported reporter set matches what the Vitest 4 lane can execute', () => {
  assert.deepEqual([...SUPPORTED_REPORTERS].sort(), ['clear-text', 'html', 'json', 'progress']);
});

test('an empty discovery set is itself a contract failure (no silent vacuous green)', async () => {
  const packagesRoot = await writeFixture({});
  await assert.rejects(
    () => verifyMutationContracts({ packagesRoot }),
    /No package mutation scripts/
  );
});
