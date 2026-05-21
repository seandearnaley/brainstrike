import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  expandRiskLanes,
  selectProofCommandsForFiles,
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

test('assistant contract changes select assistant proof and assistant-state lane', () => {
  assert.deepEqual(
    selectRiskProfileForFiles(['packages/assistant-contract/src/runtime-data.ts']),
    {
      category: 'assistant-contract-runtime',
      domains: ['assistant'],
      e2eLanes: ['web-assistant-state'],
      proofCommands: ['diff-check', 'assistant-contract-tests', 'app-shell-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-assistant-state', 'ci:coverage'],
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
      e2eLanes: ['web-db-startup', 'web-destructive-reset'],
      proofCommands: [
        'diff-check',
        'db-schema-migration-tests',
        'db-integration-tests',
        'web-db-startup-tests',
        'web-destructive-reset-tests',
      ],
      riskLevel: 'high',
      cloudLabels: ['ci:web-db-startup', 'ci:web-destructive-reset', 'ci:browser', 'ci:coverage'],
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
      e2eLanes: ['web-file-explorer-persistence'],
      proofCommands: [
        'diff-check',
        'file-explorer-tests',
        'web-file-explorer-persistence-tests',
      ],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-file-explorer-persistence', 'ci:coverage'],
    }
  );
});

test('web file explorer changes do not select unrelated product lanes', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['packages/file-explorer-ui/src/tree/optimized-file-tree.tsx']),
    ['ci:web-file-explorer-persistence', 'ci:coverage']
  );
});

test('web import UI changes select import/indexing without full web regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/database-import-backfill.test.ts']), {
    category: 'web-import-indexing',
    domains: ['workspace-experience', 'indexing'],
    e2eLanes: ['web-import-indexing'],
    proofCommands: ['diff-check', 'indexing-tests', 'web-import-indexing-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-import-indexing', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/e2e/database-import-backfill.test.ts']), [
    'ci:web-import-indexing',
    'ci:coverage',
  ]);
});

test('web assistant UI changes select assistant-state only plus coverage', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx']), {
    category: 'assistant-contract-runtime',
    domains: ['assistant'],
    e2eLanes: ['web-assistant-state'],
    proofCommands: ['diff-check', 'assistant-contract-tests', 'app-shell-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-assistant-state', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx']), [
    'ci:web-assistant-state',
    'ci:coverage',
  ]);
});

test('web assistant app-shell changes do not fall through to full web e2e', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['packages/app-shell/src/assistant-ui-panel-wrapper.tsx']),
    ['ci:web-assistant-state', 'ci:coverage']
  );
});

test('web settings persistence changes select settings-state only', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/settings-models-and-providers.test.ts']), {
    category: 'web-settings-state',
    domains: ['applications'],
    e2eLanes: ['web-settings-state'],
    proofCommands: ['diff-check', 'web-settings-state-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-settings-state', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/e2e/settings-models-and-providers.test.ts']), [
    'ci:web-settings-state',
    'ci:coverage',
  ]);
});

test('web db startup changes select db-startup without full web regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/web-db-worker-startup.test.ts']), {
    category: 'web-db-startup',
    domains: ['applications', 'data-platform'],
    e2eLanes: ['web-db-startup'],
    proofCommands: ['diff-check', 'web-db-startup-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-db-startup', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/e2e/web-db-worker-startup.test.ts']), [
    'ci:web-db-startup',
    'ci:coverage',
  ]);
});

test('web destructive reset changes select destructive reset only', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/factory-reset-recovery.test.ts']), {
    category: 'web-destructive-reset',
    domains: ['applications', 'data-platform'],
    e2eLanes: ['web-destructive-reset'],
    proofCommands: ['diff-check', 'web-destructive-reset-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:web-destructive-reset', 'ci:coverage'],
  });
});

test('broad web app shell changes still select full web regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/src/App.tsx']), {
    category: 'web-full-regression',
    domains: ['applications'],
    e2eLanes: ['web-full-regression'],
    proofCommands: ['diff-check', 'web-full-regression-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:web-e2e', 'ci:coverage'],
  });
});

test('desktop preload changes select desktop smoke and regression without embedding diagnostics', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/preload.ts']), {
    category: 'desktop-platform-ipc-preload',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-full-regression'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-full-regression-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop', 'ci:coverage'],
  });
});

test('desktop factory reset changes select reset lane without full desktop regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/desktop-factory-reset.ts']), {
    category: 'desktop-ipc-reset',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-ipc-reset'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-ipc-reset-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:desktop-ipc-reset', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/desktop-factory-reset.ts']), [
    'ci:desktop-ipc-reset',
    'ci:coverage',
  ]);
});

test('desktop db IPC changes select db storage lane without embedding diagnostics', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/ipc-domains/db-ipc.ts']), {
    category: 'desktop-db-storage',
    domains: ['desktop-platform', 'data-platform'],
    e2eLanes: ['desktop-db-storage'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-db-storage-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:desktop-db-storage', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/ipc-domains/db-ipc.ts']), [
    'ci:desktop-db-storage',
    'ci:coverage',
  ]);
});

test('desktop hidden host lifecycle changes select runtime host lane only', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/embedding-host-manager.ts']), {
    category: 'desktop-runtime-hosts',
    domains: ['desktop-platform', 'indexing'],
    e2eLanes: ['desktop-runtime-hosts'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-runtime-host-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop-runtime-hosts', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/embedding-host-manager.ts']), [
    'ci:desktop-runtime-hosts',
    'ci:coverage',
  ]);
});

test('desktop main process changes still select full desktop regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/main.ts']), {
    category: 'desktop-platform-ipc-preload',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-full-regression'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-full-regression-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/main.ts']), [
    'ci:desktop',
    'ci:coverage',
  ]);
});

test('release workflow changes select full release proof explicitly', () => {
  assert.deepEqual(selectRiskProfileForFiles(['.github/workflows/test.yml']), {
    category: 'full-release-high-risk',
    domains: ['ci-platform'],
    e2eLanes: [
      'critical-smoke',
      'web-smoke',
      'web-file-explorer-persistence',
      'web-import-indexing',
      'web-assistant-state',
      'web-settings-state',
      'web-db-startup',
      'web-destructive-reset',
      'web-full-regression',
      'desktop-smoke',
      'desktop-ipc-reset',
      'desktop-runtime-hosts',
      'desktop-db-storage',
      'desktop-full-regression',
      'desktop-embedding-diagnostics',
      'desktop-llm-host-recovery',
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
    category: 'web-full-regression',
    domains: ['applications'],
    e2eLanes: ['web-full-regression'],
    proofCommands: ['diff-check', 'web-full-regression-tests'],
    riskLevel: 'high',
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
    'ci:web-smoke',
    'ci:web-file-explorer-persistence',
    'ci:web-import-indexing',
    'ci:web-assistant-state',
    'ci:web-settings-state',
    'ci:web-db-startup',
    'ci:web-destructive-reset',
    'ci:web-e2e',
    'ci:desktop-smoke',
    'ci:desktop-ipc-reset',
    'ci:desktop-runtime-hosts',
    'ci:desktop-db-storage',
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

test('legacy desktop host selector does not route host lifecycle through embedding diagnostics', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['apps/desktop/src/embedding-host-manager.ts']),
    ['ci:desktop-runtime-hosts', 'ci:coverage']
  );
});

test('desktop runtime host selector avoids broad incidental host filenames', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/toast-host.ts']), [
    'ci:coverage',
  ]);
});

test('multi-lane desktop changes union local proof commands', () => {
  assert.deepEqual(
    selectProofCommandsForFiles([
      'apps/desktop/src/desktop-factory-reset.ts',
      'apps/desktop/src/embedding-host-manager.ts',
    ]),
    [
      'diff-check',
      'desktop-unit-tests',
      'desktop-ipc-reset-tests',
      'desktop-runtime-host-tests',
    ]
  );
});

test('desktop llm host changes select llm recovery without embedding lanes', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/llm-host-manager.ts']), {
    category: 'desktop-runtime-hosts',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-runtime-hosts'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-runtime-host-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop-runtime-hosts', 'ci:coverage'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/llm-host-manager.ts']), [
    'ci:desktop-runtime-hosts',
    'ci:coverage',
  ]);
});

test('web app changes select full web e2e and coverage lanes', () => {
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
