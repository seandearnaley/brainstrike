export const RISK_LANES = [
  'ci:browser',
  'ci:web-e2e',
  'ci:desktop',
  'ci:embedding',
  'ci:coverage',
  'ci:full',
];

export const EXPANDED_FULL_LANES = [
  'ci:browser',
  'ci:web-e2e',
  'ci:desktop',
  'ci:embedding',
  'ci:coverage',
];

const FULL_PATTERNS = [
  /^\.github\//,
  /^package\.json$/,
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

const CONFIG_TOOLING_PATTERNS = [
  /^scripts\//,
  /^\.github\/actions\//,
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
  /^apps\/desktop\/src\/embedding-/,
  /^apps\/desktop\/src\/renderer\/components\/embedding-host-/,
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
  /^apps\/desktop\/src\/.*host.*\.ts$/,
  /^apps\/desktop\/src\/logging-/,
  /^apps\/desktop\/e2e\//,
];

const WEB_UI_PATTERNS = [
  /^apps\/web\//,
  /^packages\/file-explorer-ui\//,
  /^packages\/file-explorer-hooks\//,
  /^packages\/file-explorer\//,
  /^packages\/ui\//,
  /^packages\/hooks\//,
  /^packages\/db-explorer\//,
];

const SHARED_FOUNDATION_PATTERNS = [
  /^packages\/types\//,
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
  /^apps\/web\//,
  /^packages\/app-shell\//,
  /^packages\/ui\//,
  /^packages\/file-explorer-ui\//,
  /^packages\/file-explorer-hooks\//,
  /^packages\/file-explorer\//,
];

const DESKTOP_PATTERNS = [
  /^apps\/desktop\//,
  /^packages\/preferences\//,
  /^packages\/agent\//,
  /^packages\/vector-management\//,
  /^packages\/db-explorer\//,
];

const EMBEDDING_PATTERNS = [
  /^apps\/desktop\/src\/embedding-/,
  /^apps\/desktop\/src\/renderer\/components\/embedding-host-/,
  /^packages\/embeddings\//,
  /^packages\/embedding-worker\//,
  /^packages\/vector-management\//,
];

const LLM_HOST_PATTERNS = [
  /^apps\/desktop\/src\/llm-host-/,
  /^apps\/desktop\/src\/ipc-llm-host\.ts$/,
  /^apps\/desktop\/src\/renderer\/components\/llm-host-/,
];

const COVERAGE_PATTERNS = [
  /^apps\/(web|desktop)\//,
  /^packages\//,
  /^scripts\/enforce-coverage\.mjs$/,
  /^scripts\/prepare-workspace-coverage\.mjs$/,
  /^scripts\/merge-coverage\.js$/,
];

const RUNTIME_FALLBACK_COVERAGE_PATTERNS = [/^apps\/(?!docs\/)/, /^packages\//];

const UNIT_TEST_ONLY_PATTERNS = [
  /^(apps|packages)\/.+\.(test|integration\.test)\.(ts|tsx|mts|mjs)$/,
];

const LANE_PATTERNS = new Map([
  ['ci:browser', BROWSER_PATTERNS],
  ['ci:web-e2e', WEB_E2E_PATTERNS],
  ['ci:desktop', DESKTOP_PATTERNS],
  ['ci:embedding', EMBEDDING_PATTERNS],
  ['ci:coverage', COVERAGE_PATTERNS],
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

export function selectRiskProfileForFiles(files) {
  const normalizedFiles = [...files].map((filePath) => normalizePath(filePath));

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

  if (hasAny(normalizedFiles, FULL_PATTERNS)) {
    return profile({
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
  }

  if (allFilesAreUnitTests(normalizedFiles)) {
    return profile({
      category: 'isolated-unit-test-only',
      domains: ['test-only'],
      e2eLanes: [],
      proofCommands: ['diff-check', 'changed-unit-tests'],
      riskLevel: 'low',
      cloudLabels: ['ci:coverage'],
    });
  }

  if (hasAny(normalizedFiles, DESKTOP_PLATFORM_PATTERNS)) {
    const isEmbeddingHostChange = hasAny(normalizedFiles, EMBEDDING_PATTERNS);
    const isLlmHostChange = hasAny(normalizedFiles, LLM_HOST_PATTERNS);
    const e2eLanes = ['desktop-smoke-regression'];
    const proofCommands = ['diff-check', 'desktop-unit-tests', 'desktop-smoke-tests'];
    const cloudLabels = ['ci:desktop', 'ci:coverage'];
    if (isEmbeddingHostChange) {
      e2eLanes.push('desktop-embedding-diagnostics');
      proofCommands.push('desktop-embedding-smoke');
      cloudLabels.splice(1, 0, 'ci:embedding');
    }
    if (isLlmHostChange) {
      e2eLanes.push('desktop-llm-host-recovery');
      proofCommands.push('desktop-llm-host-smoke');
    }
    return profile({
      category: 'desktop-platform-ipc-preload',
      domains: ['desktop-platform'],
      e2eLanes,
      proofCommands,
      riskLevel: 'high',
      cloudLabels,
    });
  }

  if (hasAny(normalizedFiles, DB_MIGRATION_PATTERNS)) {
    return profile({
      category: 'db-migrations-storage',
      domains: ['data-platform'],
      e2eLanes: ['destructive-reset'],
      proofCommands: ['diff-check', 'db-schema-migration-tests', 'db-integration-tests'],
      riskLevel: 'high',
      cloudLabels: ['ci:browser', 'ci:coverage'],
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
      cloudLabels: ['ci:browser', 'ci:coverage'],
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
        ? ['ci:desktop', 'ci:embedding', 'ci:coverage']
        : ['ci:coverage'],
    });
  }

  if (hasAny(normalizedFiles, ASSISTANT_PATTERNS)) {
    return profile({
      category: 'assistant-contract-runtime',
      domains: ['assistant'],
      e2eLanes: ['critical-smoke'],
      proofCommands: ['diff-check', 'assistant-contract-tests', 'app-shell-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-e2e', 'ci:coverage'],
    });
  }

  if (hasAny(normalizedFiles, DB_PATTERNS)) {
    return profile({
      category: 'db-migrations-storage',
      domains: ['data-platform'],
      e2eLanes: [],
      proofCommands: dbPackageCommands(normalizedFiles),
      riskLevel: 'medium',
      cloudLabels: ['ci:browser', 'ci:coverage'],
    });
  }

  if (hasAny(normalizedFiles, WEB_UI_PATTERNS)) {
    return profile({
      category: 'web-ui-file-explorer',
      domains: ['workspace-experience'],
      e2eLanes: ['web-functional-stateful'],
      proofCommands: ['diff-check', 'file-explorer-tests', 'web-smoke-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:web-e2e', 'ci:coverage'],
    });
  }

  if (hasAny(normalizedFiles, SHARED_FOUNDATION_PATTERNS)) {
    return profile({
      category: 'shared-foundation',
      domains: ['shared-foundation'],
      e2eLanes: ['critical-smoke'],
      proofCommands: ['diff-check', 'shared-foundation-tests'],
      riskLevel: 'medium',
      cloudLabels: ['ci:browser', 'ci:coverage'],
    });
  }

  if (hasAny(normalizedFiles, CONFIG_TOOLING_PATTERNS)) {
    return profile({
      category: 'config-tooling',
      domains: ['tooling'],
      e2eLanes: [],
      proofCommands: ['diff-check', 'ci-script-tests', 'workflow-contracts'],
      riskLevel: 'medium',
      cloudLabels: ['ci:coverage'],
    });
  }

  return profile({
    category: 'config-tooling',
    domains: ['tooling'],
    e2eLanes: [],
    proofCommands: ['diff-check', 'ci-script-tests'],
    riskLevel: 'medium',
    cloudLabels: ['ci:coverage'],
  });
}

export function selectRiskLanesForFiles(files) {
  const profileForFiles = selectRiskProfileForFiles(files);

  if (profileForFiles.cloudLabels.includes('ci:full')) {
    return ['ci:full'];
  }

  const normalizedFiles = [...files].map((filePath) => normalizePath(filePath));
  const selected = new Set();
  for (const label of profileForFiles.cloudLabels) {
    selected.add(label);
  }
  for (const filePath of normalizedFiles) {
    for (const [lane, patterns] of LANE_PATTERNS) {
      if (matchesAny(filePath, patterns)) {
        selected.add(lane);
      }
    }
    if (
      !selected.has('ci:coverage') &&
      matchesAny(filePath, RUNTIME_FALLBACK_COVERAGE_PATTERNS)
    ) {
      selected.add('ci:coverage');
    }
  }

  return RISK_LANES.filter((lane) => selected.has(lane));
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
