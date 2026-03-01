#!/usr/bin/env node
// Enforce per-package coverage thresholds using coverage-final.json from vitest v8 provider
// Usage: node scripts/enforce-coverage.mjs

import fs from 'node:fs';
import path from 'node:path';

// Default thresholds applied to all packages unless overridden below.
// Keep these aligned with root vitest.config.mts global thresholds.
const DEFAULT_THRESHOLDS = { lines: 80, functions: 65, branches: 62, statements: 75 };

// Optional strict overrides for key packages.
// NOTE: Thresholds recalibrated for Vitest 4's v8 coverage provider (BST-55)
// Vitest 4's v8 provider measures coverage differently than Vitest 3:
// - Lines coverage generally increased
// - Functions/Branches coverage generally decreased
const OVERRIDES = new Map([
  // High-coverage packages with strict enforcement
  // Vitest 4: L 94.52% | F 76.75% | B 66.23% | S 74.64%
  // Recalibrated 2025-01 after FileTreeIndex type-change handling and handle cleanup additions
  ['@brainstrike/file-explorer-ui', { lines: 94, functions: 76, branches: 66, statements: 74 }],
  // App shell — Vitest 4: L 94.79% | F 83.92% | B 67.98% | S 79.58%
  // Recalibrated 2024-12 after mocking changes
  ['@brainstrike/app-shell', { lines: 94, functions: 83, branches: 67, statements: 79 }],
  // Desktop thresholds recalibrated in 2026-03 after local/CI coverage hardening.
  ['@brainstrike/desktop', { lines: 94, functions: 78, branches: 66, statements: 78 }],
  // Configuration and utility package thresholds recalibrated in 2026-03.
  ['@brainstrike/config', { lines: 98, functions: 98, branches: 80, statements: 98 }],
  ['@brainstrike/tailwind-config', { lines: 10, functions: 0, branches: 0, statements: 10 }],
  ['@brainstrike/types', { lines: 20, functions: 50, branches: 0, statements: 20 }],
  // File system thresholds recalibrated in 2026-03 after broader test coverage.
  ['@brainstrike/file-system', { lines: 84, functions: 84, branches: 66, statements: 74 }],
  // Test utilities are helper scaffolding used by other packages' tests
  ['@brainstrike/test-utils', { lines: 75, functions: 70, branches: 70, statements: 65 }],
  // Build utilities close to threshold, give small buffer
  ['@brainstrike/build-utils', { lines: 90, functions: 90, branches: 80, statements: 90 }],
  // DB package thresholds recalibrated in 2026-03.
  ['@brainstrike/db', { lines: 84, functions: 72, branches: 60, statements: 69 }],
  // DB Explorer thresholds recalibrated in 2026-03.
  ['@brainstrike/db-explorer', { lines: 95, functions: 75, branches: 62, statements: 74 }],
  // Web app thresholds recalibrated in 2026-03.
  ['@brainstrike/web', { lines: 92, functions: 80, branches: 65, statements: 82 }],
  // Embeddings — heavy integration excluded from unit coverage
  // Vitest 4: L 0.00% | F 0.00% | B 0.00% | S 0.00% (no files covered)
  ['@brainstrike/embeddings', { lines: 0, functions: 0, branches: 0, statements: 0 }],
  // Chunking worker thresholds recalibrated in 2026-03.
  // Note: Worker code runs in browser context; some paths untestable in Node.js
  ['@brainstrike/chunking-worker', { lines: 84, functions: 80, branches: 50, statements: 68 }],
  // Embedding worker — Vitest 4: L 89.76% | F 93.33% | B 53.46% | S 74.64%
  // Recalibrated 2024-12 after worker log verbosity changes.
  // Note: ~10% of code (self.onerror, self.onunhandledrejection) runs only in browser
  // Web Worker context where `typeof self !== 'undefined'`. This code cannot be tested
  // in Node.js - it's guarded by runtime environment check and legitimately untestable.
  ['@brainstrike/embedding-worker', { lines: 89, functions: 93, branches: 53, statements: 74 }],
  // File explorer thresholds recalibrated in 2026-03.
  ['@brainstrike/file-explorer', { lines: 92, functions: 84, branches: 70, statements: 82 }],
  // File tree worker thresholds recalibrated in 2026-03.
  ['@brainstrike/file-tree-worker', { lines: 92, functions: 90, branches: 68, statements: 84 }],
  // File import thresholds recalibrated in 2026-03.
  ['@brainstrike/file-import', { lines: 92, functions: 80, branches: 58, statements: 75 }],
  // UI package thresholds recalibrated in 2026-03.
  ['@brainstrike/ui', { lines: 90, functions: 74, branches: 62, statements: 75 }],
  // Token cache — elevated after token-utils-lite branch/path coverage improvements
  ['@brainstrike/token-cache', { lines: 92, functions: 92, branches: 62, statements: 82 }],
]);

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
      } catch {}
    }
    curr = path.dirname(curr);
  }
  return path.basename(fromDir);
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
    lines: { total: lnTot, covered: lnCov, pct: pct(lnCov, lnTot) },
    statements: { total: stTot, covered: stCov, pct: pct(stCov, stTot) },
    functions: { total: fnTot, covered: fnCov, pct: pct(fnCov, fnTot) },
    branches: { total: brTot, covered: brCov, pct: pct(brCov, brTot) },
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
  } catch {}
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
