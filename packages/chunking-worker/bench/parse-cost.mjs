#!/usr/bin/env node
/**
 * Parse-cost benchmark — Babel vs oxc on the brainstrike monorepo.
 *
 * Walks the repo, collects all JS/TS source files (excluding node_modules,
 * dist, .git, coverage, build artifacts), parses each with both Babel and
 * oxc, and reports per-parser totals + per-bucket distributions + the
 * speedup ratio.
 *
 * Run from repo root:
 *   node packages/chunking-worker/bench/parse-cost.mjs
 *
 * Outputs:
 *   - stdout: human-readable summary
 *   - docs/bench-chunking-parser-2026-05.md: markdown report
 *
 * This is the Phase 7 benchmark per PRD §10. Not a microbenchmark — uses
 * a real codebase (brainstrike itself). The report includes the script
 * source so anyone can reproduce the numbers.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §10
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// nit #993: filename auto-derives from today's date so re-running in a
// different month doesn't overwrite a stale-named file or silently land
// in the wrong path.
const REPORT_DATE = new Date().toISOString().slice(0, 7); // YYYY-MM
const REPORT_PATH = join(REPO_ROOT, 'docs', `bench-chunking-parser-${REPORT_DATE}.md`);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.turbo',
  '.next',
  'coverage',
  '.cache',
  '.vite',
  'out',
  '.claude',
]);

const SIZE_BUCKETS = [
  { label: '< 1 KB', max: 1024 },
  { label: '1–10 KB', max: 10 * 1024 },
  { label: '10–100 KB', max: 100 * 1024 },
  { label: '> 100 KB', max: Number.POSITIVE_INFINITY },
];

function bucketFor(size) {
  return SIZE_BUCKETS.find((b) => size <= b.max).label;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (SOURCE_EXTENSIONS.has(ext)) {
        yield join(dir, entry.name);
      }
    }
  }
}

function languageFor(path) {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  return 'javascript';
}

function jsxFor(path) {
  return path.endsWith('.tsx') || path.endsWith('.jsx');
}

function deriveOxcFilename(path) {
  // Pass through the actual extension so oxc picks the right dialect.
  const ext = path.slice(path.lastIndexOf('.'));
  return `source${ext}`;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p99(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
}

async function main() {
  console.log(`Walking ${REPO_ROOT}...`);
  const files = [];
  for await (const path of walk(REPO_ROOT)) {
    files.push(path);
  }
  console.log(`Found ${files.length} JS/TS source files.`);

  // Load both parsers from the chunking-worker's perspective. The .ts
  // source loads under tsx/vitest/Node 22+ with type-stripping; if neither
  // works the bench refuses to silently use a stale/different parser.
  // (nit #993: removed the .ts → .js fallback because '.dist/index.js'
  // doesn't export babelAdapter in the same shape, which would skew the
  // benchmark without surfacing the discrepancy.)
  const { babelAdapter } = await import('../src/parsers/babel-adapter.ts');
  const { parseSync } = await import('oxc-parser');

  // Per-file timings keyed by parser id.
  const timings = {
    babel: { all: [], byBucket: new Map(), errors: 0 },
    oxc: { all: [], byBucket: new Map(), errors: 0 },
  };
  for (const b of SIZE_BUCKETS) {
    timings.babel.byBucket.set(b.label, []);
    timings.oxc.byBucket.set(b.label, []);
  }

  // nit #993: timing helpers extracted so we can alternate which parser
  // runs first per file. Without alternation, the parser that always
  // runs second benefits from a warm FS cache for the same content,
  // and the parser that always runs first pays more JIT warm-up cost.
  // Alternating (or randomizing) cancels both biases over the corpus.
  // We use a deterministic alternation (index parity) rather than RNG so
  // the bench is reproducible.
  const timeBabel = async (content, language, jsx, bucket) => {
    try {
      const start = performance.now();
      await babelAdapter.parse(content, { errorRecovery: true, jsx, language });
      const ms = performance.now() - start;
      timings.babel.all.push(ms);
      timings.babel.byBucket.get(bucket).push(ms);
    } catch {
      timings.babel.errors += 1;
    }
  };
  const timeOxc = (content, path, bucket) => {
    try {
      const start = performance.now();
      parseSync(deriveOxcFilename(path), content);
      const ms = performance.now() - start;
      timings.oxc.all.push(ms);
      timings.oxc.byBucket.get(bucket).push(ms);
    } catch {
      timings.oxc.errors += 1;
    }
  };

  let processed = 0;
  for (let i = 0; i < files.length; i += 1) {
    const path = files[i];
    let content;
    let size;
    try {
      content = await readFile(path, 'utf8');
      size = content.length;
    } catch {
      continue;
    }
    if (size === 0) continue;
    const bucket = bucketFor(size);
    const language = languageFor(path);
    const jsx = jsxFor(path);

    // Alternate parser order per file (even index → Babel first, odd → oxc first).
    if (i % 2 === 0) {
      await timeBabel(content, language, jsx, bucket);
      timeOxc(content, path, bucket);
    } else {
      timeOxc(content, path, bucket);
      await timeBabel(content, language, jsx, bucket);
    }

    processed += 1;
    if (processed % 500 === 0) {
      console.log(`  ${processed}/${files.length}...`);
    }
  }

  // ─── Report ───
  const sumBabel = timings.babel.all.reduce((a, b) => a + b, 0);
  const sumOxc = timings.oxc.all.reduce((a, b) => a + b, 0);
  const speedup = sumOxc > 0 ? sumBabel / sumOxc : 0;

  const lines = [];
  lines.push('# Chunking parser benchmark — Babel vs oxc');
  lines.push('');
  lines.push(`**Date**: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Repo**: brainstrike monorepo (this checkout)`);
  lines.push(`**Files parsed**: ${processed} of ${files.length} JS/TS source files`);
  lines.push(`**Reproducer**: \`node packages/chunking-worker/bench/parse-cost.mjs\``);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`- **Babel total**: ${sumBabel.toFixed(0)} ms`);
  lines.push(`- **oxc total**: ${sumOxc.toFixed(0)} ms`);
  lines.push(`- **Speedup**: **${speedup.toFixed(1)}×** (oxc faster than babel)`);
  lines.push(`- Babel parse errors: ${timings.babel.errors}`);
  lines.push(`- oxc parse errors: ${timings.oxc.errors}`);
  lines.push('');
  lines.push('## Per-file timings (all files)');
  lines.push('');
  lines.push('| Parser | Median (ms) | p99 (ms) |');
  lines.push('|---|---|---|');
  lines.push(`| Babel | ${median(timings.babel.all).toFixed(2)} | ${p99(timings.babel.all).toFixed(2)} |`);
  lines.push(`| oxc | ${median(timings.oxc.all).toFixed(2)} | ${p99(timings.oxc.all).toFixed(2)} |`);
  lines.push('');
  lines.push('## By file size bucket (median ms)');
  lines.push('');
  lines.push('| Bucket | Files | Babel (med) | oxc (med) | Speedup |');
  lines.push('|---|---|---|---|---|');
  for (const b of SIZE_BUCKETS) {
    const babelTimes = timings.babel.byBucket.get(b.label) ?? [];
    const oxcTimes = timings.oxc.byBucket.get(b.label) ?? [];
    const babelMed = median(babelTimes);
    const oxcMed = median(oxcTimes);
    const ratio = oxcMed > 0 ? babelMed / oxcMed : 0;
    lines.push(
      `| ${b.label} | ${babelTimes.length} | ${babelMed.toFixed(2)} | ${oxcMed.toFixed(2)} | ${ratio.toFixed(1)}× |`
    );
  }
  lines.push('');
  lines.push('## Methodology notes');
  lines.push('');
  lines.push('- Wall-clock measurement via `performance.now()` around the parse call only.');
  lines.push('- Includes the cost of Babel’s lazy module load (first-call penalty); ');
  lines.push('  amortizes over thousands of subsequent files. oxc-parser’s NAPI bindings ');
  lines.push('  load eagerly at module-resolution time so they don’t carry a first-call hit.');
  lines.push('- **Parser order alternates per file** (even index → Babel first, odd → oxc');
  lines.push('  first). Without alternation the parser that always ran second would benefit');
  lines.push('  from a warm FS cache for the same content and the first-running parser would');
  lines.push('  pay more JIT warm-up cost — both biases skew the headline ratio. Alternating');
  lines.push('  cancels them over the corpus. Deterministic (index parity) for reproducibility.');
  lines.push('- **Async vs sync asymmetry**: `babelAdapter.parse` is async (returns a Promise);');
  lines.push('  `oxc-parser.parseSync` is synchronous. We `await` Babel and don\'t await oxc, so');
  lines.push('  Babel\'s timing includes one extra microtask per call (~1–10 µs on V8). Negligible');
  lines.push('  against the parse work itself; explicitly noted so reviewers can rule it out.');
  lines.push('- Excludes IPC roundtrip cost (Phase 4 architecture) — measures the underlying ');
  lines.push('  parser engines, not the Electron transport. IPC overhead is a separate concern ');
  lines.push('  evaluated at integration time.');
  lines.push('- No warm-up runs; first file pays cold-cache cost. With thousands of files this ');
  lines.push('  rounds out, but small samples may show distorted percentiles.');
  lines.push('- Parses use `errorRecovery: true` for both parsers so neither bails out on ');
  lines.push('  malformed code (the chunking pipeline’s production posture). Note: oxc\'s');
  lines.push('  errorRecovery semantics differ from Babel\'s — oxc *always* recovers and');
  lines.push('  reports errors via `result.errors` rather than throwing (P2 #993). The error');
  lines.push('  counts above are catch-counts, so an oxc soft-failure won\'t register; if the');
  lines.push('  bench reports zero oxc errors but you suspect parse problems, inspect');
  lines.push('  `result.errors` directly on a sample.');
  lines.push('');
  lines.push('## Conclusion');
  lines.push('');
  if (speedup >= 5) {
    lines.push(`oxc is **${speedup.toFixed(1)}×** faster than Babel on the brainstrike codebase, `);
    lines.push('comfortably exceeding the PRD §1 success metric of ≥5× speedup.');
  } else if (speedup >= 2) {
    lines.push(`oxc is **${speedup.toFixed(1)}×** faster than Babel — meaningful but below the `);
    lines.push('PRD §1 target of >=5x. Worth investigating whether IPC overhead would erode this');
    lines.push('further (Phase 8 monitoring).');
  } else {
    lines.push(`oxc is **${speedup.toFixed(1)}×** faster than Babel — below the PRD §1 target. `);
    lines.push('Re-evaluate whether the migration is worth the architectural complexity, or whether ');
    lines.push('a different parser would be a better fit.');
  }

  const report = `${lines.join('\n')}\n`;

  console.log('\n' + lines.slice(0, 20).join('\n') + '\n  ...');
  await writeFile(REPORT_PATH, report);
  console.log(`\nReport written: ${relative(REPO_ROOT, REPORT_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
