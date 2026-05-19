import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  validateArchitectureDomainBoundaries,
} from '../architecture-domain-boundaries.mjs';

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeSource = async (filePath, source) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source);
};

const makeWorkspace = async ({ sources }, testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-domain-boundaries-'));
  testContext.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const packages = [
    ['apps/web', '@brainstrike/web'],
    ['packages/app-shell', '@brainstrike/app-shell'],
    ['packages/db', '@brainstrike/db'],
    ['packages/ui', '@brainstrike/ui'],
    ['packages/utils', '@brainstrike/utils'],
  ];

  for (const [directory, packageName] of packages) {
    await writeJson(path.join(root, directory, 'package.json'), {
      name: packageName,
      version: '0.0.0',
    });
  }

  await writeJson(path.join(root, 'architecture/domain-map.json'), {
    version: 1,
    stack: [],
    domains: [
      {
        id: 'applications',
        title: 'Applications',
        owner: 'platform',
        packages: ['@brainstrike/web'],
        mayDependOn: ['workspace-experience', 'data-platform', 'shared-foundation'],
      },
      {
        id: 'workspace-experience',
        title: 'Workspace',
        owner: 'workspace',
        packages: ['@brainstrike/app-shell'],
        mayDependOn: ['data-platform', 'shared-foundation'],
      },
      {
        id: 'data-platform',
        title: 'Data',
        owner: 'data',
        packages: ['@brainstrike/db'],
        mayDependOn: ['shared-foundation'],
      },
      {
        id: 'shared-foundation',
        title: 'Shared',
        owner: 'foundation',
        packages: ['@brainstrike/ui', '@brainstrike/utils'],
        mayDependOn: [],
      },
    ],
    boundaryExceptions: [],
  });

  for (const [relativePath, source] of sources) {
    await writeSource(path.join(root, relativePath), source);
  }

  return root;
};

test('accepts same-domain and explicitly allowed lower-domain imports', async (t) => {
  const root = await makeWorkspace({
    sources: [
      [
        'apps/web/src/main.tsx',
        "import { Shell } from '@brainstrike/app-shell';\nimport { logger } from '@brainstrike/utils/logger';\nvoid Shell;\nvoid logger;\n",
      ],
      [
        'packages/app-shell/src/panel.ts',
        "export { Button } from '@brainstrike/ui';\nimport type { Logger } from '@brainstrike/utils/logger';\n",
      ],
    ],
  }, t);

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(result.violations, []);
  assert.equal(result.summary.checkedImportCount, 4);
});

test('rejects imports from lower-level domains into higher-level domains', async (t) => {
  const root = await makeWorkspace({
    sources: [
      [
        'packages/db/src/store.ts',
        "import { Shell } from '@brainstrike/app-shell';\nimport type { WebApp } from '@brainstrike/web';\n",
      ],
    ],
  }, t);

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(result.violations.map((violation) => violation.message), [
    '@brainstrike/db (data-platform) must not import @brainstrike/app-shell (workspace-experience)',
    '@brainstrike/db (data-platform) must not import @brainstrike/web (applications)',
  ]);
});

test('recognizes subpath imports, dynamic imports, require calls, import-equals, and import types', async (t) => {
  const root = await makeWorkspace({
    sources: [
      [
        'packages/ui/src/component.ts',
        "type Shell = import('@brainstrike/app-shell/panel').Shell;\nconst data = import('@brainstrike/db/client');\nconst shell = require('@brainstrike/app-shell');\nimport legacyWeb = require('@brainstrike/web/legacy');\nvoid data;\nvoid shell;\nvoid legacyWeb;\n",
      ],
    ],
  }, t);

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(result.violations.map((violation) => violation.importedPackage), [
    '@brainstrike/app-shell',
    '@brainstrike/db',
    '@brainstrike/app-shell',
    '@brainstrike/web',
  ]);
});

test('sorts violations numerically within each file', async (t) => {
  const root = await makeWorkspace({
    sources: [
      [
        'packages/ui/src/component.ts',
        [
          "import { one } from '@brainstrike/db/one';",
          'void one;',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          "import { ten } from '@brainstrike/db/ten';",
          'void ten;',
          '',
          "import { twelve } from '@brainstrike/app-shell/twelve';",
          'void twelve;',
        ].join('\n'),
      ],
    ],
  }, t);

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(
    result.violations.map((violation) => violation.line),
    [1, 10, 13]
  );
});

test('reports stale approved boundary exceptions', async (t) => {
  const root = await makeWorkspace({
    sources: [['packages/ui/src/component.ts', "export const value = 'safe';\n"]],
  }, t);
  const contractPath = path.join(root, 'architecture/domain-map.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  await writeFile(path.join(root, 'phase-test.html'), '<!doctype html><title>Phase test</title>\n');
  contract.stack = [
    {
      id: 'phase-test',
      dependsOn: null,
      planningArtifact: 'phase-test.html',
    },
  ];
  contract.boundaryExceptions = [
    {
      id: 'stale-ui-db',
      sourcePackage: '@brainstrike/ui',
      importedPackage: '@brainstrike/db',
      reason: 'Test fixture stale exception.',
      retireByPhase: 'phase-test',
    },
  ];
  await writeJson(contractPath, contract);

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(result.staleBoundaryExceptions, [
    {
      sourcePackage: '@brainstrike/ui',
      importedPackage: '@brainstrike/db',
      message: 'approved boundary exception is stale: @brainstrike/ui -> @brainstrike/db',
    },
  ]);
});

test('keeps the committed Brainstrike workspace inside the declared domain boundaries', async () => {
  const result = await validateArchitectureDomainBoundaries({ root: process.cwd() });

  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.staleBoundaryExceptions, []);
  assert.ok(result.summary.checkedFileCount > 0);
  assert.ok(result.summary.checkedImportCount > 0);
});
