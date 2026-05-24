import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  E2E_PROOF_COMMAND_LABELS,
  expandRiskLanes,
  selectProofCommandsForFiles,
  selectRiskProfileForFiles,
  selectRiskLanesForFiles,
  toRiskLabels,
} from '../ci-risk-rules.mjs';
import riskFixtures from '../ci-risk-fixtures.json' with { type: 'json' };

test('fixture profiles, labels, and proof commands cannot drift apart', () => {
  for (const fixture of riskFixtures.cases) {
    const profile = selectRiskProfileForFiles(fixture.files);
    const lanes = selectRiskLanesForFiles(fixture.files);
    const proofCommands = selectProofCommandsForFiles(fixture.files);

    assert.deepEqual(lanes, profile.cloudLabels, `${fixture.name}: profile/lanes disagree`);
    for (const commandName of proofCommands) {
      const requiredLabel = E2E_PROOF_COMMAND_LABELS.get(commandName);
      if (!requiredLabel) {
        continue;
      }
      assert.ok(
        lanes.includes(requiredLabel) || lanes.includes('ci:full'),
        `${fixture.name}: ${commandName} requires ${requiredLabel}, got ${lanes.join(',') || '<none>'}`
      );
    }
  }
});

test('docs-only changes select no cloud risk lanes', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['apps/docs/docs/development/local-ci.md']),
    []
  );
});

test('docs-only package READMEs do not select package runtime lanes', () => {
  const files = [
    'AGENTS.md',
    'README.md',
    'apps/desktop/README.md',
    'apps/web/README.md',
    'packages/agent/README.md',
    'packages/app-shell/README.md',
  ];

  assert.deepEqual(selectRiskProfileForFiles(files), {
    category: 'docs-only',
    domains: ['documentation'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'docs-static'],
    riskLevel: 'low',
    cloudLabels: [],
  });
  assert.deepEqual(selectRiskLanesForFiles(files), []);
  assert.deepEqual(selectProofCommandsForFiles(files), ['diff-check', 'docs-static']);
  assert.deepEqual(toRiskLabels(selectRiskLanesForFiles(files)), []);
});

test('documentation files do not escalate mixed tooling changes into runtime lanes', () => {
  const files = [
    'AGENTS.md',
    'README.md',
    'packages/agent/README.md',
    'packages/app-shell/README.md',
    'scripts/ci-risk-rules.mjs',
    'scripts/__tests__/ci-risk-rules.test.mjs',
  ];

  assert.deepEqual(selectRiskProfileForFiles(files), {
    category: 'config-tooling',
    domains: ['tooling'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'ci-script-tests', 'workflow-contracts'],
    riskLevel: 'medium',
    cloudLabels: ['ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(files), ['ci:unit']);
  assert.deepEqual(selectProofCommandsForFiles(files), [
    'diff-check',
    'ci-script-tests',
    'workflow-contracts',
  ]);
});

test('proof artifact does not escalate docs-only changes', () => {
  const files = [
    '.ci/proof/latest.json',
    'docs/architecture-reset/selector-smoke-docs-only.md',
  ];

  assert.deepEqual(selectRiskProfileForFiles(files), {
    category: 'docs-only',
    domains: ['documentation'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'docs-static'],
    riskLevel: 'low',
    cloudLabels: [],
  });
  assert.deepEqual(selectRiskLanesForFiles(files), []);
});

test('proof artifact does not escalate isolated unit-test-only changes', () => {
  const files = [
    '.ci/proof/latest.json',
    'packages/utils/src/__tests__/token-counting-boundary.test.ts',
  ];

  assert.deepEqual(selectRiskProfileForFiles(files), {
    category: 'isolated-unit-test-only',
    domains: ['test-only'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'changed-unit-tests'],
    riskLevel: 'low',
    cloudLabels: ['ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(files), ['ci:unit']);
  assert.deepEqual(selectProofCommandsForFiles(files), [
    'diff-check',
    'changed-unit-tests',
  ]);
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
    cloudLabels: ['ci:unit'],
  });
});

test('root package script changes select tooling proof without full release proof', () => {
  assert.deepEqual(selectRiskProfileForFiles(['package.json']), {
    category: 'config-tooling',
    domains: ['tooling'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'ci-script-tests', 'workflow-contracts'],
    riskLevel: 'medium',
    cloudLabels: ['ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['package.json']), ['ci:unit']);
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
      cloudLabels: ['ci:web-assistant-state', 'ci:unit'],
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
      cloudLabels: ['ci:embedding', 'ci:unit'],
    }
  );
  assert.deepEqual(
    selectRiskLanesForFiles(['packages/embeddings/src/worker/embedding-worker.ts']),
    ['ci:embedding', 'ci:unit']
  );
  assert.deepEqual(
    selectProofCommandsForFiles(['packages/embeddings/src/worker/embedding-worker.ts']),
    ['diff-check', 'indexing-tests', 'embedding-tests']
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
      cloudLabels: [
        'ci:browser',
        'ci:web-db-startup',
        'ci:web-destructive-reset',
        'ci:unit',
        'ci:coverage-db',
      ],
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
    cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
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
      cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
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
    cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
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
    cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
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
      cloudLabels: ['ci:web-file-explorer-persistence', 'ci:unit'],
    }
  );
});

test('web file explorer changes do not select unrelated product lanes', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['packages/file-explorer-ui/src/tree/optimized-file-tree.tsx']),
    ['ci:web-file-explorer-persistence', 'ci:unit']
  );
});

test('web import UI changes select import/indexing without full web regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/database-import-backfill.test.ts']), {
    category: 'web-import-indexing',
    domains: ['workspace-experience', 'indexing'],
    e2eLanes: ['web-import-indexing'],
    proofCommands: ['diff-check', 'indexing-tests', 'web-import-indexing-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-import-indexing', 'ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/e2e/database-import-backfill.test.ts']), [
    'ci:web-import-indexing',
    'ci:unit',
  ]);
});

test('web assistant UI changes select assistant-state only plus coverage', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx']), {
    category: 'assistant-contract-runtime',
    domains: ['assistant'],
    e2eLanes: ['web-assistant-state'],
    proofCommands: ['diff-check', 'assistant-contract-tests', 'app-shell-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-assistant-state', 'ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx']), [
    'ci:web-assistant-state',
    'ci:unit',
  ]);
});

test('web assistant app-shell changes do not fall through to full web e2e', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['packages/app-shell/src/assistant-ui-panel-wrapper.tsx']),
    ['ci:web-assistant-state', 'ci:unit']
  );
});

test('web settings persistence changes select settings-state only', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/settings-models-and-providers.test.ts']), {
    category: 'web-settings-state',
    domains: ['applications'],
    e2eLanes: ['web-settings-state'],
    proofCommands: ['diff-check', 'web-settings-state-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-settings-state', 'ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/e2e/settings-models-and-providers.test.ts']), [
    'ci:web-settings-state',
    'ci:unit',
  ]);
});

test('web db startup changes select db-startup without full web regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/web-db-worker-startup.test.ts']), {
    category: 'web-db-startup',
    domains: ['applications', 'data-platform'],
    e2eLanes: ['web-db-startup'],
    proofCommands: ['diff-check', 'web-db-startup-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:web-db-startup', 'ci:unit', 'ci:coverage-db'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/e2e/web-db-worker-startup.test.ts']), [
    'ci:web-db-startup',
    'ci:unit',
    'ci:coverage-db',
  ]);
});

test('web destructive reset changes select destructive reset only', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/e2e/factory-reset-recovery.test.ts']), {
    category: 'web-destructive-reset',
    domains: ['applications', 'data-platform'],
    e2eLanes: ['web-destructive-reset'],
    proofCommands: ['diff-check', 'web-destructive-reset-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:web-destructive-reset', 'ci:unit', 'ci:coverage-db'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/e2e/factory-reset-recovery.test.ts']), [
    'ci:web-destructive-reset',
    'ci:unit',
    'ci:coverage-db',
  ]);
});

test('broad web app shell changes still select full web regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/web/src/App.tsx']), {
    category: 'web-full-regression',
    domains: ['applications'],
    e2eLanes: ['web-full-regression'],
    proofCommands: ['diff-check', 'web-full-regression-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:web-e2e', 'ci:unit'],
  });
});

test('generic shared UI changes select browser and unit without full web e2e', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/ui/src/prompt-management/components/prompt-card.tsx']), {
    category: 'shared-foundation',
    domains: ['shared-foundation'],
    e2eLanes: ['critical-smoke'],
    proofCommands: ['diff-check', 'ui-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:unit'],
  });
  assert.deepEqual(
    selectRiskLanesForFiles(['packages/ui/src/prompt-management/components/prompt-card.tsx']),
    ['ci:browser', 'ci:unit']
  );
  assert.deepEqual(
    selectProofCommandsForFiles(['packages/ui/src/prompt-management/components/prompt-card.tsx']),
    ['diff-check', 'ui-tests']
  );
});

test('mixed palette tooltip and destructive reset PR does not hide full web regression in narrow proof', () => {
  const files = [
    '.jules/palette.md',
    'apps/web/e2e/factory-reset-recovery.test.ts',
    'packages/preferences/src/components/global-download-indicator.tsx',
    'packages/preferences/src/settings/models/__tests__/model-registry-settings-section.test.tsx',
    'packages/preferences/src/settings/models/model-registry-settings-section.tsx',
    'packages/ui/src/collection-picker/__tests__/collection-picker.test.tsx',
    'packages/ui/src/prompt-management/components/__tests__/prompt-card.test.tsx',
    'packages/ui/src/prompt-management/components/prompt-card.tsx',
    'packages/ui/src/prompt-management/components/prompt-list.tsx',
  ];

  assert.deepEqual(selectRiskLanesForFiles(files), [
    'ci:web-destructive-reset',
    'ci:unit',
    'ci:coverage-db',
  ]);
  assert.deepEqual(selectProofCommandsForFiles(files), [
    'diff-check',
    'web-destructive-reset-tests',
    'ui-tests',
  ]);
});

test('mixed broad web bootstrap and narrow reset still escalates to full web regression', () => {
  assert.deepEqual(
    selectRiskLanesForFiles([
      'apps/web/e2e/factory-reset-recovery.test.ts',
      'apps/web/src/App.tsx',
    ]),
    ['ci:web-destructive-reset', 'ci:web-e2e', 'ci:unit', 'ci:coverage-db']
  );
  assert.deepEqual(
    selectProofCommandsForFiles([
      'apps/web/e2e/factory-reset-recovery.test.ts',
      'apps/web/src/App.tsx',
    ]),
    ['diff-check', 'web-destructive-reset-tests', 'web-full-regression-tests']
  );
});

test('desktop preload changes select desktop smoke and regression without embedding diagnostics', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/preload.ts']), {
    category: 'desktop-platform-ipc-preload',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-full-regression'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-full-regression-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop', 'ci:unit'],
  });
});

test('desktop factory reset changes select reset lane without full desktop regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/desktop-factory-reset.ts']), {
    category: 'desktop-ipc-reset',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-ipc-reset'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-ipc-reset-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:desktop-ipc-reset', 'ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/desktop-factory-reset.ts']), [
    'ci:desktop-ipc-reset',
    'ci:unit',
  ]);
});

test('desktop db IPC changes select db storage lane without embedding diagnostics', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/ipc-domains/db-ipc.ts']), {
    category: 'desktop-db-storage',
    domains: ['desktop-platform', 'data-platform'],
    e2eLanes: ['desktop-db-storage'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-db-storage-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:desktop-db-storage', 'ci:unit', 'ci:coverage-db'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/ipc-domains/db-ipc.ts']), [
    'ci:desktop-db-storage',
    'ci:unit',
    'ci:coverage-db',
  ]);
});

test('desktop hidden host lifecycle changes select runtime host lane only', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/embedding-host-manager.ts']), {
    category: 'desktop-runtime-hosts',
    domains: ['desktop-platform', 'indexing'],
    e2eLanes: ['desktop-runtime-hosts'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-runtime-host-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop-runtime-hosts', 'ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/embedding-host-manager.ts']), [
    'ci:desktop-runtime-hosts',
    'ci:unit',
  ]);
});

test('desktop main process changes still select full desktop regression', () => {
  assert.deepEqual(selectRiskProfileForFiles(['apps/desktop/src/main.ts']), {
    category: 'desktop-platform-ipc-preload',
    domains: ['desktop-platform'],
    e2eLanes: ['desktop-full-regression'],
    proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-full-regression-tests'],
    riskLevel: 'high',
    cloudLabels: ['ci:desktop', 'ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/main.ts']), [
    'ci:desktop',
    'ci:unit',
  ]);
});

test('test workflow changes select CI contract proof without product release lanes', () => {
  assert.deepEqual(selectRiskProfileForFiles(['.github/workflows/test.yml']), {
    category: 'config-tooling',
    domains: ['tooling'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'ci-script-tests', 'workflow-contracts'],
    riskLevel: 'medium',
    cloudLabels: ['ci:unit'],
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
      cloudLabels: ['ci:unit'],
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
    cloudLabels: ['ci:web-e2e', 'ci:unit'],
  });
});

test('test workflow and CI script changes select tooling lanes without full product matrix', () => {
  assert.deepEqual(
    selectRiskLanesForFiles([
      '.github/workflows/test.yml',
      'scripts/check-ci-workflow-contracts.mjs',
    ]),
    ['ci:unit']
  );
  assert.deepEqual(expandRiskLanes(['ci:unit']), ['ci:unit']);
});

test('browser storage changes select browser and coverage lanes without full db tests', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/storage/src/opfs.ts']), {
    category: 'db-migrations-storage',
    domains: ['data-platform'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'storage-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['packages/storage/src/opfs.ts']), [
    'ci:browser',
    'ci:unit',
    'ci:coverage-db',
  ]);
});

test('file-system changes select file-system tests without full db tests', () => {
  assert.deepEqual(selectRiskProfileForFiles(['packages/file-system/src/utils.ts']), {
    category: 'db-migrations-storage',
    domains: ['data-platform'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'file-system-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
  });
});

test('legacy desktop host selector does not route host lifecycle through embedding diagnostics', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['apps/desktop/src/embedding-host-manager.ts']),
    ['ci:desktop-runtime-hosts', 'ci:unit']
  );
});

test('desktop runtime host selector avoids broad incidental host filenames', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/toast-host.ts']), [
    'ci:unit',
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
    cloudLabels: ['ci:desktop-runtime-hosts', 'ci:unit'],
  });
  assert.deepEqual(selectRiskLanesForFiles(['apps/desktop/src/llm-host-manager.ts']), [
    'ci:desktop-runtime-hosts',
    'ci:unit',
  ]);
});

test('web app changes select full web e2e and coverage lanes', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/src/App.tsx']), [
    'ci:web-e2e',
    'ci:unit',
  ]);
});

test('new runtime app changes fall back to coverage', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/new-app/src/index.ts']), [
    'ci:unit',
  ]);
});

test('risk labels match lane names', () => {
  assert.deepEqual(toRiskLabels(['ci:browser', 'ci:desktop']), [
    'ci:browser',
    'ci:desktop',
  ]);
});
