import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateArchitectureDomainBoundaries } from '../architecture-domain-boundaries.mjs';

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeSource = async (filePath, source) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source);
};

const makeWorkspace = async ({ sources }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-domain-boundaries-'));

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
    boundaryExceptions: [],
    domains: [
      {
        id: 'applications',
        mayDependOn: ['workspace-experience', 'data-platform', 'shared-foundation'],
        owner: 'platform',
        packages: ['@brainstrike/web'],
        title: 'Applications',
      },
      {
        id: 'workspace-experience',
        mayDependOn: ['data-platform', 'shared-foundation'],
        owner: 'workspace',
        packages: ['@brainstrike/app-shell'],
        title: 'Workspace',
      },
      {
        id: 'data-platform',
        mayDependOn: ['shared-foundation'],
        owner: 'data',
        packages: ['@brainstrike/db'],
        title: 'Data',
      },
      {
        id: 'shared-foundation',
        mayDependOn: [],
        owner: 'foundation',
        packages: ['@brainstrike/ui', '@brainstrike/utils'],
        title: 'Shared',
      },
    ],
    stack: [],
    version: 1,
  });

  for (const [relativePath, source] of sources) {
    await writeSource(path.join(root, relativePath), source);
  }

  return root;
};

test('accepts same-domain and explicitly allowed lower-domain imports', async () => {
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
  });

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(result.violations, []);
  assert.equal(result.summary.checkedImportCount, 4);
});

test('rejects imports from lower-level domains into higher-level domains', async () => {
  const root = await makeWorkspace({
    sources: [
      [
        'packages/db/src/store.ts',
        "import { Shell } from '@brainstrike/app-shell';\nimport type { WebApp } from '@brainstrike/web';\n",
      ],
    ],
  });

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(
    result.violations.map((violation) => violation.message),
    [
      '@brainstrike/db (data-platform) must not import @brainstrike/app-shell (workspace-experience)',
      '@brainstrike/db (data-platform) must not import @brainstrike/web (applications)',
    ]
  );
});

test('recognizes subpath imports, dynamic imports, require calls, import-equals, and import types', async () => {
  const root = await makeWorkspace({
    sources: [
      [
        'packages/ui/src/component.ts',
        "type Shell = import('@brainstrike/app-shell/panel').Shell;\nconst data = import('@brainstrike/db/client');\nconst shell = require('@brainstrike/app-shell');\nimport legacyWeb = require('@brainstrike/web/legacy');\nvoid data;\nvoid shell;\nvoid legacyWeb;\n",
      ],
    ],
  });

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(
    result.violations.map((violation) => violation.importedPackage),
    ['@brainstrike/app-shell', '@brainstrike/db', '@brainstrike/app-shell', '@brainstrike/web']
  );
});

test('sorts violations numerically within each file', async () => {
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
  });

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(
    result.violations.map((violation) => violation.line),
    [1, 10, 13]
  );
});

test('reports stale approved boundary exceptions', async () => {
  const root = await makeWorkspace({
    sources: [['packages/ui/src/component.ts', "export const value = 'safe';\n"]],
  });
  const contractPath = path.join(root, 'architecture/domain-map.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  await writeFile(path.join(root, 'phase-test.html'), '<!doctype html><title>Phase test</title>\n');
  contract.stack = [
    {
      dependsOn: null,
      id: 'phase-test',
      planningArtifact: 'phase-test.html',
    },
  ];
  contract.boundaryExceptions = [
    {
      id: 'stale-ui-db',
      importedPackage: '@brainstrike/db',
      reason: 'Test fixture stale exception.',
      retireByPhase: 'phase-test',
      sourcePackage: '@brainstrike/ui',
    },
  ];
  await writeJson(contractPath, contract);

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(result.staleBoundaryExceptions, [
    {
      importedPackage: '@brainstrike/db',
      message: 'approved boundary exception is stale: @brainstrike/ui -> @brainstrike/db',
      sourcePackage: '@brainstrike/ui',
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
