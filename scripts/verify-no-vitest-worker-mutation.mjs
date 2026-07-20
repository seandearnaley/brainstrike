// Guard against the BST-591 flake class: test code that deletes or reassigns
// the `__vitest_worker__` global creates a window in which vitest's own
// throttled task-update timer crashes the worker with "Vitest failed to access
// its internal state" — every test passes but the run exits 1. The window only
// collides under load (event-loop starvation stretches it from microseconds to
// seconds), so the resulting flake surfaces in full-graph/CI runs and never in
// isolated runs. Simulate non-test runtimes through an injectable/mockable
// seam instead (see packages/file-explorer/src/persistence/test-environment.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WORKER_STATE_KEY = '__vitest_worker__';

// Mutation forms only: object-literal keys (`__vitest_worker__: {}`) and `in`
// probes are safe and stay allowed.
const MUTATION_PATTERNS = [
  {
    description: '`delete` expression targeting the vitest worker global',
    pattern: new RegExp(String.raw`\bdelete\s[^;\n]*${WORKER_STATE_KEY}`),
  },
  {
    description: 'Reflect.deleteProperty call targeting the vitest worker global',
    pattern: new RegExp(String.raw`deleteProperty\s*\([^)]*${WORKER_STATE_KEY}`),
  },
  {
    description: 'assignment to the vitest worker global',
    pattern: new RegExp(String.raw`${WORKER_STATE_KEY}['"\]]*\s*=(?![=>])`),
  },
  {
    description: 'vi.stubGlobal of the vitest worker global',
    pattern: new RegExp(String.raw`stubGlobal\s*\(\s*['"]${WORKER_STATE_KEY}`),
  },
];

const SKIPPED_DIRECTORIES = new Set(['.turbo', 'build', 'coverage', 'dist', 'node_modules']);

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function findVitestWorkerMutations(source, filename) {
  if (!source.includes(WORKER_STATE_KEY)) {
    return [];
  }
  return MUTATION_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ description }) => ({
    description,
    filename,
  }));
}

function collectTestFiles(directory, collected) {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) {
      continue;
    }
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectTestFiles(fullPath, collected);
    } else if (TEST_FILE_PATTERN.test(entry)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

export function scanRepositoryTestFiles(rootDir) {
  const violations = [];
  for (const workspaceDir of ['packages', 'apps']) {
    const files = collectTestFiles(join(rootDir, workspaceDir), []);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const violation of findVitestWorkerMutations(source, relative(rootDir, file))) {
        violations.push(violation);
      }
    }
  }
  return violations;
}
