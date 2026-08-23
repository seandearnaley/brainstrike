import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  discoverMutationContracts,
  evaluateMutationContract,
  STRYKER_CONFIG_PRECEDENCE,
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
 * Build a throwaway workspace. `files` maps paths (relative to `packages/`)
 * to contents; a pnpm-workspace.yaml declaring `workspaceGlobs` (default
 * `packages/*`) is written at the root, mirroring how the real guard derives
 * its scan scope.
 */
async function writeFixture(files, { workspaceGlobs = ['packages/*'] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bst-1331-guard-'));
  const yaml = `packages:\n${workspaceGlobs.map((glob) => `  - '${glob}'`).join('\n')}\n`;
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), yaml);
  const packagesRoot = path.join(root, 'packages');
  await mkdir(packagesRoot, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(packagesRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

function alphaFiles(script, configContents, { withStrykerCoreDep = true } = {}) {
  return {
    'alpha/package.json': JSON.stringify({
      name: '@brainstrike/alpha',
      scripts: { mutation: script },
      type: 'module',
      ...(withStrykerCoreDep ? { devDependencies: { '@stryker-mutator/core': '^10.0.0' } } : {}),
    }),
    ...(configContents === undefined ? {} : { 'alpha/stryker.config.js': configContents }),
  };
}

test('real tree: all eight current packages have sound mutation contracts', async () => {
  const { contracts, violations } = await verifyMutationContracts({ repoRoot: REPO_ROOT });
  // Violations print first so genuine contract drift is self-describing even
  // when a new package's NAME is also part of the drift — a roster-only diff
  // would otherwise hide the violation detail behind an array comparison.
  assert.deepEqual(
    violations,
    [],
    `Mutation-lane contract drift:\n${violations.map((v) => `  - ${v}`).join('\n')}`
  );
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
    ],
    'Mutation-package roster drift: if you added or removed a package with a `mutation` ' +
      'script, update this roster deliberately — it forces review of the new lane alongside ' +
      'scripts/__tests__/verify-stryker-mutation-contracts.test.mjs.'
  );
});

test('DISCOVERY scope: nested workspace globs are expanded, not just direct packages/* children', async () => {
  const root = await writeFixture(
    {
      'config/tooling/package.json': JSON.stringify({
        devDependencies: { '@stryker-mutator/core': '^10.0.0' },
        name: '@brainstrike/tooling',
        scripts: { mutation: 'stryker run' },
      }),
      'config/tooling/stryker.config.mjs': ESM_CONFIG,
      'config/tooling/vitest.mutation.config.ts': 'export default { test: {} };\n',
    },
    { workspaceGlobs: ['packages/config/*'] }
  );
  const contracts = await discoverMutationContracts({ repoRoot: root });
  assert.deepEqual(
    contracts.map((contract) => contract.packageName),
    ['@brainstrike/tooling']
  );
});

test('DISCOVERY: a package without a mutation script is not part of the contract', async () => {
  const root = await writeFixture({
    ...alphaFiles('stryker run', ESM_CONFIG),
    'beta/package.json': JSON.stringify({ name: '@brainstrike/beta' }),
  });
  const contracts = await discoverMutationContracts({ repoRoot: root });
  assert.deepEqual(
    contracts.map((contract) => contract.packageName),
    ['@brainstrike/alpha']
  );
});

test('RED CLASS: an unparseable package.json under a scanned root fails loudly, not silently', async () => {
  const root = await writeFixture({
    'alpha/package.json': '{"name": "@brainstrike/alpha", "scripts": {',
  });
  await assert.rejects(
    () => discoverMutationContracts({ repoRoot: root }),
    /Failed to parse.*package\.json/
  );
});

test('RED CLASS: an npx registry-resolved mutation script fails the guard', async () => {
  const root = await writeFixture({
    ...alphaFiles('npx @stryker-mutator/core run', ESM_CONFIG),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must invoke the installed workspace binary/);
});

test('RED CLASS: a registry-resolved `npx stryker run` still fails the allowlist', async () => {
  const root = await writeFixture({
    ...alphaFiles('npx stryker run', ESM_CONFIG),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must invoke the installed workspace binary/);
});

test('RED CLASS: a neutered mutation script (`echo skipped`) cannot read green', async () => {
  const root = await writeFixture({
    ...alphaFiles('echo skipped', ESM_CONFIG),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must invoke the installed workspace binary/);
});

test('RED CLASS: a copied mutation script without the @stryker-mutator/core dependency fails', async () => {
  const root = await writeFixture({
    ...alphaFiles('stryker run', ESM_CONFIG, { withStrykerCoreDep: false }),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no @stryker-mutator\/core dependency/);
});

test('RED CLASS: a missing stryker config fails loudly instead of passing vacuously', async () => {
  const root = await writeFixture(alphaFiles('stryker run'));
  const [contract] = await discoverMutationContracts({ repoRoot: root });
  assert.equal(contract.configPath, undefined);
  const violations = await evaluateMutationContract(contract);
  assert.match(violations[0], /no stryker config found/);
});

test('RED CLASS: a config that cannot load under ESM semantics fails with the cause', async () => {
  // `"type": "module"` + CommonJS syntax in a .js file = SyntaxError on import.
  const root = await writeFixture(
    alphaFiles('stryker run', CJS_CONFIG.replace("'use strict';\n", ''))
  );
  const [contract] = await discoverMutationContracts({ repoRoot: root });
  const violations = await evaluateMutationContract(contract);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /failed to load under its ESM\/CJS semantics/);
});

test('the CJS escape hatch (.cjs) loads CommonJS configs cleanly', async () => {
  const root = await writeFixture({
    'alpha/package.json': JSON.stringify({
      devDependencies: { '@stryker-mutator/core': '^10.0.0' },
      name: '@brainstrike/alpha',
      scripts: { mutation: 'stryker run' },
    }),
    'alpha/stryker.config.cjs': CJS_CONFIG,
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.deepEqual(violations, []);
});

test('.mjs configs are discovered and load cleanly (candidate-coverage parity)', async () => {
  const root = await writeFixture({
    'alpha/package.json': JSON.stringify({
      devDependencies: { '@stryker-mutator/core': '^10.0.0' },
      name: '@brainstrike/alpha',
      scripts: { mutation: 'stryker run' },
    }),
    'alpha/stryker.config.mjs': ESM_CONFIG,
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { contracts, violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(contracts.length, 1);
  assert.deepEqual(violations, []);
});

test('RED CLASS: two coexisting stryker configs fail as ambiguous, validating Stryker precedence', async () => {
  const root = await writeFixture({
    ...alphaFiles('stryker run', CJS_CONFIG.replace("'use strict';\n", '')),
    // A stale-but-valid .cjs next to a broken .js replacement: Stryker 10
    // loads the .js (its precedence puts js before cjs), so the guard must
    // evaluate the .js too — and flag the lingering sibling either way.
    'alpha/stryker.config.cjs': CJS_CONFIG,
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const [contract] = await discoverMutationContracts({ repoRoot: root });
  assert.equal(path.basename(contract.configPath), 'stryker.config.js');
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 2);
  assert.match(violations[0], /stryker config files present/);
  assert.match(violations[1], /failed to load under its ESM\/CJS semantics/);
});

test('config selection follows Stryker precedence exactly: .conf.json beats .config.js', async () => {
  const root = await writeFixture({
    ...alphaFiles('stryker run', 'this is not valid javascript'),
    'alpha/stryker.conf.json': JSON.stringify({
      reporters: ['progress'],
      vitest: { configFile: 'vitest.mutation.config.ts' },
    }),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const [contract] = await discoverMutationContracts({ repoRoot: root });
  assert.equal(path.basename(contract.configPath), 'stryker.conf.json');
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  // Exactly ONE violation (the ambiguous sibling): had the guard evaluated the
  // broken .config.js instead of the JSON file Stryker actually loads, this
  // would be a load failure instead.
  assert.equal(violations.length, 1);
  assert.match(violations[0], /stryker config files present/);
});

test('RED CLASS: a non-array reporters value is a loud violation, never coerced silent', async () => {
  const root = await writeFixture({
    ...alphaFiles(
      'stryker run',
      `export default {
        reporters: 'basic',
        vitest: { configFile: 'vitest.mutation.config.ts' },
      };
`
    ),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reporters must be an array/);
  assert.match(violations[0], /"basic"/);
});

test('RED CLASS: an object-shaped reporters value is a loud violation too', async () => {
  const root = await writeFixture({
    ...alphaFiles(
      'stryker run',
      `export default {
        reporters: { html: true },
        vitest: { configFile: 'vitest.mutation.config.ts' },
      };
`
    ),
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reporters must be an array/);
});

test('RED CLASS: a Vitest-4-unsupported reporter (basic) fails the guard', async () => {
  const root = await writeFixture({
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
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reporter "basic" is outside the agreed mutation-reporter set/);
});

test('RED CLASS: object-style reporter entries are validated too', async () => {
  const root = await writeFixture({
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
  const { violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reporter "basic"/);
});

test('RED CLASS: dropping the per-package mutation vitest wiring fails two ways', async () => {
  const root = await writeFixture(
    alphaFiles(
      'stryker run',
      `export default {
        reporters: ['html'],
        vitest: { configFile: 'vitest.renamed.config.ts' },
      };
`
    )
  );
  const { violations } = await verifyMutationContracts({ repoRoot: root });
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
  const { violations: danglingViolations } = await verifyMutationContracts({ repoRoot: dangling });
  assert.equal(danglingViolations.length, 1);
  assert.match(danglingViolations[0], /does not exist/);
});

test('a supported-reporter config with real vitest wiring passes end to end', async () => {
  const root = await writeFixture({
    'alpha/package.json': JSON.stringify({
      devDependencies: { '@stryker-mutator/core': '^10.0.0' },
      name: '@brainstrike/alpha',
      scripts: { mutation: 'stryker run' },
      type: 'module',
    }),
    'alpha/stryker.config.js': ESM_CONFIG,
    'alpha/vitest.mutation.config.ts': 'export default { test: {} };\n',
  });
  const { contracts, violations } = await verifyMutationContracts({ repoRoot: root });
  assert.equal(contracts.length, 1);
  assert.deepEqual(violations, []);
});

test('the agreed reporter set is exactly the house roster', () => {
  assert.deepEqual([...SUPPORTED_REPORTERS].sort(), ['clear-text', 'html', 'json', 'progress']);
});

test('config candidates mirror @stryker-mutator/core 10 SUPPORTED_CONFIG_FILE_NAMES', () => {
  assert.deepEqual(STRYKER_CONFIG_PRECEDENCE.slice(0, 4), [
    'stryker.conf.json',
    'stryker.conf.js',
    'stryker.conf.mjs',
    'stryker.conf.cjs',
  ]);
  assert.deepEqual(STRYKER_CONFIG_PRECEDENCE.slice(4, 8), [
    'stryker.config.json',
    'stryker.config.js',
    'stryker.config.mjs',
    'stryker.config.cjs',
  ]);
  assert.ok(STRYKER_CONFIG_PRECEDENCE.includes('.stryker.conf.json'));
  assert.ok(STRYKER_CONFIG_PRECEDENCE.includes('.stryker.config.cjs'));
  assert.equal(STRYKER_CONFIG_PRECEDENCE.length, 16);
});

test('an empty discovery set is itself a contract failure (no silent vacuous green)', async () => {
  const root = await writeFixture({});
  await assert.rejects(
    () => verifyMutationContracts({ repoRoot: root }),
    /No package mutation scripts/
  );
});

test('RED CLASS: a repoRoot without a readable pnpm-workspace.yaml fails loudly', async () => {
  const bare = await mkdtemp(path.join(os.tmpdir(), 'bst-1331-no-yaml-'));
  await assert.rejects(
    () => verifyMutationContracts({ repoRoot: bare }),
    /Cannot read.*pnpm-workspace\.yaml/
  );
});
