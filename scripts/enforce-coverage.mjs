#!/usr/bin/env node
// Enforce per-package coverage thresholds using coverage-final.json from vitest v8 provider
// Usage: node scripts/enforce-coverage.mjs

import fs from 'node:fs';
import path from 'node:path';

// Default thresholds applied to all packages unless overridden below.
// Keep these aligned with root vitest.config.ts global thresholds.
const DEFAULT_THRESHOLDS = { lines: 70, functions: 60, branches: 60, statements: 70 };

// Optional strict overrides for key packages.
const OVERRIDES = new Map([
  [
    '@brainstrike/file-explorer-ui',
    { lines: 86.5, functions: 84, branches: 81.5, statements: 86.5 },
  ],
  [
    '@brainstrike/app-shell',
    { lines: 81.5, functions: 79, branches: 83, statements: 81.5 },
  ],
  [
    '@brainstrike/desktop',
    { lines: 91, functions: 79, branches: 90.5, statements: 91 },
  ],
]);

// Discover all coverage files under packages/* and apps/*
function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function findPkgName(fromDir) {
  let curr = path.resolve(fromDir);
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(curr, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name;
        if (name) return name;
      } catch {}
    }
    curr = path.dirname(curr);
  }
  return path.basename(fromDir);
}

const coverageFiles = [];
for (const root of ['packages', 'apps']) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    if (file.endsWith(path.join('coverage', 'coverage-final.json'))) coverageFiles.push(file);
  }
}

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

if (coverageFiles.length === 0) {
  console.error('❌ No coverage files found under packages/* or apps/*');
  process.exit(1);
}

let hasFailure = false;
for (const file of coverageFiles.sort()) {
  const pkgDir = path.dirname(path.dirname(file));
  const pkgName = findPkgName(pkgDir);
  const thresholds = OVERRIDES.get(pkgName) ?? DEFAULT_THRESHOLDS;

  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = summarize(json);
  const checks = [
    ['lines', s.lines.pct, thresholds.lines],
    ['functions', s.functions.pct, thresholds.functions],
    ['branches', s.branches.pct, thresholds.branches],
    ['statements', s.statements.pct, thresholds.statements],
  ];
  let ok = true;
  for (const [key, pct, min] of checks) {
    if (pct + 1e-6 < min) ok = false;
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

if (hasFailure) process.exit(1);
console.log('All package coverage thresholds satisfied.');
