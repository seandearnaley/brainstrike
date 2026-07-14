#!/usr/bin/env node
// scripts/ts7-parity-check.mjs
//
// Verify-then-adopt guard for the TypeScript 7 native compiler (Series C, C4).
//
// Discovers every `tsc --noEmit [--project <file>]` invocation reachable from
// each workspace package's `type-check` script (following `pnpm <script>`
// chains), runs each invocation under BOTH the repo's resolved TypeScript 6.x
// (`node_modules/.bin/tsc`, the real library used by every API consumer) and
// an explicitly-pinned TypeScript 7 native binary, and diffs the normalized
// diagnostic sets (file:line:col:TSxxxx). Prints the symmetric difference and
// exits non-zero on ANY mismatch — per the global constraint, parity failure
// means the PR becomes a findings report, not a compiler switch.
//
// The TS7 binary path is NEVER resolved through `node_modules/.bin` — see
// docs/series-c-ts7-parity-findings.md for why (object-form `bin` collision
// between typescript@6.x and typescript@7.x sharing the same `tsc` bin name).
// It must be passed explicitly via --ts7-bin=<path-to-tsc> or the
// TS7_TSC_BIN env var, and this script throws if it is missing or unusable —
// no silent fallback to a guessed path.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIAGNOSTIC_RE = /error TS\d+/;
// Matches "path(line,col): error TSxxxx: message" (tsc --pretty false format).
const LOCATION_RE = /^(.*?)\((\d+),(\d+)\): (error TS\d+)/;

function parseArgs(argv) {
  const options = { filter: null, ts6Bin: null, ts7Bin: null };
  for (const arg of argv) {
    if (arg.startsWith('--ts7-bin=')) {
      options.ts7Bin = arg.slice('--ts7-bin='.length);
    } else if (arg.startsWith('--ts6-bin=')) {
      options.ts6Bin = arg.slice('--ts6-bin='.length);
    } else if (arg.startsWith('--filter=')) {
      options.filter = arg.slice('--filter='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function resolveTs6Bin(explicit) {
  const candidate = explicit ?? path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `TypeScript 6 tsc binary not found at ${candidate}. Run "pnpm install" first, or pass --ts6-bin=<path>.`
    );
  }
  return candidate;
}

function resolveTs7Bin(explicit) {
  const candidate = explicit ?? process.env.TS7_TSC_BIN;
  if (!candidate) {
    throw new Error(
      'TypeScript 7 native tsc binary path was not provided. Pass --ts7-bin=<path-to-tsc> or set TS7_TSC_BIN. ' +
        'This script never guesses a path (no silent fallback) because the native package is not resolved via ' +
        'node_modules/.bin (see docs/series-c-ts7-parity-findings.md).'
    );
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`TypeScript 7 tsc binary not found at ${candidate}.`);
  }
  return candidate;
}

// Reads a package.json's scripts map, keyed by package directory (relative to repo root).
function loadPackageManifests() {
  const manifests = [];
  const roots = ['apps', 'packages', 'packages/config'];
  for (const root of roots) {
    const rootDir = path.join(REPO_ROOT, root);
    if (!fs.existsSync(rootDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgDir = path.join(rootDir, entry.name);
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) {
        continue;
      }
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      manifests.push({
        dir: pkgDir,
        name: pkgJson.name ?? entry.name,
        scripts: pkgJson.scripts ?? {},
      });
    }
  }
  return manifests;
}

// Splits a package.json script command on top-level "&&" (no nested subshells
// in this repo's scripts, so a plain split is sufficient and avoids adding a
// shell-parsing dependency).
function splitChain(command) {
  return command.split('&&').map((part) => part.trim());
}

// Flattens a package's `type-check` script into an ordered list of concrete
// shell command strings, following `pnpm <script-name>` references within the
// SAME package (e.g. apps/desktop's `type-check` -> `type-check:main` +
// `type-check:e2e`).
function flattenScript(manifest, scriptName, seen = new Set()) {
  const key = `${manifest.dir}#${scriptName}`;
  if (seen.has(key)) {
    throw new Error(`Cycle detected resolving script chain at ${key}`);
  }
  seen.add(key);

  const command = manifest.scripts[scriptName];
  if (!command) {
    throw new Error(`Package ${manifest.name} has no script named "${scriptName}"`);
  }

  const out = [];
  for (const part of splitChain(command)) {
    const pnpmMatch = part.match(/^pnpm (?:run )?([\w:-]+)$/);
    if (pnpmMatch) {
      out.push(...flattenScript(manifest, pnpmMatch[1], seen));
    } else {
      out.push(part);
    }
  }
  return out;
}

// Extracts { project } for each `tsc --noEmit [--project <file>]` command.
// Non-tsc commands and `tsc --build` commands are returned with a `kind` tag
// so the caller can report/skip them explicitly instead of silently dropping
// them.
function classifyCommand(command) {
  if (!command.startsWith('tsc')) {
    return { command, kind: 'non-tsc' };
  }
  if (/(^|\s)--build(\s|$)/.test(command) || /(^|\s)-b(\s|$)/.test(command)) {
    return { command, kind: 'build' };
  }
  if (!/--noEmit\b/.test(command)) {
    return { command, kind: 'unrecognized' };
  }
  const projectMatch = command.match(/--project\s+(\S+)/);
  return { command, kind: 'noEmit', project: projectMatch ? projectMatch[1] : null };
}

function runTsc(bin, cwd, project) {
  const args = project
    ? ['--noEmit', '--pretty', 'false', '--project', project]
    : ['--noEmit', '--pretty', 'false'];
  const start = performance.now();
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  const elapsedMs = performance.now() - start;
  if (result.error) {
    throw new Error(`Failed to spawn ${bin} in ${cwd}: ${result.error.message}`);
  }
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const lines = combined.split('\n').filter((line) => DIAGNOSTIC_RE.test(line));
  return { elapsedMs, exitCode: result.status, lines };
}

// Normalizes a raw diagnostic line to a "relpath:line:col:TSxxxx" tuple. Lines
// that don't match the expected tsc --pretty false shape are kept verbatim
// (prefixed) so they are never silently dropped from the comparison.
function normalizeDiagnostic(line, cwd) {
  const match = line.match(LOCATION_RE);
  if (!match) {
    return `UNPARSED|${line.trim()}`;
  }
  const [, filePath, lineNo, colNo, code] = match;
  const absPath = path.resolve(cwd, filePath);
  const relPath = path.relative(REPO_ROOT, absPath);
  const codeOnly = code.replace('error ', '');
  return `${relPath}:${lineNo}:${colNo}:${codeOnly}`;
}

function diffSets(a, b) {
  const onlyA = [...a].filter((x) => !b.has(x)).sort();
  const onlyB = [...b].filter((x) => !a.has(x)).sort();
  return { onlyA, onlyB };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const ts6Bin = resolveTs6Bin(options.ts6Bin);
  const ts7Bin = resolveTs7Bin(options.ts7Bin);

  console.log(`TS6 bin: ${ts6Bin}`);
  console.log(`TS7 bin: ${ts7Bin}`);
  console.log('');

  const manifests = loadPackageManifests().filter((m) => 'type-check' in m.scripts);

  const results = [];
  let mismatchCount = 0;
  let skippedCount = 0;

  for (const manifest of manifests) {
    if (
      options.filter &&
      manifest.name !== options.filter &&
      !manifest.dir.endsWith(`/${options.filter}`)
    ) {
      continue;
    }

    const commands = flattenScript(manifest, 'type-check');
    for (const command of commands) {
      const classified = classifyCommand(command);
      const relDir = path.relative(REPO_ROOT, manifest.dir);

      if (classified.kind !== 'noEmit') {
        skippedCount += 1;
        console.log(
          `SKIP  [${relDir}] "${command}" (${classified.kind}, not a --noEmit diagnostic run)`
        );
        continue;
      }

      const label = `${relDir}${classified.project ? ` --project ${classified.project}` : ''}`;
      process.stdout.write(`RUN   [${label}] ... `);

      const ts6 = runTsc(ts6Bin, manifest.dir, classified.project);
      const ts7 = runTsc(ts7Bin, manifest.dir, classified.project);

      const ts6Set = new Set(ts6.lines.map((l) => normalizeDiagnostic(l, manifest.dir)));
      const ts7Set = new Set(ts7.lines.map((l) => normalizeDiagnostic(l, manifest.dir)));
      const { onlyA, onlyB } = diffSets(ts6Set, ts7Set);
      const matched = onlyA.length === 0 && onlyB.length === 0;

      console.log(
        `${matched ? 'PARITY' : 'MISMATCH'}  ts6=${ts6Set.size} diag/${ts6.elapsedMs.toFixed(0)}ms  ts7=${ts7Set.size} diag/${ts7.elapsedMs.toFixed(0)}ms`
      );

      if (!matched) {
        mismatchCount += 1;
        console.log(`  only in TS6 (${onlyA.length}):`);
        for (const line of onlyA) {
          console.log(`    - ${line}`);
        }
        console.log(`  only in TS7 (${onlyB.length}):`);
        for (const line of onlyB) {
          console.log(`    + ${line}`);
        }
      }

      results.push({
        label,
        matched,
        onlyInTs6: onlyA,
        onlyInTs7: onlyB,
        ts6DiagCount: ts6Set.size,
        ts6ElapsedMs: ts6.elapsedMs,
        ts7DiagCount: ts7Set.size,
        ts7ElapsedMs: ts7.elapsedMs,
      });
    }
  }

  const totalTs6Ms = results.reduce((sum, r) => sum + r.ts6ElapsedMs, 0);
  const totalTs7Ms = results.reduce((sum, r) => sum + r.ts7ElapsedMs, 0);

  console.log('');
  console.log('=== Summary ===');
  console.log(`Projects compared: ${results.length}`);
  console.log(`Projects skipped (non --noEmit): ${skippedCount}`);
  console.log(`Mismatches: ${mismatchCount}`);
  console.log(
    `Total TS6 wall time (sum of per-project spawns): ${(totalTs6Ms / 1000).toFixed(1)}s`
  );
  console.log(
    `Total TS7 wall time (sum of per-project spawns): ${(totalTs7Ms / 1000).toFixed(1)}s`
  );
  if (totalTs7Ms > 0) {
    console.log(`Speedup: ${(totalTs6Ms / totalTs7Ms).toFixed(2)}x`);
  }

  if (mismatchCount > 0) {
    console.log('');
    console.log(
      'PARITY FAILED. Do not switch the type-check binary. See docs/series-c-ts7-parity-findings.md.'
    );
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('PARITY HOLDS across all compared projects.');
}

main();
