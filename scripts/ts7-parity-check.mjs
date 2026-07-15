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
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIAGNOSTIC_RE = /error TS\d+/;
// Matches "path(line,col): error TSxxxx: message" (tsc --pretty false format).
const LOCATION_RE = /^(.*?)\((\d+),(\d+)\): (error TS\d+)/;

// Discovery floors. A guard that compares NOTHING and reports "parity holds" is
// a vacuous green — the exact silent-degradation failure this script exists to
// prevent. Discovery is dynamic (it walks apps/ + packages/ and parses each
// `type-check` script), so a repo restructuring, a relocated copy of this
// script, or a --filter that matches nothing would otherwise sail through with
// mismatchCount === 0. These floors turn all of those into a loud throw.
//
// Values are deliberately well below the real counts at time of writing (39
// packages with a `type-check` script; 67 comparable --noEmit invocations) so
// ordinary churn doesn't trip them, while a collapse to near-zero does. If a
// legitimate restructuring drops the real count below a floor, LOWER THE FLOOR
// in the same commit — do not delete the check.
const MIN_TYPECHECK_PACKAGES = 30;
const MIN_COMPARED_PROJECTS = 55;

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

// Reads `tsc --version` ("Version 7.0.2") and returns the major as a number.
// Throws rather than returning a sentinel: a binary whose version we cannot
// read must never be silently treated as either compiler.
function readTscMajor(bin) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`Failed to run "${bin} --version": ${result.error.message}`);
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = output.match(/Version\s+(\d+)\.\d+\.\d+/);
  if (!match) {
    throw new Error(`Could not parse a version out of "${bin} --version" (got: ${output.trim()}).`);
  }
  return Number(match[1]);
}

// Asserts a binary is the major we think it is. This is not paranoia: adding
// TS7 to the workspace under ANY name rewrites the ROOT node_modules/.bin/tsc
// to the 7.x binary (see the ".bin/tsc collision" section of
// docs/series-c-ts7-parity-findings.md) — which is exactly this function's
// default TS6 candidate. Without this check, running the guard in a tree that
// has TS7 installed would compare TS7 against TS7 and report parity for
// everything. That is the same vacuous-green class as an empty discovery set.
function assertMajor(bin, expectedMajor, label) {
  const actualMajor = readTscMajor(bin);
  if (actualMajor !== expectedMajor) {
    throw new Error(
      `${label} binary at ${bin} reports major version ${actualMajor}, expected ${expectedMajor}. ` +
        'Refusing to run: comparing a compiler against itself would report parity vacuously. ' +
        (expectedMajor === 6
          ? 'If TypeScript 7 is installed in this workspace it will have taken over the root ' +
            'node_modules/.bin/tsc — pass --ts6-bin=<path to a real 6.x tsc> explicitly.'
          : 'Pass --ts7-bin=<path to a real 7.x tsc>.')
    );
  }
  return actualMajor;
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
//
// `inProgress` tracks the CURRENT RECURSION PATH, not every script ever seen.
// The distinction matters: a diamond (`type-check` -> a -> shared, and
// `type-check` -> b -> shared) legitimately reaches `shared` twice via two
// sibling branches, and visited-semantics would misreport that as a cycle. The
// `finally` removes the key on the way out, so only a script that is its own
// ancestor — a real cycle — is still present when re-entered.
export function flattenScript(manifest, scriptName, inProgress = new Set()) {
  const key = `${manifest.dir}#${scriptName}`;
  if (inProgress.has(key)) {
    throw new Error(`Cycle detected resolving script chain at ${key}`);
  }

  const command = manifest.scripts[scriptName];
  if (!command) {
    throw new Error(`Package ${manifest.name} has no script named "${scriptName}"`);
  }

  inProgress.add(key);
  try {
    const out = [];
    for (const part of splitChain(command)) {
      const pnpmMatch = part.match(/^pnpm (?:run )?([\w:-]+)$/);
      if (pnpmMatch) {
        out.push(...flattenScript(manifest, pnpmMatch[1], inProgress));
      } else {
        out.push(part);
      }
    }
    return out;
  } finally {
    inProgress.delete(key);
  }
}

// tsc accepts the project path as `--project <file>`, `--project=<file>`,
// `-p <file>`, or `-p=<file>`. All four must be recognized: a project flag we
// fail to parse would leave `project: null`, and runTsc would then silently
// check the package's DEFAULT tsconfig.json under BOTH compilers — reporting
// parity while verifying a project CI never runs. That is the exact
// silent-substitution class this script exists to catch, so an unparseable
// project flag throws instead (NO SILENT FALLBACKS).
//
// `-p` cannot collide with `--pretty`: the `(?:^|\s)` prefix means the `-p`
// inside `--pretty` (preceded by `-`, not whitespace) never matches.
const PROJECT_VALUE_RE = /(?:^|\s)(?:--project|-p)(?:\s+|=)(\S+)/;
const PROJECT_FLAG_PRESENT_RE = /(?:^|\s)(?:--project|-p)(?:\s|=|$)/;

export function extractProject(command) {
  const match = command.match(PROJECT_VALUE_RE);
  if (match) {
    return match[1];
  }
  if (PROJECT_FLAG_PRESENT_RE.test(command)) {
    throw new Error(
      `Could not parse a project path out of the tsc command: "${command}". ` +
        'A project flag is present but its value was not extractable. Refusing to fall back to the ' +
        'default tsconfig.json, which would compare the wrong project under both compilers and ' +
        'report parity vacuously.'
    );
  }
  return null;
}

// Extracts { project } for each `tsc --noEmit [--project <file>]` command.
// Non-tsc commands and `tsc --build` commands are returned with a `kind` tag
// so the caller can report/skip them explicitly instead of silently dropping
// them.
export function classifyCommand(command) {
  if (!command.startsWith('tsc')) {
    return { command, kind: 'non-tsc' };
  }
  if (/(^|\s)--build(\s|$)/.test(command) || /(^|\s)-b(\s|$)/.test(command)) {
    return { command, kind: 'build' };
  }
  if (!/--noEmit\b/.test(command)) {
    return { command, kind: 'unrecognized' };
  }
  return { command, kind: 'noEmit', project: extractProject(command) };
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

  // Each side must actually BE the compiler it claims to be (see assertMajor).
  const ts6Major = assertMajor(ts6Bin, 6, 'TypeScript 6');
  const ts7Major = assertMajor(ts7Bin, 7, 'TypeScript 7');

  console.log(`TS6 bin: ${ts6Bin} (major ${ts6Major}, verified)`);
  console.log(`TS7 bin: ${ts7Bin} (major ${ts7Major}, verified)`);
  console.log('');

  const manifests = loadPackageManifests().filter((m) => 'type-check' in m.scripts);

  // Vacuous-pass guard #1: discovery itself must find a plausible workspace.
  if (manifests.length < MIN_TYPECHECK_PACKAGES) {
    throw new Error(
      `Discovery found only ${manifests.length} package(s) with a "type-check" script under ${REPO_ROOT}, ` +
        `below the floor of ${MIN_TYPECHECK_PACKAGES}. Refusing to report parity over a near-empty set. ` +
        'Either this script is not running against the brainstrike workspace, or the workspace layout changed ' +
        '(if the drop is legitimate, lower MIN_TYPECHECK_PACKAGES in the same commit).'
    );
  }

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

  // Vacuous-pass guard #2: a run must actually have COMPARED something. An
  // unfiltered run is held to the full-sweep floor; a --filter run only has to
  // have matched a package and produced at least one comparison (a filter that
  // matches nothing is itself an error, not a pass).
  const comparedFloor = options.filter ? 1 : MIN_COMPARED_PROJECTS;
  if (results.length < comparedFloor) {
    throw new Error(
      `Compared only ${results.length} project(s), below the floor of ${comparedFloor}` +
        (options.filter ? ` for --filter=${options.filter}` : '') +
        '. Refusing to report parity over a near-empty set. ' +
        (options.filter
          ? 'Check that the filter matches a package with a "type-check" script.'
          : 'The type-check script shapes may have changed such that they are no longer recognized as ' +
            '--noEmit runs (if the drop is legitimate, lower MIN_COMPARED_PROJECTS in the same commit).')
    );
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

// Only run when invoked directly, so the parsing helpers above can be imported
// by scripts/__tests__/ts7-parity-check.test.mjs without executing a full
// 67-project parity sweep as an import side effect (same convention as
// scripts/run-turbo-command.mjs).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
