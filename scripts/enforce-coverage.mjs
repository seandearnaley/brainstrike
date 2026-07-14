#!/usr/bin/env node
// Enforce per-package coverage thresholds using coverage-final.json from vitest v8 provider
// Usage: node scripts/enforce-coverage.mjs

import fs from 'node:fs';
import path from 'node:path';

// Default thresholds applied to all packages unless overridden below.
// Keep these aligned with root vitest.config.mts global thresholds.
const DEFAULT_THRESHOLDS = { branches: 62, functions: 65, lines: 80, statements: 75 };

// Optional strict overrides for key packages.
// NOTE: Thresholds recalibrated for Vitest 4's v8 coverage provider (BST-55)
// Vitest 4's v8 provider measures coverage differently than Vitest 3:
// - Lines coverage generally increased
// - Functions/Branches coverage generally decreased
const OVERRIDES = new Map([
  // High-coverage packages with strict enforcement
  // Vitest 4: L 94.52% | F 76.75% | B 66.23% | S 74.64%
  // Recalibrated 2025-01 after FileTreeIndex type-change handling and handle cleanup additions
  ['@brainstrike/file-explorer-ui', { branches: 66, functions: 76, lines: 94, statements: 74 }],
  // App shell — measured 2026-03: L 99.41% | F 89.87% | B 76.03% | S 88.07%
  // Ratcheted after database-demo hooks, format utils, and export handler test additions.
  ['@brainstrike/app-shell', { branches: 75, functions: 88, lines: 98, statements: 87 }],
  // Desktop — measured 2026-03: L 91.45% | F 71.10% | B 61.33% | S 71.54%
  // Recalibrated 2026-03 — coverage drifted from new IPC code; Phase 3 work needed.
  ['@brainstrike/desktop', { branches: 60, functions: 70, lines: 90, statements: 70 }],
  // Configuration and utility package thresholds recalibrated in 2026-03.
  ['@brainstrike/config', { branches: 80, functions: 98, lines: 98, statements: 98 }],
  ['@brainstrike/tailwind-config', { branches: 0, functions: 0, lines: 10, statements: 10 }],
  ['@brainstrike/types', { branches: 0, functions: 50, lines: 20, statements: 20 }],
  // File system — measured 2026-03: L 88.65% | F 89.52% | B 71.18% | S 78.31%
  // Ratcheted after utils-browser and path-validation branch test additions.
  ['@brainstrike/file-system', { branches: 70, functions: 89, lines: 88, statements: 77 }],
  // Test utilities are helper scaffolding used by other packages' tests
  ['@brainstrike/test-utils', { branches: 70, functions: 70, lines: 75, statements: 65 }],
  // Build utilities — measured 2026-03: L 100% | F 100% | B 90.48% | S 98.04%
  // Ratcheted after resolveAssistantVendorChunk, getter, and getLazySurface test additions.
  ['@brainstrike/build-utils', { branches: 89, functions: 99, lines: 99, statements: 97 }],
  // DB package thresholds ratcheted in 2026-03 after repository coverage additions.
  ['@brainstrike/db', { branches: 61, functions: 73, lines: 85, statements: 70 }],
  // DB Explorer thresholds recalibrated in 2026-03.
  ['@brainstrike/db-explorer', { branches: 62, functions: 75, lines: 95, statements: 74 }],
  // Web app — measured 2026-03: L 99.44% | F 86.41% | B 74.77% | S 90.27%
  // Ratcheted after partial-mock refactoring restored coverage for stream-helpers and routes.
  ['@brainstrike/web', { branches: 73, functions: 85, lines: 98, statements: 89 }],
  // Embeddings — heavy integration excluded from unit coverage
  // Vitest 4: L 0.00% | F 0.00% | B 0.00% | S 0.00% (no files covered)
  ['@brainstrike/embeddings', { branches: 0, functions: 0, lines: 0, statements: 0 }],
  // Chunking worker thresholds ratcheted in 2026-03 after strict skip/cap strategy-path coverage additions.
  // Note: Worker code runs in browser context; some paths untestable in Node.js
  ['@brainstrike/chunking-worker', { branches: 54, functions: 85, lines: 87, statements: 71 }],
  // Embedding worker — Vitest 4: L 89.76% | F 93.33% | B 53.46% | S 74.64%
  // Recalibrated 2024-12 after worker log verbosity changes.
  // Note: ~10% of code (self.onerror, self.onunhandledrejection) runs only in browser
  // Web Worker context where `typeof self !== 'undefined'`. This code cannot be tested
  // in Node.js - it's guarded by runtime environment check and legitimately untestable.
  ['@brainstrike/embedding-worker', { branches: 53, functions: 93, lines: 89, statements: 74 }],
  // File explorer — measured 2026-03: L 96.44% | F 86.53% | B 80.43% | S 87.93%
  // Ratcheted after state-serialization, file-selection-actions, tab-persistence, worker-storage branch tests.
  ['@brainstrike/file-explorer', { branches: 79, functions: 85, lines: 95, statements: 86 }],
  // File tree worker thresholds recalibrated in 2026-03.
  ['@brainstrike/file-tree-worker', { branches: 68, functions: 90, lines: 92, statements: 84 }],
  // File import thresholds ratcheted in 2026-03 after worker initialization/timeout edge-case tests.
  ['@brainstrike/file-import', { branches: 61, functions: 83, lines: 95, statements: 79 }],
  // UI package — measured 2026-04 after the Gemma local-runtime assistant-panel expansion
  // and fresh uncached coverage regeneration: L 93.84% | F 69.35% | B 59.68% | S 79.03%.
  // Previous function/branch thresholds were being masked by stale coverage artifacts.
  // Follow-up BST-492 tracks restoring stricter UI package coverage.
  ['@brainstrike/ui', { branches: 59, functions: 69, lines: 92, statements: 77 }],
  // Token cache — elevated after token-utils-lite branch/path coverage improvements
  ['@brainstrike/token-cache', { branches: 62, functions: 92, lines: 92, statements: 82 }],
  // Queue thresholds ratcheted in 2026-03 after workerpool adapter control-flow/telemetry coverage additions.
  ['@brainstrike/queue', { branches: 80, functions: 90, lines: 90, statements: 90 }],
  // Preferences package thresholds ratcheted in 2026-03 after settings/store coverage additions.
  ['@brainstrike/preferences', { branches: 63, functions: 70, lines: 82, statements: 76 }],
]);

// DB coverage is intentionally split into dedicated test:coverage:db:* lanes
// because running it in the normal workspace coverage pass is too slow for PR
// gates. If DB coverage artifacts exist, they are still enforced below.
// Embeddings is not exempt: the supported split/nightly coverage flows run its
// dedicated coverage lane before enforcement, so a missing artifact is a real
// orchestration failure rather than an allowed split-lane omission.
const ALLOW_MISSING_COVERAGE_ARTIFACT = new Set(['@brainstrike/db']);

// Discover all coverage files under packages/* and apps/*
function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

function findPkgName(fromDir) {
  let curr = path.resolve(fromDir);
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(curr, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name;
        if (name) {
          return name;
        }
      } catch (error) {
        throw new Error(`Failed to parse coverage package metadata at ${pkgPath}`, {
          cause: error,
        });
      }
    }
    curr = path.dirname(curr);
  }
  return path.basename(fromDir);
}

function discoverCoverageScriptPackages() {
  const packages = [];
  for (const root of ['packages', 'apps']) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgDir = path.join(root, entry.name);
      const pkgPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        continue;
      }
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const name = typeof pkg.name === 'string' ? pkg.name : path.basename(pkgDir);
        const hasCoverageScript =
          typeof pkg.scripts === 'object' &&
          pkg.scripts !== null &&
          typeof pkg.scripts['test:coverage'] === 'string';
        if (hasCoverageScript && !ALLOW_MISSING_COVERAGE_ARTIFACT.has(name)) {
          packages.push({ dir: pkgDir, name });
        }
      } catch (error) {
        throw new Error(`Failed to parse coverage package metadata at ${pkgPath}`, {
          cause: error,
        });
      }
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

const coverageFiles = [];
for (const root of ['packages', 'apps']) {
  if (!fs.existsSync(root)) {
    continue;
  }
  for (const file of walk(root)) {
    if (file.endsWith(path.join('coverage', 'coverage-final.json'))) {
      coverageFiles.push(file);
    }
  }
}

function summarize(json) {
  let stTot = 0,
    stCov = 0,
    fnTot = 0,
    fnCov = 0,
    brTot = 0,
    brCov = 0,
    lnTot = 0,
    lnCov = 0;
  for (const file of Object.values(json)) {
    const s = file.s;
    stTot += Object.keys(s).length;
    stCov += Object.values(s).filter((v) => v > 0).length;
    const f = file.f;
    fnTot += Object.keys(f).length;
    fnCov += Object.values(f).filter((v) => v > 0).length;
    const b = file.b;
    for (const arr of Object.values(b)) {
      brTot += arr.length;
      brCov += arr.filter((v) => v > 0).length;
    }
    const stm = file.statementMap;
    const lns = new Set();
    for (const { start, end } of Object.values(stm)) {
      for (let l = start.line; l <= end.line; l++) {
        lns.add(l);
      }
    }
    lnTot += lns.size;
    const coveredLines = new Set();
    for (const [k, v] of Object.entries(file.s)) {
      if (v > 0) {
        const { start, end } = file.statementMap[k];
        for (let l = start.line; l <= end.line; l++) {
          coveredLines.add(l);
        }
      }
    }
    lnCov += coveredLines.size;
  }
  const pct = (cov, tot) => (tot ? (100 * cov) / tot : 0);
  return {
    branches: { covered: brCov, pct: pct(brCov, brTot), total: brTot },
    functions: { covered: fnCov, pct: pct(fnCov, fnTot), total: fnTot },
    lines: { covered: lnCov, pct: pct(lnCov, lnTot), total: lnTot },
    statements: { covered: stCov, pct: pct(stCov, stTot), total: stTot },
  };
}

function formatPct(n) {
  return `${n.toFixed(2)}%`;
}

if (coverageFiles.length === 0) {
  console.error('❌ No coverage files found under packages/* or apps/*');
  try {
    // Print a quick debug listing to help diagnose CI path issues without being noisy.
    const hints = [];
    for (const root of ['packages', 'apps']) {
      if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root)) {
          const p = path.join(root, entry, 'coverage');
          if (fs.existsSync(p)) {
            hints.push(p);
          }
        }
      }
    }
    if (hints.length) {
      console.error('Found coverage directories (no final json yet):', hints.join(', '));
    }
  } catch (error) {
    console.error('Failed to inspect coverage directory hints:', error);
  }
  process.exit(1);
}

const coveredPackageNames = new Set(
  coverageFiles.map((file) => findPkgName(path.dirname(path.dirname(file))))
);
const missingCoveragePackages = discoverCoverageScriptPackages().filter(
  ({ name }) => !coveredPackageNames.has(name)
);
if (missingCoveragePackages.length > 0) {
  console.error('❌ Missing coverage artifacts for packages with test:coverage scripts:');
  for (const { dir, name } of missingCoveragePackages) {
    console.error(`  - ${name} (${path.relative(process.cwd(), dir)})`);
  }
  process.exit(1);
}

let hasFailure = false;
for (const file of coverageFiles.sort()) {
  const pkgDir = path.dirname(path.dirname(file));
  const pkgName = findPkgName(pkgDir);
  const thresholds = OVERRIDES.get(pkgName) ?? DEFAULT_THRESHOLDS;

  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = summarize(json);
  // Only enforce metrics that exist (total > 0). Packages without functions/branches
  // shouldn't fail due to 0% on non-existent metrics.
  const checks = [
    ['lines', s.lines.pct, thresholds.lines, s.lines.total],
    ['functions', s.functions.pct, thresholds.functions, s.functions.total],
    ['branches', s.branches.pct, thresholds.branches, s.branches.total],
    ['statements', s.statements.pct, thresholds.statements, s.statements.total],
  ];
  let ok = true;
  for (const [, pct, min, total] of checks) {
    if (total > 0 && pct + 1e-6 < min) {
      ok = false;
    }
  }
  const summary = `L ${formatPct(s.lines.pct)} | F ${formatPct(s.functions.pct)} | B ${formatPct(s.branches.pct)} | S ${formatPct(s.statements.pct)}`;
  const threshText = `(>= L${thresholds.lines} F${thresholds.functions} B${thresholds.branches} S${thresholds.statements})`;
  const rel = path.relative(process.cwd(), file);
  if (ok) {
    console.log(`✅ ${pkgName}: ${summary} ${threshText}`);
  } else {
    hasFailure = true;
    console.error(`❌ ${pkgName}: ${summary} is below thresholds ${threshText} [${rel}]`);
  }
}

if (hasFailure) {
  process.exit(1);
}
console.log('All package coverage thresholds satisfied.');
