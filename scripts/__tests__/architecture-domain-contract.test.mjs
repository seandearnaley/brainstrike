import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadArchitectureDomainContract,
  validateArchitectureDomainContract,
} from '../architecture-domain-contract.mjs';

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const makeWorkspace = async ({ packageNames, contract, writePlanningArtifacts = true }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-domain-contract-'));

  for (const packageName of packageNames) {
    const [, shortName] = packageName.split('/');
    const workspaceDir = packageName === '@brainstrike/web' ? 'apps/web' : `packages/${shortName}`;
    await writeJson(path.join(root, workspaceDir, 'package.json'), {
      name: packageName,
      version: '0.0.0',
    });
  }

  await writeJson(path.join(root, 'architecture/domain-map.json'), contract);

  if (writePlanningArtifacts) {
    for (const phase of contract.stack ?? []) {
      if (typeof phase.planningArtifact === 'string') {
        await mkdir(path.dirname(path.join(root, phase.planningArtifact)), { recursive: true });
        await writeFile(
          path.join(root, phase.planningArtifact),
          '<!doctype html><title>Plan</title>\n'
        );
      }
    }
  }

  return root;
};

test('validates a contract that classifies every workspace package exactly once', async () => {
  const root = await makeWorkspace({
    contract: {
      domains: [
        {
          id: 'applications',
          mayDependOn: ['workspace-core'],
          owner: 'platform',
          packages: ['@brainstrike/web'],
          title: 'Applications',
        },
        {
          id: 'workspace-core',
          mayDependOn: [],
          owner: 'workspace',
          packages: ['@brainstrike/types', '@brainstrike/utils'],
          title: 'Workspace core',
        },
      ],
      stack: [
        {
          branch: 'codex/domain-reset-phase-0-contract',
          dependsOn: null,
          id: 'phase-0',
          planningArtifact: 'docs/architecture-reset/phase-0-domain-contract-plan-2026-05-19.html',
          title: 'Domain contract',
        },
      ],
      version: 1,
    },
    packageNames: ['@brainstrike/web', '@brainstrike/types', '@brainstrike/utils'],
  });

  const contract = await loadArchitectureDomainContract({ root });
  const result = await validateArchitectureDomainContract({ contract, root });

  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.workspaceCount, 3);
  assert.equal(result.summary.domainCount, 2);
  assert.equal(result.summary.stackPhaseCount, 1);
});

test('rejects unclassified workspace packages', async () => {
  const root = await makeWorkspace({
    contract: {
      domains: [
        {
          id: 'applications',
          mayDependOn: [],
          owner: 'platform',
          packages: ['@brainstrike/web'],
          title: 'Applications',
        },
      ],
      stack: [],
      version: 1,
    },
    packageNames: ['@brainstrike/web', '@brainstrike/types'],
  });

  const contract = await loadArchitectureDomainContract({ root });
  const result = await validateArchitectureDomainContract({ contract, root });

  assert.deepEqual(result.errors, [
    'Workspace package @brainstrike/types is not classified in architecture/domain-map.json',
  ]);
});

test('rejects duplicate package classification and unknown dependency domains', async () => {
  const root = await makeWorkspace({
    contract: {
      domains: [
        {
          id: 'applications',
          mayDependOn: ['missing-domain'],
          owner: 'platform',
          packages: ['@brainstrike/web', '@brainstrike/types'],
          title: 'Applications',
        },
        {
          id: 'shared',
          mayDependOn: [],
          owner: 'platform',
          packages: ['@brainstrike/types'],
          title: 'Shared',
        },
      ],
      stack: [],
      version: 1,
    },
    packageNames: ['@brainstrike/web', '@brainstrike/types'],
  });

  const contract = await loadArchitectureDomainContract({ root });
  const result = await validateArchitectureDomainContract({ contract, root });

  assert.deepEqual(result.errors, [
    'Domain applications mayDependOn unknown domain missing-domain',
    'Workspace package @brainstrike/types is classified more than once',
  ]);
});

test('rejects non-linear stack dependencies and missing HTML planning artifacts', async () => {
  const root = await makeWorkspace({
    contract: {
      domains: [
        {
          id: 'applications',
          mayDependOn: [],
          owner: 'platform',
          packages: ['@brainstrike/web'],
          title: 'Applications',
        },
      ],
      stack: [
        {
          branch: 'codex/domain-reset-phase-0-contract',
          dependsOn: 'phase-9',
          id: 'phase-0',
          planningArtifact: 'docs/architecture-reset/missing.html',
          title: 'Domain contract',
        },
      ],
      version: 1,
    },
    packageNames: ['@brainstrike/web'],
    writePlanningArtifacts: false,
  });

  const contract = await loadArchitectureDomainContract({ root });
  const result = await validateArchitectureDomainContract({ contract, root });

  assert.deepEqual(result.errors, [
    'Stack phase phase-0 dependsOn phase-9, but the previous phase is null',
    'Stack phase phase-0 planningArtifact docs/architecture-reset/missing.html does not exist',
  ]);
});
