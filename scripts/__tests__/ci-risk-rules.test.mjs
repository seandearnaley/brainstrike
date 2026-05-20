import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  expandRiskLanes,
  selectRiskProfileForFiles,
  selectRiskLanesForFiles,
  toRiskLabels,
} from '../ci-risk-rules.mjs';

test('docs-only changes select no cloud risk lanes', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['apps/docs/docs/development/local-ci.md']),
    []
  );
});

test('docs-only changes select a docs-only local proof profile without expensive e2e lanes', () => {
  assert.deepEqual(selectRiskProfileForFiles(['docs/architecture-reset/report.html']), {
    category: 'docs-only',
    domains: ['documentation'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'docs-static'],
    riskLevel: 'low',
    cloudLabels: [],
  });
});

test('config and tooling changes select script contract proof without full e2e by default', () => {
  assert.deepEqual(selectRiskProfileForFiles(['scripts/ci-select.mjs']), {
    category: 'config-tooling',
    domains: ['tooling'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'ci-script-tests', 'workflow-contracts'],
    riskLevel: 'medium',
    cloudLabels: ['ci:coverage'],
  });
});

test('assistant contract changes select assistant proof and avoid embedding diagnostics', () => {
  assert.deepEqual(
    selectRiskProfileForFiles(['packages/assistant-contract/src/runtime-data.ts']),
    {
      category: 'assistant-contract-runtime',
      domains: ['assistant'],
      e2eLanes: ['critical-smoke'],
      proofCommands: ['diff-check', 'assistant-contract-tests', 'app-shell-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-e2e', 'ci:coverage'],
    }
  );
});

test('embedding runtime changes select embedding diagnostics explicitly', () => {
  assert.deepEqual(
    selectRiskProfileForFiles(['packages/embeddings/src/worker/embedding-worker.ts']),
    {
      category: 'indexing-import-embedding',
      domains: ['indexing'],
      e2eLanes: ['desktop-embedding-diagnostics'],
      proofCommands: ['diff-check', 'indexing-tests', 'embedding-tests'],
      riskLevel: 'high',
      cloudLabels: ['ci:desktop', 'ci:embedding', 'ci:coverage'],
    }
  );
});

test('db migrations select db proof without full web functional e2e', () => {
  assert.deepEqual(
    selectRiskProfileForFiles(['packages/db/src/migrations/012-add-index.sql.ts']),
    {
      category: 'db-migrations-storage',
      domains: ['data-platform'],
      e2eLanes: ['destructive-reset'],
      proofCommands: ['diff-check', 'db-schema-migration-tests', 'db-integration-tests'],
      riskLevel: 'high',
      cloudLabels: ['ci:browser', 'ci:coverage'],
    }
  );
});

test('db queue changes select only the queue owner lane', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/db/src/queue/job-queue.ts']), {
    category: 'db-migrations-storage',
    domains: ['data-platform'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'db-queue-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:coverage'],
  });
});

test('db repository changes select only the repository owner lane', () => {
  assert.deepEqual(
    selectRiskProfileForFiles(['packages/db/src/repositories/drizzle/file-record-repository.ts']),
    {
      category: 'db-migrations-storage',
      domains: ['data-platform'],
      e2eLanes: [],
      proofCommands: ['diff-check', 'db-repository-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:browser', 'ci:coverage'],
    }
  );
});

test('db search changes select only the search owner lane', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/db/src/search/hybrid-search-service.ts']), {
    category: 'db-migrations-storage',
    domains: ['data-platform'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'db-search-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:coverage'],
  });
});

test('db broad entrypoint changes select all focused db owner lanes without full e2e', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/db/src/index.ts']), {
    category: 'db-migrations-storage',
    domains: ['data-platform'],
    e2eLanes: [],
    proofCommands: [
      'diff-check',
      'db-schema-migration-tests',
      'db-repository-tests',
      'db-queue-tests',
      'db-search-tests',
      'db-integration-tests',
    ],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:coverage'],
  });
});

test('web file explorer changes select web stateful proof but not desktop embedding diagnostics', () => {
  assert.deepEqual(
    selectRiskProfileForFiles(['packages/file-explorer-ui/src/tree/optimized-file-tree.tsx']),
    {
      category: 'web-ui-file-explorer',
      domains: ['workspace-experience'],
      e2eLanes: ['web-functional-stateful'],
      proofCommands: ['diff-check', 'file-explorer-tests', 'web-smoke-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-e2e', 'ci:coverage'],
    }
  );
});

test('desktop preload changes select desktop smoke and regression without embedding diagnostics', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/preload.ts']), {
    category: 'desktop-platform-ipc-preload',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-smoke-regression'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-smoke-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop', 'ci:coverage'],
  });
});

test('release workflow changes select full release proof explicitly', () => {
  assert.deepEqual(selectRiskProfileForFiles(['.github/workflows/test.yml']), {
    category: 'full-release-high-risk',
    domains: ['ci-platform'],
    e2eLanes: [
      'critical-smoke',
      'web-functional-stateful',
      'desktop-smoke-regression',
      'desktop-embedding-diagnostics',
      'desktop-llm-host-recovery',
      'destructive-reset',
      'long-soak-release-only',
    ],
    proofCommands: ['diff-check', 'ci-script-tests', 'workflow-contracts', 'full-local-suite'],
    riskLevel: 'full',
    cloudLabels: ['ci:full'],
  });
});

test('isolated unit-test-only changes avoid product e2e lanes', () => {
  assert.deepEqual(
    selectRiskProfileForFiles([
      'packages/utils/src/__tests__/token-counting-boundary.test.ts',
      'apps/web/src/app/root-layout-content.test.tsx',
    ]),
    {
      category: 'isolated-unit-test-only',
      domains: ['test-only'],
      e2eLanes: [],
      proofCommands: ['diff-check', 'changed-unit-tests'],
      riskLevel: 'low',
      cloudLabels: ['ci:coverage'],
    }
  );
});

test('e2e test-only changes stay in their product lane', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/layout-persistence.test.ts']), {
    category: 'web-ui-file-explorer',
    domains: ['workspace-experience'],
    e2eLanes: ['web-functional-stateful'],
    proofCommands: ['diff-check', 'file-explorer-tests', 'web-smoke-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-e2e', 'ci:coverage'],
  });
});

test('workflow and CI script changes select the full lane', () => {
  assert.deepEqual(
    selectRiskLanesForFiles([
      '.github/workflows/test.yml',
      'scripts/check-ci-workflow-contracts.mjs',
    ]),
    ['ci:full']
  );
  assert.deepEqual(expandRiskLanes(['ci:full']), [
    'ci:browser',
    'ci:web-e2e',
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
});

test('browser storage changes select browser and coverage lanes without full db tests', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/storage/src/opfs.ts']), {
    category: 'db-migrations-storage',
    domains: ['data-platform'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'storage-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['packages/storage/src/opfs.ts']), [
    'ci:browser',
    'ci:coverage',
  ]);
});

test('file-system changes select file-system tests without full db tests', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/file-system/src/utils.ts']), {
    category: 'db-migrations-storage',
    domains: ['data-platform'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'file-system-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:coverage'],
  });
});

test('desktop host changes select desktop and embedding lanes', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['apps/desktop/src/embedding-host-manager.ts']),
    ['ci:desktop', 'ci:embedding', 'ci:coverage']
  );
});

test('desktop llm host changes select llm recovery without embedding lanes', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/llm-host-manager.ts']), {
    category: 'desktop-platform-ipc-preload',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-smoke-regression', 'desktop-llm-host-recovery'],
    proofCommands: [
      'diff-check',
      'desktop-unit-tests',
      'desktop-smoke-tests',
      'desktop-llm-host-smoke',
    ],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/llm-host-manager.ts']), [
    'ci:desktop',
    'ci:coverage',
  ]);
});

test('web app changes select web e2e and coverage lanes', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/src/App.tsx']), [
    'ci:web-e2e',
    'ci:coverage',
  ]);
});

test('new runtime app changes fall back to coverage', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/new-app/src/index.ts']), [
    'ci:coverage',
  ]);
});

test('risk labels match lane names', () => {
  assert.deepEqual(toRiskLabels(['ci:browser', 'ci:desktop']), [
    'ci:browser',
    'ci:desktop',
  ]);
});
