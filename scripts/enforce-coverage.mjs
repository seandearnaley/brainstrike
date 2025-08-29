#!/usr/bin/env node
// Enforce per-package coverage thresholds using coverage-final.json from vitest v8 provider
// Usage: node scripts/enforce-coverage.mjs

import fs from 'node:fs';
import path from 'node:path';

const pkgs = [
  {
    name: '@brainstrike/file-explorer-ui',
    coveragePath: 'packages/file-explorer-ui/coverage/coverage-final.json',
    thresholds: { lines: 85, functions: 75, branches: 65, statements: 85 },
  },
  {
    name: '@brainstrike/app-shell',
    coveragePath: 'packages/app-shell/coverage/coverage-final.json',
    thresholds: { lines: 70, functions: 60, branches: 50, statements: 70 },
  },
  {
    name: '@brainstrike/desktop',
    coveragePath: 'apps/desktop/coverage/coverage-final.json',
    thresholds: { lines: 60, functions: 50, branches: 45, statements: 60 },
  },
];

function summarize(json) {
  let stTot = 0, stCov = 0, fnTot = 0, fnCov = 0, brTot = 0, brCov = 0, lnTot = 0, lnCov = 0;
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
      for (let l = start.line; l <= end.line; l++) lns.add(l);
    }
    lnTot += lns.size;
    const coveredLines = new Set();
    for (const [k, v] of Object.entries(file.s)) {
      if (v > 0) {
        const { start, end } = file.statementMap[k];
        for (let l = start.line; l <= end.line; l++) coveredLines.add(l);
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

let hasFailure = false;
for (const pkg of pkgs) {
  const p = path.resolve(pkg.coveragePath);
  if (!fs.existsSync(p)) {
    console.error(`❌ ${pkg.name}: coverage file not found at ${pkg.coveragePath}`);
    hasFailure = true;
    continue;
  }
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  const s = summarize(json);
  const checks = [
    ['lines', s.lines.pct, pkg.thresholds.lines],
    ['functions', s.functions.pct, pkg.thresholds.functions],
    ['branches', s.branches.pct, pkg.thresholds.branches],
    ['statements', s.statements.pct, pkg.thresholds.statements],
  ];
  let ok = true;
  for (const [key, pct, min] of checks) {
    if (pct + 1e-6 < min) {
      ok = false;
      hasFailure = true;
    }
  }
  const summary = `L ${formatPct(s.lines.pct)} | F ${formatPct(s.functions.pct)} | B ${formatPct(s.branches.pct)} | S ${formatPct(s.statements.pct)}`;
  if (ok) {
    console.log(`✅ ${pkg.name}: ${summary} (>= L${pkg.thresholds.lines} F${pkg.thresholds.functions} B${pkg.thresholds.branches} S${pkg.thresholds.statements})`);
  } else {
    console.error(`❌ ${pkg.name}: ${summary} is below thresholds (>= L${pkg.thresholds.lines} F${pkg.thresholds.functions} B${pkg.thresholds.branches} S${pkg.thresholds.statements})`);
  }
}

if (hasFailure) {
  process.exit(1);
}

console.log('All package coverage thresholds satisfied.');

