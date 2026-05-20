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
    return profile({
      category: 'desktop-platform-ipc-preload',
      domains: ['desktop-platform'],
      e2eLanes: isEmbeddingHostChange
        ? ['desktop-smoke-regression', 'desktop-embedding-diagnostics']
        : ['desktop-smoke-regression'],
      proofCommands: isEmbeddingHostChange
        ? ['diff-check', 'desktop-unit-tests', 'desktop-smoke-tests', 'desktop-embedding-smoke']
        : ['diff-check', 'desktop-unit-tests', 'desktop-smoke-tests'],
      riskLevel: 'high',
      cloudLabels: isEmbeddingHostChange
        ? ['ci:desktop', 'ci:embedding', 'ci:coverage']
        : ['ci:desktop', 'ci:coverage'],
    });
  }

  if (hasAny(normalizedFiles, DB_MIGRATION_PATTERNS)) {
    return profile({
      category: 'db-migrations-storage',
      domains: ['data-platform'],
      e2eLanes: ['destructive-reset'],
      proofCommands: ['diff-check', 'db-tests', 'migration-tests'],
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
      proofCommands: ['diff-check', 'db-tests'],
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
