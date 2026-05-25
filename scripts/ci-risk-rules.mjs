export const RISK_LANES = [
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
  'ci:unit',
  'ci:coverage-db',
  'ci:coverage-full',
  'ci:coverage',
  'ci:full',
];

export const EXPANDED_FULL_LANES = [
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
  'ci:coverage-db',
  'ci:coverage-full',
];

export const E2E_PROOF_COMMAND_LABELS = new Map([
  ['web-smoke-tests', 'ci:web-smoke'],
  ['web-file-explorer-persistence-tests', 'ci:web-file-explorer-persistence'],
  ['web-import-indexing-tests', 'ci:web-import-indexing'],
  ['web-assistant-state-tests', 'ci:web-assistant-state'],
  ['web-settings-state-tests', 'ci:web-settings-state'],
  ['web-db-startup-tests', 'ci:web-db-startup'],
  ['web-destructive-reset-tests', 'ci:web-destructive-reset'],
  ['web-full-regression-tests', 'ci:web-e2e'],
  ['desktop-smoke-tests', 'ci:desktop-smoke'],
  ['desktop-ipc-reset-tests', 'ci:desktop-ipc-reset'],
  ['desktop-runtime-host-tests', 'ci:desktop-runtime-hosts'],
  ['desktop-db-storage-tests', 'ci:desktop-db-storage'],
  ['desktop-full-regression-tests', 'ci:desktop'],
]);

const FULL_PATTERNS = [
  // test.yml routing is guarded by workflow-contract tests. Running product E2E does not prove
  // label/proof wiring changes, so keep this on the CI tooling proof lane unless product files
  // in the same diff select product lanes themselves.
  /^\.github\/(?!workflows\/test\.yml$)/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.jsonc$/,
  /^biome\.json$/,
  /^\.nvmrc$/,
  /^vitest\.config\./,
  /^playwright.*\.config\./,
];

const DOCS_ONLY_PATTERNS = [
  /^docs\//,
  /^apps\/docs\//,
  /^README\.md$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /\.md$/,
  /\.html$/,
];

const PROOF_ARTIFACT_PATTERNS = [/^\.ci\/proof\/latest\.json$/];

const CONFIG_TOOLING_PATTERNS = [
  /^package\.json$/,
  /^scripts\//,
  /^\.github\/actions\//,
  /^\.github\/workflows\/test\.yml$/,
  /^\.lefthook\.yml$/,
  /^lefthook\.yml$/,
  /^knip\.json$/,
  /^syncpack\.config\./,
];

const ASSISTANT_PATTERNS = [
  /^packages\/assistant-contract\//,
  /^packages\/agent\//,
  /^packages\/app-shell\/src\/assistant/,
  /^packages\/ui\/src\/assistant-ui-panel\//,
  /^apps\/web\/e2e\/assistant-/,
];

const INDEXING_PATTERNS = [
  /^packages\/indexing-contract\//,
  /^packages\/pipeline\//,
  /^packages\/file-import\//,
  /^packages\/text-splitter\//,
  /^packages\/chunking-worker\//,
  /^packages\/queue\//,
  /^packages\/embeddings\//,
  /^packages\/embedding-worker\//,
  /^packages\/vector-management\//,
];

const DB_PATTERNS = [
  /^packages\/db\//,
  /^packages\/storage\//,
  /^packages\/file-system\//,
];

const STORAGE_PATTERNS = [/^packages\/storage\//];

const FILE_SYSTEM_PATTERNS = [/^packages\/file-system\//];

const DB_MIGRATION_PATTERNS = [
  /^packages\/db\/src\/migrations\//,
  /^packages\/db\/migrations\//,
  /(^|\/)migration(s)?\//,
];

const DB_SCHEMA_PATTERNS = [
  /^packages\/db\/src\/architecture\//,
  /^packages\/db\/src\/drizzle\//,
  /^packages\/db\/src\/schema\//,
  ...DB_MIGRATION_PATTERNS,
];

const DB_REPOSITORY_PATTERNS = [
  /^packages\/db\/src\/models\//,
  /^packages\/db\/src\/repositories\//,
];

const DB_QUEUE_PATTERNS = [
  /^packages\/db\/src\/cli\/queue-cli\.ts$/,
  /^packages\/db\/src\/queue\//,
];

const DB_SEARCH_PATTERNS = [/^packages\/db\/src\/search\//];

const DB_INTEGRATION_PATTERNS = [
  /^packages\/db\/src\/browser-pglite-storage/,
  /^packages\/db\/src\/config\//,
  /^packages\/db\/src\/database-pressure-controller\.ts$/,
  /^packages\/db\/src\/database-work-scheduler\.ts$/,
  /^packages\/db\/src\/db-provider\.tsx$/,
  /^packages\/db\/src\/index\.ts$/,
  /^packages\/db\/src\/managed-cache\//,
  /^packages\/db\/src\/pglite-/,
  /^packages\/db\/src\/services\//,
  /^packages\/db\/src\/use-/,
  /^packages\/db\/src\/wasm-loader\.ts$/,
];

const DESKTOP_PLATFORM_PATTERNS = [
  /^apps\/desktop\/src\/main\.ts$/,
  /^apps\/desktop\/src\/preload\.ts$/,
  /^apps\/desktop\/src\/ipc-/,
  /^apps\/desktop\/src\/.*ipc.*\.ts$/,
  /^apps\/desktop\/src\/logging-/,
  /^apps\/desktop\/e2e\//,
];

const DESKTOP_SMOKE_PATTERNS = [
  /^apps\/desktop\/e2e\/app-launch\.test\.ts$/,
  /^apps\/desktop\/e2e\/assistant-panel\.desktop\.test\.ts$/,
  /^apps\/desktop\/e2e\/background-indexing-pause\.desktop\.test\.ts$/,
  /^apps\/desktop\/e2e\/file-system\.test\.ts$/,
];

const DESKTOP_IPC_RESET_PATTERNS = [
  /^apps\/desktop\/src\/desktop-factory-reset\.ts$/,
  /^apps\/desktop\/src\/desktop-reset-diagnostics\.ts$/,
  /^apps\/desktop\/src\/desktop-reset-platform\.ts$/,
  /^apps\/desktop\/src\/ipc-domains\/storage-preferences-ipc\.ts$/,
  /^apps\/desktop\/e2e\/factory-reset\.desktop\.test\.ts$/,
  /^apps\/desktop\/e2e\/ipc-communication\.test\.ts$/,
  /^apps\/desktop\/e2e\/startup-bridge-contract\.test\.ts$/,
];

const DESKTOP_RUNTIME_HOST_PATTERNS = [
  /^apps\/desktop\/src\/(?:embedding|llm|chunking|parser)-host(?:-|\.|$).*\.ts$/,
  /^apps\/desktop\/src\/ipc-(?:embedding|llm|chunking|parser)-host\.ts$/,
  /^apps\/desktop\/src\/renderer-host-lifecycle\.ts$/,
  /^apps\/desktop\/src\/platform\/runtime-host-/,
  /^apps\/desktop\/src\/renderer\/components\/(?:embedding|llm|chunking|parser)-host-/,
  /^apps\/desktop\/e2e\/app-launch\.test\.ts$/,
  /^apps\/desktop\/e2e\/chunking-host-renderer\.test\.ts$/,
  /^apps\/desktop\/e2e\/embedding-worker-renderer\.smoke\.desktop\.test\.ts$/,
  /^apps\/desktop\/e2e\/llm-host-renderer\.test\.ts$/,
];

const DESKTOP_EMBEDDING_HOST_PATTERNS = [
  /^apps\/desktop\/src\/embedding-/,
  /^apps\/desktop\/src\/renderer\/components\/embedding-host-/,
  /^apps\/desktop\/e2e\/embedding-worker-renderer\.smoke\.desktop\.test\.ts$/,
];

const DESKTOP_DB_STORAGE_PATTERNS = [
  /^apps\/desktop\/src\/db-/,
  /^apps\/desktop\/src\/database-/,
  /^apps\/desktop\/src\/desktop-database-work\.ts$/,
  /^apps\/desktop\/src\/ipc-domains\/db-ipc\.ts$/,
  /^apps\/desktop\/e2e\/database-persistence\.test\.ts$/,
];

const DESKTOP_FULL_REGRESSION_PATTERNS = [
  /^apps\/desktop\/src\/main\.ts$/,
  /^apps\/desktop\/src\/preload\.ts$/,
  /^apps\/desktop\/src\/ipc-handlers\.ts$/,
  /^apps\/desktop\/src\/main-platform-ipc\.ts$/,
];

const DESKTOP_RISK_PATTERNS = [
  ...DESKTOP_PLATFORM_PATTERNS,
  ...DESKTOP_SMOKE_PATTERNS,
  ...DESKTOP_IPC_RESET_PATTERNS,
  ...DESKTOP_RUNTIME_HOST_PATTERNS,
  ...DESKTOP_DB_STORAGE_PATTERNS,
  ...DESKTOP_FULL_REGRESSION_PATTERNS,
];

const WEB_UI_PATTERNS = [
  /^packages\/file-explorer-ui\//,
  /^packages\/file-explorer-hooks\//,
  /^packages\/file-explorer\//,
  /^packages\/hooks\//,
  /^packages\/db-explorer\//,
];

const SHARED_UI_PATTERNS = [/^packages\/ui\/(?!src\/assistant-ui-panel\/)/];

const WEB_SMOKE_PATTERNS = [
  /^apps\/web\/e2e\/(?:complete-workflow|file-explorer|file-preview|json-parse-diagnostic|layout|quick-filter|refresh|theme-switching)\.test\.ts$/,
];

const WEB_FILE_EXPLORER_PERSISTENCE_PATTERNS = [
  /^apps\/web\/e2e\/file-explorer-persistence\.test\.ts$/,
  /^packages\/file-explorer-ui\//,
  /^packages\/file-explorer-hooks\//,
  /^packages\/file-explorer\//,
];

const WEB_IMPORT_INDEXING_PATTERNS = [
  /^apps\/web\/src\/create-embedding-queue\.ts$/,
  /^apps\/web\/src\/workers\/embedding-worker-web\.ts$/,
  /^apps\/web\/e2e\/database-import-backfill\.test\.ts$/,
];

const WEB_ASSISTANT_STATE_PATTERNS = [
  /^apps\/web\/e2e\/assistant-/,
  /^packages\/assistant-contract\//,
  /^packages\/agent\//,
  /^packages\/app-shell\/src\/assistant/,
  /^packages\/ui\/src\/assistant-ui-panel\//,
];

const WEB_SETTINGS_STATE_PATTERNS = [
  /^apps\/web\/src\/app\/settings\//,
  /^apps\/web\/e2e\/(?:background-indexing-settings|local-runtime-settings|settings-models-and-providers|settings-token-counting|settings-tools-and-diagnostics)\.test\.ts$/,
];

// Migration files intentionally overlap startup/reset lane patterns, but the
// DB migration profile below must stay first so schema changes always get both
// startup and destructive reset coverage instead of one narrow web lane.
const WEB_DB_STARTUP_PATTERNS = [
  ...DB_MIGRATION_PATTERNS,
  /^apps\/web\/e2e\/(?:tools-panel-persistence|web-db-worker-startup|embedding-worker-telemetry)\.test\.ts$/,
];

const WEB_DESTRUCTIVE_RESET_PATTERNS = [
  ...DB_MIGRATION_PATTERNS,
  /^apps\/web\/e2e\/factory-reset-recovery\.test\.ts$/,
];

const WEB_SRC_FULL_REGRESSION_EXCLUSIONS = [
  /^__tests\//,
  /^app\/settings\//,
  /^create-embedding-queue\.ts$/,
  /^workers\/embedding-worker-web\.ts$/,
];

const WEB_SRC_FULL_REGRESSION_PATTERN = {
  test(filePath) {
    const prefix = 'apps/web/src/';
    if (!filePath.startsWith(prefix)) {
      return false;
    }

    const relativePath = filePath.slice(prefix.length);
    if (!/\.(ts|tsx|css)$/.test(relativePath)) {
      return false;
    }

    return !WEB_SRC_FULL_REGRESSION_EXCLUSIONS.some((pattern) => pattern.test(relativePath));
  },
};

const WEB_FULL_REGRESSION_PATTERNS = [
  WEB_SRC_FULL_REGRESSION_PATTERN,
  /^apps\/web\/playwright\.config\.ts$/,
  /^apps\/web\/e2e\/(?:layout-persistence|navigation-panel-state-preservation|panel-state-preservation|theme-css-consistency)\.test\.ts$/,
  /^packages\/app-shell\/(?!src\/assistant)/,
];

const WEB_RISK_PATTERNS = [
  ...WEB_SMOKE_PATTERNS,
  ...WEB_FILE_EXPLORER_PERSISTENCE_PATTERNS,
  ...WEB_IMPORT_INDEXING_PATTERNS,
  ...WEB_ASSISTANT_STATE_PATTERNS,
  ...WEB_SETTINGS_STATE_PATTERNS,
  ...WEB_DB_STARTUP_PATTERNS,
  ...WEB_DESTRUCTIVE_RESET_PATTERNS,
  ...WEB_FULL_REGRESSION_PATTERNS,
  ...WEB_UI_PATTERNS,
];

const SHARED_FOUNDATION_PATTERNS = [
  /^packages\/types\//,
  ...SHARED_UI_PATTERNS,
  /^packages\/utils\//,
  /^packages\/worker-runtime\//,
  /^packages\/platform-utils\//,
  /^packages\/config\//,
  /^packages\/server-config\//,
  /^packages\/test-utils\//,
];

const BROWSER_PATTERNS = [
  /^packages\/storage\//,
  /^packages\/db\//,
  /^packages\/config\/src\/vitest-browser\.ts$/,
  /^packages\/config\/src\/playwright-environment\.ts$/,
];

const WEB_E2E_PATTERNS = [
  ...WEB_FULL_REGRESSION_PATTERNS,
];

const DESKTOP_PATTERNS = [
  /^apps\/desktop\//,
  /^packages\/preferences\//,
  /^packages\/agent\//,
  /^packages\/vector-management\//,
  /^packages\/db-explorer\//,
];

const EMBEDDING_PATTERNS = [
  /^packages\/embeddings\//,
  /^packages\/embedding-worker\//,
  /^packages\/vector-management\//,
];

const LLM_HOST_PATTERNS = [
  /^apps\/desktop\/src\/llm-host-/,
  /^apps\/desktop\/src\/ipc-llm-host\.ts$/,
  /^apps\/desktop\/src\/renderer\/components\/llm-host-/,
];

const UNIT_PATTERNS = [
  /^apps\/(web|desktop)\//,
  /^packages\//,
];

const COVERAGE_DB_PATTERNS = [
  /^packages\/db\//,
  /^packages\/storage\//,
  /^packages\/file-system\//,
];

const COVERAGE_FULL_PATTERNS = [
  /^scripts\/enforce-coverage\.mjs$/,
  /^scripts\/prepare-workspace-coverage\.mjs$/,
  /^scripts\/merge-coverage\.js$/,
];

const RUNTIME_FALLBACK_UNIT_PATTERNS = [/^apps\/(?!docs\/)/, /^packages\//];

const UNIT_TEST_ONLY_PATTERNS = [
  /^(apps|packages)\/.+\.(test|integration\.test)\.(ts|tsx|mts|mjs)$/,
];

const LANE_PATTERNS = new Map([
  ['ci:browser', BROWSER_PATTERNS],
  ['ci:web-smoke', WEB_SMOKE_PATTERNS],
  ['ci:web-file-explorer-persistence', WEB_FILE_EXPLORER_PERSISTENCE_PATTERNS],
  ['ci:web-import-indexing', WEB_IMPORT_INDEXING_PATTERNS],
  ['ci:web-assistant-state', WEB_ASSISTANT_STATE_PATTERNS],
  ['ci:web-settings-state', WEB_SETTINGS_STATE_PATTERNS],
  ['ci:web-db-startup', WEB_DB_STARTUP_PATTERNS],
  ['ci:web-destructive-reset', WEB_DESTRUCTIVE_RESET_PATTERNS],
  ['ci:web-e2e', WEB_E2E_PATTERNS],
  ['ci:desktop-smoke', DESKTOP_SMOKE_PATTERNS],
  ['ci:desktop-ipc-reset', DESKTOP_IPC_RESET_PATTERNS],
  ['ci:desktop-runtime-hosts', DESKTOP_RUNTIME_HOST_PATTERNS],
  ['ci:desktop-db-storage', DESKTOP_DB_STORAGE_PATTERNS],
  ['ci:desktop', DESKTOP_FULL_REGRESSION_PATTERNS],
  ['ci:embedding', EMBEDDING_PATTERNS],
  ['ci:unit', UNIT_PATTERNS],
  ['ci:coverage-db', COVERAGE_DB_PATTERNS],
  ['ci:coverage-full', COVERAGE_FULL_PATTERNS],
]);

const E2E_LANES_BY_RISK_LABEL = new Map([
  ['ci:web-smoke', ['web-smoke']],
  ['ci:web-file-explorer-persistence', ['web-file-explorer-persistence']],
  ['ci:web-import-indexing', ['web-import-indexing']],
  ['ci:web-assistant-state', ['web-assistant-state']],
  ['ci:web-settings-state', ['web-settings-state']],
  ['ci:web-db-startup', ['web-db-startup']],
  ['ci:web-destructive-reset', ['web-destructive-reset']],
  ['ci:web-e2e', ['web-full-regression']],
  ['ci:desktop-smoke', ['desktop-smoke']],
  ['ci:desktop-ipc-reset', ['desktop-ipc-reset']],
  ['ci:desktop-runtime-hosts', ['desktop-runtime-hosts']],
  ['ci:desktop-db-storage', ['desktop-db-storage']],
  ['ci:desktop', ['desktop-full-regression']],
  ['ci:embedding', ['desktop-embedding-diagnostics']],
]);

const LOCAL_PROOF_COMMANDS_BY_LANE = new Map([
  ['ci:web-smoke', ['web-smoke-tests']],
  [
    'ci:web-file-explorer-persistence',
    ['file-explorer-tests', 'web-file-explorer-persistence-tests'],
  ],
  ['ci:web-import-indexing', ['indexing-tests', 'web-import-indexing-tests']],
  ['ci:web-assistant-state', ['assistant-contract-tests', 'app-shell-tests', 'web-assistant-state-tests']],
  ['ci:web-settings-state', ['web-settings-state-tests']],
  ['ci:web-db-startup', ['web-db-startup-tests']],
  ['ci:web-destructive-reset', ['web-destructive-reset-tests']],
  ['ci:web-e2e', ['web-full-regression-tests']],
  ['ci:desktop-smoke', ['desktop-unit-tests', 'desktop-smoke-tests']],
  ['ci:desktop-ipc-reset', ['desktop-unit-tests', 'desktop-ipc-reset-tests']],
  ['ci:desktop-runtime-hosts', ['desktop-unit-tests', 'desktop-runtime-host-tests']],
  ['ci:desktop-db-storage', ['desktop-unit-tests', 'desktop-db-storage-tests']],
  ['ci:desktop', ['desktop-unit-tests', 'desktop-full-regression-tests']],
]);

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

function assertKnownLane(lane) {
  if (!RISK_LANES.includes(lane)) {
    throw new Error(`unknown risk lane ${lane}`);
  }
}

export function normalizePath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function allFilesMatch(normalizedFiles, patterns) {
  return (
    normalizedFiles.length > 0 &&
    normalizedFiles.every((filePath) => matchesAny(filePath, patterns))
  );
}

function allFilesAreUnitTests(normalizedFiles) {
  return (
    normalizedFiles.length > 0 &&
    normalizedFiles.every(
      (filePath) =>
        !filePath.includes('/e2e/') && matchesAny(filePath, UNIT_TEST_ONLY_PATTERNS)
    )
  );
}

function hasAny(normalizedFiles, patterns) {
  return normalizedFiles.some((filePath) => matchesAny(filePath, patterns));
}

function docsNeutralRuntimeFiles(files) {
  return [...files]
    .map((filePath) => normalizePath(filePath))
    .filter((filePath) => !matchesAny(filePath, PROOF_ARTIFACT_PATTERNS))
    .filter((filePath) => !matchesAny(filePath, DOCS_ONLY_PATTERNS));
}

function proofNeutralRiskFiles(files) {
  return [...files]
    .map((filePath) => normalizePath(filePath))
    .filter((filePath) => !matchesAny(filePath, PROOF_ARTIFACT_PATTERNS));
}

function orderRiskLabels(labels) {
  const selected = new Set(labels);
  return RISK_LANES.filter((lane) => selected.has(lane));
}

function selectPatternMatchedCloudLabels(normalizedFiles, initialLabels) {
  const selected = new Set(initialLabels);
  for (const filePath of normalizedFiles) {
    for (const [lane, patterns] of LANE_PATTERNS) {
      if (matchesAny(filePath, patterns)) {
        selected.add(lane);
      }
    }
    if (
      !selected.has('ci:unit') &&
      matchesAny(filePath, RUNTIME_FALLBACK_UNIT_PATTERNS)
    ) {
      selected.add('ci:unit');
    }
  }

  return orderRiskLabels(selected);
}

function mergeE2eLanes(e2eLanes, cloudLabels) {
  const selected = new Set(e2eLanes);
  for (const label of cloudLabels) {
    for (const lane of E2E_LANES_BY_RISK_LABEL.get(label) ?? []) {
      selected.add(lane);
    }
  }

  return [...selected];
}

function dataPlatformPackageCommands(normalizedFiles) {
  const commands = ['diff-check'];
  if (hasAny(normalizedFiles, STORAGE_PATTERNS)) {
    commands.push('storage-tests');
  }
  if (hasAny(normalizedFiles, FILE_SYSTEM_PATTERNS)) {
    commands.push('file-system-tests');
  }
  return commands;
}

function dbPackageCommands(normalizedFiles) {
  const dbFiles = normalizedFiles.filter((filePath) => filePath.startsWith('packages/db/'));
  if (
    dbFiles.some(
      (filePath) => filePath === 'packages/db/src/index.ts' || filePath === 'packages/db/package.json'
    )
  ) {
    return [
      'diff-check',
      'db-schema-migration-tests',
      'db-repository-tests',
      'db-queue-tests',
      'db-search-tests',
      'db-integration-tests',
    ];
  }

  const laneCommands = [];

  if (hasAny(dbFiles, DB_SCHEMA_PATTERNS)) {
    laneCommands.push('db-schema-migration-tests');
  }
  if (hasAny(dbFiles, DB_REPOSITORY_PATTERNS)) {
    laneCommands.push('db-repository-tests');
  }
  if (hasAny(dbFiles, DB_QUEUE_PATTERNS)) {
    laneCommands.push('db-queue-tests');
  }
  if (hasAny(dbFiles, DB_SEARCH_PATTERNS)) {
    laneCommands.push('db-search-tests');
  }
  if (hasAny(dbFiles, DB_INTEGRATION_PATTERNS)) {
    laneCommands.push('db-integration-tests');
  }

  if (laneCommands.length === 0) {
    return [
      'diff-check',
      'db-schema-migration-tests',
      'db-repository-tests',
      'db-queue-tests',
      'db-search-tests',
      'db-integration-tests',
    ];
  }

  return ['diff-check', ...laneCommands];
}

function sharedFoundationCommands(normalizedFiles) {
  const commands = ['diff-check'];

  if (hasAny(normalizedFiles, SHARED_UI_PATTERNS)) {
    commands.push('ui-tests');
  }

  if (
    hasAny(normalizedFiles, [
      /^packages\/types\//,
      /^packages\/utils\//,
      /^packages\/worker-runtime\//,
      /^packages\/platform-utils\//,
      /^packages\/config\//,
      /^packages\/server-config\//,
      /^packages\/test-utils\//,
    ])
  ) {
    commands.push('shared-foundation-tests');
  }

  if (commands.length === 1) {
    commands.push('shared-foundation-tests');
  }

  return commands;
}

function profile({
  category,
  domains,
  e2eLanes,
  proofCommands,
  riskLevel,
  cloudLabels,
}) {
  return {
    category,
    domains,
    e2eLanes,
    proofCommands,
    riskLevel,
    cloudLabels,
  };
}

function selectBaseRiskProfileForFiles(files) {
  let normalizedFiles = proofNeutralRiskFiles(files);

  if (normalizedFiles.length === 0 || allFilesMatch(normalizedFiles, DOCS_ONLY_PATTERNS)) {
    return profile({
      category: 'docs-only',
      domains: ['documentation'],
      e2eLanes: [],
      proofCommands: ['diff-check', 'docs-static'],
      riskLevel: 'low',
      cloudLabels: [],
    });
  }

  normalizedFiles = normalizedFiles.filter(
    (filePath) => !matchesAny(filePath, DOCS_ONLY_PATTERNS)
  );

  if (hasAny(normalizedFiles, FULL_PATTERNS)) {
    return profile({
      category: 'full-release-high-risk',
      domains: ['ci-platform'],
      e2eLanes: [
        'critical-smoke',
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
  }

  if (allFilesAreUnitTests(normalizedFiles)) {
    return profile({
      category: 'isolated-unit-test-only',
      domains: ['test-only'],
      e2eLanes: [],
      proofCommands: ['diff-check', 'changed-unit-tests'],
      riskLevel: 'low',
      cloudLabels: ['ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, DESKTOP_RISK_PATTERNS)) {
    if (hasAny(normalizedFiles, DESKTOP_IPC_RESET_PATTERNS)) {
      return profile({
        category: 'desktop-ipc-reset',
        domains: ['desktop-platform'],
        e2eLanes: ['desktop-ipc-reset'],
        proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-ipc-reset-tests'],
        riskLevel: 'medium',
        cloudLabels: ['ci:desktop-ipc-reset', 'ci:unit'],
      });
    }

    if (hasAny(normalizedFiles, DESKTOP_DB_STORAGE_PATTERNS)) {
      return profile({
        category: 'desktop-db-storage',
        domains: ['desktop-platform', 'data-platform'],
        e2eLanes: ['desktop-db-storage'],
        proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-db-storage-tests'],
        riskLevel: 'medium',
        cloudLabels: ['ci:desktop-db-storage', 'ci:unit', 'ci:coverage-db'],
      });
    }

    if (hasAny(normalizedFiles, DESKTOP_RUNTIME_HOST_PATTERNS)) {
      return profile({
        category: 'desktop-runtime-hosts',
        domains: hasAny(normalizedFiles, DESKTOP_EMBEDDING_HOST_PATTERNS)
          ? ['desktop-platform', 'indexing']
          : ['desktop-platform'],
        e2eLanes: ['desktop-runtime-hosts'],
        proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-runtime-host-tests'],
        riskLevel: 'high',
        cloudLabels: ['ci:desktop-runtime-hosts', 'ci:unit'],
      });
    }

    return profile({
      category: 'desktop-platform-ipc-preload',
      domains: ['desktop-platform'],
      e2eLanes: ['desktop-full-regression'],
      proofCommands: ['diff-check', 'desktop-unit-tests', 'desktop-full-regression-tests'],
      riskLevel: 'high',
      cloudLabels: ['ci:desktop', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, DB_MIGRATION_PATTERNS)) {
    return profile({
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
        'ci:web-db-startup',
        'ci:web-destructive-reset',
        'ci:browser',
        'ci:unit',
        'ci:coverage-db',
      ],
    });
  }

  if (
    hasAny(normalizedFiles, [...STORAGE_PATTERNS, ...FILE_SYSTEM_PATTERNS]) &&
    !hasAny(normalizedFiles, [/^packages\/db\//])
  ) {
    return profile({
      category: 'db-migrations-storage',
      domains: ['data-platform'],
      e2eLanes: [],
      proofCommands: dataPlatformPackageCommands(normalizedFiles),
      riskLevel: 'medium',
      cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
    });
  }

  if (hasAny(normalizedFiles, INDEXING_PATTERNS)) {
    return profile({
      category: 'indexing-import-embedding',
      domains: ['indexing'],
      e2eLanes: hasAny(normalizedFiles, EMBEDDING_PATTERNS)
        ? ['desktop-embedding-diagnostics']
        : ['critical-smoke'],
      proofCommands: hasAny(normalizedFiles, EMBEDDING_PATTERNS)
        ? ['diff-check', 'indexing-tests', 'embedding-tests']
        : ['diff-check', 'indexing-tests'],
      riskLevel: hasAny(normalizedFiles, EMBEDDING_PATTERNS) ? 'high' : 'medium',
      cloudLabels: hasAny(normalizedFiles, EMBEDDING_PATTERNS)
        ? ['ci:embedding', 'ci:unit']
        : ['ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, ASSISTANT_PATTERNS)) {
    return profile({
      category: 'assistant-contract-runtime',
      domains: ['assistant'],
      e2eLanes: ['web-assistant-state'],
      proofCommands: ['diff-check', 'assistant-contract-tests', 'app-shell-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-assistant-state', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, WEB_IMPORT_INDEXING_PATTERNS)) {
    return profile({
      category: 'web-import-indexing',
      domains: ['workspace-experience', 'indexing'],
      e2eLanes: ['web-import-indexing'],
      proofCommands: ['diff-check', 'indexing-tests', 'web-import-indexing-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-import-indexing', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, WEB_FILE_EXPLORER_PERSISTENCE_PATTERNS)) {
    return profile({
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
    });
  }

  if (hasAny(normalizedFiles, WEB_SETTINGS_STATE_PATTERNS)) {
    return profile({
      category: 'web-settings-state',
      domains: ['applications'],
      e2eLanes: ['web-settings-state'],
      proofCommands: ['diff-check', 'web-settings-state-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-settings-state', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, WEB_DB_STARTUP_PATTERNS)) {
    return profile({
      category: 'web-db-startup',
      domains: ['applications', 'data-platform'],
      e2eLanes: ['web-db-startup'],
      proofCommands: ['diff-check', 'web-db-startup-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-db-startup', 'ci:unit', 'ci:coverage-db'],
    });
  }

  if (hasAny(normalizedFiles, WEB_DESTRUCTIVE_RESET_PATTERNS)) {
    return profile({
      category: 'web-destructive-reset',
      domains: ['applications', 'data-platform'],
      e2eLanes: ['web-destructive-reset'],
      proofCommands: ['diff-check', 'web-destructive-reset-tests'],
      riskLevel: 'high',
      cloudLabels: ['ci:web-destructive-reset', 'ci:unit', 'ci:coverage-db'],
    });
  }

  if (hasAny(normalizedFiles, WEB_SMOKE_PATTERNS)) {
    return profile({
      category: 'web-smoke',
      domains: ['applications'],
      e2eLanes: ['web-smoke'],
      proofCommands: ['diff-check', 'web-smoke-tests'],
      riskLevel: 'low',
      cloudLabels: ['ci:web-smoke', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, WEB_RISK_PATTERNS)) {
    return profile({
      category: 'web-full-regression',
      domains: ['applications'],
      e2eLanes: ['web-full-regression'],
      proofCommands: ['diff-check', 'web-full-regression-tests'],
      riskLevel: 'high',
      cloudLabels: ['ci:web-e2e', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, DB_PATTERNS)) {
    return profile({
      category: 'db-migrations-storage',
      domains: ['data-platform'],
      e2eLanes: [],
      proofCommands: dbPackageCommands(normalizedFiles),
      riskLevel: 'medium',
      cloudLabels: ['ci:browser', 'ci:unit', 'ci:coverage-db'],
    });
  }

  if (hasAny(normalizedFiles, WEB_UI_PATTERNS)) {
    return profile({
      category: 'web-ui-file-explorer',
      domains: ['workspace-experience'],
      e2eLanes: ['web-functional-stateful'],
      proofCommands: ['diff-check', 'file-explorer-tests', 'web-smoke-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-e2e', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, SHARED_FOUNDATION_PATTERNS)) {
    return profile({
      category: 'shared-foundation',
      domains: ['shared-foundation'],
      e2eLanes: ['critical-smoke'],
      proofCommands: sharedFoundationCommands(normalizedFiles),
      riskLevel: 'medium',
      cloudLabels: ['ci:browser', 'ci:unit'],
    });
  }

  if (hasAny(normalizedFiles, CONFIG_TOOLING_PATTERNS)) {
    return profile({
      category: 'config-tooling',
      domains: ['tooling'],
      e2eLanes: [],
      proofCommands: ['diff-check', 'ci-script-tests', 'workflow-contracts'],
      riskLevel: 'medium',
      cloudLabels: ['ci:unit'],
    });
  }

  return profile({
    category: 'config-tooling',
    domains: ['tooling'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'ci-script-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:unit'],
  });
}

export function selectRiskProfileForFiles(files) {
  const baseProfile = selectBaseRiskProfileForFiles(files);

  if (
    ['docs-only', 'full-release-high-risk', 'isolated-unit-test-only'].includes(
      baseProfile.category
    )
  ) {
    return {
      ...baseProfile,
      cloudLabels: orderRiskLabels(baseProfile.cloudLabels),
    };
  }

  const cloudLabels = selectPatternMatchedCloudLabels(
    docsNeutralRuntimeFiles(files),
    baseProfile.cloudLabels
  );

  return {
    ...baseProfile,
    e2eLanes: mergeE2eLanes(baseProfile.e2eLanes, cloudLabels),
    cloudLabels,
  };
}

export function selectRiskLanesForFiles(files) {
  return selectRiskProfileForFiles(files).cloudLabels;
}

export function selectProofCommandsForFiles(files) {
  const profileForFiles = selectRiskProfileForFiles(files);
  const normalizedFiles = [...files].map((filePath) => normalizePath(filePath));

  if (profileForFiles.cloudLabels.includes('ci:full')) {
    return [...profileForFiles.proofCommands];
  }

  const commands = new Set(profileForFiles.proofCommands);
  for (const lane of selectRiskLanesForFiles(files)) {
    for (const commandName of LOCAL_PROOF_COMMANDS_BY_LANE.get(lane) ?? []) {
      commands.add(commandName);
    }
  }
  if (
    profileForFiles.category !== 'isolated-unit-test-only' &&
    hasAny(normalizedFiles, SHARED_FOUNDATION_PATTERNS)
  ) {
    for (const commandName of sharedFoundationCommands(normalizedFiles)) {
      commands.add(commandName);
    }
  }

  return [...commands];
}

export function expandRiskLanes(lanes) {
  const selected = new Set();
  for (const lane of lanes) {
    assertKnownLane(lane);
    if (lane === 'ci:full') {
      for (const expandedLane of EXPANDED_FULL_LANES) {
        selected.add(expandedLane);
      }
    } else {
      selected.add(lane);
    }
  }

  return RISK_LANES.filter(
    (lane) => lane !== 'ci:full' && selected.has(lane)
  );
}

export function toRiskLabels(lanes) {
  for (const lane of lanes) {
    assertKnownLane(lane);
  }

  return [...lanes];
}
