import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

  assert.deepEqual(result.violations.map((violation) => violation.message), [
    '@brainstrike/db (data-platform) must not import @brainstrike/app-shell (workspace-experience)',
    '@brainstrike/db (data-platform) must not import @brainstrike/web (applications)',
  ]);
});

test('recognizes subpath imports, dynamic imports, require calls, and import types', async () => {
  const root = await makeWorkspace({
    sources: [
      [
        'packages/ui/src/component.ts',
        "type Shell = import('@brainstrike/app-shell/panel').Shell;\nconst data = import('@brainstrike/db/client');\nconst shell = require('@brainstrike/app-shell');\nvoid data;\nvoid shell;\n",
      ],
    ],
  });

  const result = await validateArchitectureDomainBoundaries({ root });

  assert.deepEqual(result.violations.map((violation) => violation.importedPackage), [
    '@brainstrike/app-shell',
    '@brainstrike/db',
    '@brainstrike/app-shell',
  ]);
});

test('keeps the committed Brainstrike workspace inside the declared domain boundaries', async () => {
  const result = await validateArchitectureDomainBoundaries({ root: process.cwd() });

  assert.deepEqual(result.violations, []);
  assert.ok(result.summary.checkedFileCount > 0);
  assert.ok(result.summary.checkedImportCount > 0);
});
