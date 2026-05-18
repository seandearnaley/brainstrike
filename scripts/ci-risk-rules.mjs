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
  // CI and repo-tooling edits intentionally take the conservative all-lanes
  // route. Narrower carve-outs should be based on observed false positives.
  /^\.github\//,
  /^scripts\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.jsonc$/,
  /^biome\.json$/,
  /^\.nvmrc$/,
  /^vitest\.config\./,
  /^playwright.*\.config\./,
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

export function selectRiskLanesForFiles(files) {
  const normalizedFiles = [...files].map((filePath) => normalizePath(filePath));

  if (
    normalizedFiles.some((filePath) => matchesAny(filePath, FULL_PATTERNS))
  ) {
    return ['ci:full'];
  }

  const selected = new Set();
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
