#!/usr/bin/env node
// scripts/ts7-parity-check.mjs
//
// Verify-then-adopt guard for the TypeScript 7 native compiler (Series C, C4).
//
// Discovers every `tsc --noEmit [--project <file>]` invocation reachable from
// each workspace package's `type-check` script (following `pnpm <script>`
// chains), runs each invocation under BOTH compilers in the official
// side-by-side installation (`node_modules/.bin/tsc6` for the compatibility
// compiler and `node_modules/.bin/tsc` for the native compiler), and diffs the
// normalized diagnostic sets (file:line:col:TSxxxx). Prints the symmetric
// difference and exits non-zero on ANY mismatch. The same stop condition
// applies to initial adoption and every later native/compatibility compiler
// upgrade.
//
// Explicit paths remain available for compiler-upgrade probes. Defaults are
// deliberately the two checked-in workspace shims, and each side's major is
// verified before discovery so broken alias wiring cannot compare one compiler
// against itself and report a vacuous green.

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
// Values are deliberately well below the real counts at time of writing (42
// packages with a tsc-backed `type-check` script; 77 comparable --noEmit
// invocations) so ordinary churn doesn't trip them, while a collapse to
// near-zero does. If a legitimate restructuring drops the real count below a
// floor, LOWER THE FLOOR in the same commit — do not delete the check.
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

// Asserts a binary is the major we think it is. This is not paranoia: before
// the official `@typescript/typescript6` compatibility package provided the
// `tsc6` bin, aliasing two `typescript` packages made both candidates resolve
// to the same `tsc` bin. Without this check, broken workspace alias wiring can
// still compare one compiler against itself and report parity for everything.
// That is the same vacuous-green class as an empty discovery set.
function assertMajor(bin, expectedMajor, label) {
  const actualMajor = readTscMajor(bin);
  if (actualMajor !== expectedMajor) {
    throw new Error(
      `${label} binary at ${bin} reports major version ${actualMajor}, expected ${expectedMajor}. ` +
        'Refusing to run: comparing a compiler against itself would report parity vacuously. ' +
        (expectedMajor === 6
          ? 'The official compatibility compiler must expose tsc6; repair the workspace aliases ' +
            'or pass --ts6-bin=<path to a real 6.x tsc> explicitly.'
          : 'Pass --ts7-bin=<path to a real 7.x tsc>.')
    );
  }
  return actualMajor;
}

function resolveTs6Bin(explicit) {
  const candidate = explicit ?? path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc6');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `TypeScript 6 tsc binary not found at ${candidate}. Run "pnpm install" first, or pass --ts6-bin=<path>.`
    );
  }
  return candidate;
}

function resolveTs7Bin(explicit) {
  const candidate =
    explicit ?? process.env.TS7_TSC_BIN ?? path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `TypeScript 7 tsc binary not found at ${candidate}. Run "pnpm install" first, or pass --ts7-bin=<path>.`
    );
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
// `type-check:test` + `type-check:e2e`).
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
  if (/^node\s+\S*verify-test-tsconfig-program\.mjs(?:\s|$)/u.test(command)) {
    const project = extractProject(command);
    if (!project) {
      throw new Error(
        `The test-tsconfig verifier command has no project: "${command}". Refusing to compare a default project the verifier does not run.`
      );
    }
    return { command, kind: 'noEmit', project };
  }
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

// The closed set of per-command outcomes. THE central invariant of this script:
// "PARITY HOLDS" is renderable only when every recorded outcome is
// affirmatively MATCHED (or OUT_OF_SCOPE — a command no TypeScript version can
// affect). See canClaimParity.
//
// Why a closed set rather than a mismatch counter: every vacuous-pass hole
// found in review so far was the same bug — the verdict was derived from the
// ABSENCE of a counted mismatch, so anything that produced no count (an empty
// discovery set, comparing a binary against itself, a skipped build command, a
// compiler crash emitting no diagnostics) silently rendered as agreement.
// Absence of evidence was being reported as evidence of absence. Making every
// discovered command produce an explicit outcome, and requiring ALL of them to
// be MATCHED, makes "we did not actually verify this" structurally impossible
// to render as parity — instead of patching each new vector as it is found.
export const OUTCOME = {
  ERROR: 'error',
  MATCHED: 'matched',
  MISMATCH: 'mismatch',
  NOT_COMPARED: 'not-compared',
  OUT_OF_SCOPE: 'out-of-scope',
};

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
  return {
    elapsedMs,
    exitCode: result.status,
    lines,
    output: combined.trim(),
    signal: result.signal ?? null,
  };
}

// tsc exit codes: 0 = Success; 1 = DiagnosticsPresent_OutputsSkipped;
// 2 = DiagnosticsPresent_OutputsGenerated. Anything non-zero means the compiler
// reported diagnostics, which is the only distinction that carries pass/fail
// meaning to a `&&` chain or a CI step.
export function succeeded(run) {
  return run.exitCode === 0;
}

// Detects a run whose exit status is not explicable by its parsed diagnostics.
// Without this, a compiler that dies without printing a single "error TSxxxx"
// line — native crash, signal, fatal CLI/runtime failure — yields an EMPTY
// diagnostic set, which compares equal to the other side's empty set and reads
// as agreement. A crashing compiler must never look like a passing one.
export function evaluateRun(label, run) {
  if (run.signal) {
    return `${label} was terminated by signal ${run.signal}`;
  }
  if (run.exitCode === null || run.exitCode === undefined) {
    return `${label} exited without a status code`;
  }
  if (run.exitCode !== 0 && run.diagnostics.size === 0) {
    return (
      `${label} exited ${run.exitCode} but produced no parsable diagnostics ` +
      `(likely a crash or fatal CLI error, not a type error). Raw output: ${
        run.output ? JSON.stringify(run.output.slice(0, 300)) : '<empty>'
      }`
    );
  }
  if (run.exitCode === 0 && run.diagnostics.size > 0) {
    return `${label} exited 0 despite reporting ${run.diagnostics.size} diagnostic(s)`;
  }
  return null;
}

// Compares two runs of the SAME project. Exit status is part of the comparison,
// not just the diagnostic sets.
export function compareRuns(ts6, ts7) {
  const errors = [evaluateRun('TS6', ts6), evaluateRun('TS7', ts7)].filter((e) => e !== null);
  if (errors.length > 0) {
    return { errors, onlyInTs6: [], onlyInTs7: [], outcome: OUTCOME.ERROR };
  }

  const onlyInTs6 = [...ts6.diagnostics].filter((d) => !ts7.diagnostics.has(d)).sort();
  const onlyInTs7 = [...ts7.diagnostics].filter((d) => !ts6.diagnostics.has(d)).sort();
  if (onlyInTs6.length > 0 || onlyInTs7.length > 0) {
    return { errors: [], onlyInTs6, onlyInTs7, outcome: OUTCOME.MISMATCH };
  }
  // Compare the exit-status EQUIVALENCE CLASS (succeeded vs reported
  // diagnostics), not the raw integer. Raw equality is unsound here, verified:
  // tsc's `1` (DiagnosticsPresent_OutputsSkipped) and `2`
  // (DiagnosticsPresent_OutputsGenerated) both mean "diagnostics present", and
  // TS6 flips between them for a composite project depending on whether that
  // run happened to (re)write dist/tsconfig.tsbuildinfo — exit 2 on the first
  // run from a clean state, exit 1 on every run after, while TS7 is stably 1.
  // That is a stateful artifact of tsbuildinfo freshness, not a semantic
  // divergence, and comparing raw codes reports it as a flaky mismatch whose
  // result depends on what ran before it.
  if (succeeded(ts6) !== succeeded(ts7)) {
    return {
      errors: [
        `exit status class differs with identical diagnostics: TS6=${ts6.exitCode} (${
          succeeded(ts6) ? 'success' : 'diagnostics'
        }) TS7=${ts7.exitCode} (${succeeded(ts7) ? 'success' : 'diagnostics'})`,
      ],
      onlyInTs6: [],
      onlyInTs7: [],
      outcome: OUTCOME.MISMATCH,
    };
  }
  return { errors: [], onlyInTs6: [], onlyInTs7: [], outcome: OUTCOME.MATCHED };
}

// The single gate. Parity requires POSITIVE evidence for every command:
// an empty result set cannot pass, and any outcome that is not MATCHED (or
// OUT_OF_SCOPE) blocks the claim.
export function canClaimParity(results) {
  if (results.length === 0) {
    return false;
  }
  return results.every((r) => r.outcome === OUTCOME.MATCHED || r.outcome === OUTCOME.OUT_OF_SCOPE);
}

// Maps a classified command to the outcome it gets when we do NOT run it.
// `non-tsc` is genuinely out of scope: `node --check index.cjs` cannot change
// behaviour based on which TypeScript version is installed. A `tsc` invocation
// we cannot compare is NOT out of scope — it is unverified, and blocks parity.
export function outcomeForUncomparedKind(kind) {
  return kind === 'non-tsc' ? OUTCOME.OUT_OF_SCOPE : OUTCOME.NOT_COMPARED;
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

      // Every discovered command produces a result — including the ones we do
      // not run. A command we skip must still be visible to the verdict, or
      // "not verified" silently becomes "verified fine".
      if (classified.kind !== 'noEmit') {
        const outcome = outcomeForUncomparedKind(classified.kind);
        const tag = outcome === OUTCOME.OUT_OF_SCOPE ? 'SKIP ' : 'UNVERIFIED';
        console.log(
          `${tag} [${relDir}] "${command}" (${classified.kind}` +
            `${outcome === OUTCOME.NOT_COMPARED ? ' — a tsc invocation this guard cannot compare' : ' — not a tsc invocation'})`
        );
        results.push({ command, kind: classified.kind, label: relDir, outcome });
        continue;
      }

      const label = `${relDir}${classified.project ? ` --project ${classified.project}` : ''}`;
      process.stdout.write(`RUN   [${label}] ... `);

      const ts6Raw = runTsc(ts6Bin, manifest.dir, classified.project);
      const ts7Raw = runTsc(ts7Bin, manifest.dir, classified.project);
      const ts6 = {
        ...ts6Raw,
        diagnostics: new Set(ts6Raw.lines.map((l) => normalizeDiagnostic(l, manifest.dir))),
      };
      const ts7 = {
        ...ts7Raw,
        diagnostics: new Set(ts7Raw.lines.map((l) => normalizeDiagnostic(l, manifest.dir))),
      };

      const comparison = compareRuns(ts6, ts7);
      const verdictTag = {
        [OUTCOME.ERROR]: 'ERROR',
        [OUTCOME.MATCHED]: 'PARITY',
        [OUTCOME.MISMATCH]: 'MISMATCH',
      }[comparison.outcome];

      console.log(
        `${verdictTag}  ts6=${ts6.diagnostics.size} diag/${ts6Raw.elapsedMs.toFixed(0)}ms  ts7=${ts7.diagnostics.size} diag/${ts7Raw.elapsedMs.toFixed(0)}ms`
      );

      for (const error of comparison.errors) {
        console.log(`  !! ${error}`);
      }
      if (comparison.outcome === OUTCOME.MISMATCH) {
        console.log(`  only in TS6 (${comparison.onlyInTs6.length}):`);
        for (const line of comparison.onlyInTs6) {
          console.log(`    - ${line}`);
        }
        console.log(`  only in TS7 (${comparison.onlyInTs7.length}):`);
        for (const line of comparison.onlyInTs7) {
          console.log(`    + ${line}`);
        }
      }

      results.push({
        label,
        onlyInTs6: comparison.onlyInTs6,
        onlyInTs7: comparison.onlyInTs7,
        outcome: comparison.outcome,
        ts6DiagCount: ts6.diagnostics.size,
        ts6ElapsedMs: ts6Raw.elapsedMs,
        ts7DiagCount: ts7.diagnostics.size,
        ts7ElapsedMs: ts7Raw.elapsedMs,
      });
    }
  }

  const byOutcome = (outcome) => results.filter((r) => r.outcome === outcome);
  // "Compared" = an actual comparison was ATTEMPTED, which includes runs that
  // errored. Excluding errors here would let the compared-floor fire first and
  // misreport a crashing compiler as "your filter matched nothing" — burying
  // the real cause behind an unrelated message.
  const compared = results.filter(
    (r) =>
      r.outcome === OUTCOME.MATCHED || r.outcome === OUTCOME.MISMATCH || r.outcome === OUTCOME.ERROR
  );

  // Vacuous-pass guard #2: a run must actually have COMPARED something. An
  // unfiltered run is held to the full-sweep floor; a --filter run only has to
  // have matched a package and produced at least one comparison (a filter that
  // matches nothing is itself an error, not a pass).
  const comparedFloor = options.filter ? 1 : MIN_COMPARED_PROJECTS;
  if (compared.length < comparedFloor) {
    throw new Error(
      `Compared only ${compared.length} project(s), below the floor of ${comparedFloor}` +
        (options.filter ? ` for --filter=${options.filter}` : '') +
        '. Refusing to report parity over a near-empty set. ' +
        (options.filter
          ? 'Check that the filter matches a package with a "type-check" script.'
          : 'The type-check script shapes may have changed such that they are no longer recognized as ' +
            '--noEmit runs (if the drop is legitimate, lower MIN_COMPARED_PROJECTS in the same commit).')
    );
  }

  // Time only runs that actually completed a comparison. A crashed compiler
  // "finishes" in milliseconds and would otherwise manufacture a spectacular
  // speedup number out of a failure.
  const timed = results.filter(
    (r) => r.outcome === OUTCOME.MATCHED || r.outcome === OUTCOME.MISMATCH
  );
  const totalTs6Ms = timed.reduce((sum, r) => sum + r.ts6ElapsedMs, 0);
  const totalTs7Ms = timed.reduce((sum, r) => sum + r.ts7ElapsedMs, 0);

  console.log('');
  console.log('=== Summary ===');
  console.log(`Compared and matched: ${byOutcome(OUTCOME.MATCHED).length}`);
  console.log(`Mismatched:           ${byOutcome(OUTCOME.MISMATCH).length}`);
  console.log(`Errored (crash/fatal):${byOutcome(OUTCOME.ERROR).length}`);
  console.log(`NOT COMPARED:         ${byOutcome(OUTCOME.NOT_COMPARED).length}`);
  console.log(`Out of scope:         ${byOutcome(OUTCOME.OUT_OF_SCOPE).length}`);
  console.log(
    `Total TS6 wall time (sum of per-project spawns): ${(totalTs6Ms / 1000).toFixed(1)}s`
  );
  console.log(
    `Total TS7 wall time (sum of per-project spawns): ${(totalTs7Ms / 1000).toFixed(1)}s`
  );
  if (totalTs7Ms > 0) {
    console.log(`Speedup: ${(totalTs6Ms / totalTs7Ms).toFixed(2)}x`);
  }

  // Anything not affirmatively verified is named, every run, whether or not the
  // verdict is already failing. A reader must never have to infer what was left
  // out of the comparison.
  const unverified = byOutcome(OUTCOME.NOT_COMPARED);
  if (unverified.length > 0) {
    console.log('');
    console.log('These tsc invocations were NOT compared — parity is NOT established for them:');
    for (const r of unverified) {
      console.log(`  - [${r.label}] "${r.command}" (${r.kind})`);
    }
    console.log(
      '  Build-mode (`tsc --build`) cannot be compared in place: it must emit (`tsc -b --noEmit` ' +
        'fails with TS6310 on referenced projects) and its output cannot be redirected (`--outDir` ' +
        'is rejected with TS5094 under `--build`), so running it under TS7 would write TS7-generated ' +
        'declarations into the working tree. Comparing it needs an isolated workspace copy.'
    );
  }
  const outOfScope = byOutcome(OUTCOME.OUT_OF_SCOPE);
  if (outOfScope.length > 0) {
    console.log('');
    console.log('Out of scope (not a tsc invocation; no TypeScript version can change these):');
    for (const r of outOfScope) {
      console.log(`  - [${r.label}] "${r.command}"`);
    }
  }

  console.log('');
  if (canClaimParity(results)) {
    console.log('PARITY HOLDS: every discovered tsc invocation was compared and matched.');
    return;
  }

  const blockers = [
    byOutcome(OUTCOME.MISMATCH).length > 0 && `${byOutcome(OUTCOME.MISMATCH).length} mismatch(es)`,
    byOutcome(OUTCOME.ERROR).length > 0 && `${byOutcome(OUTCOME.ERROR).length} errored run(s)`,
    unverified.length > 0 && `${unverified.length} uncompared tsc invocation(s)`,
  ].filter(Boolean);

  console.log(
    `PARITY NOT ESTABLISHED (${blockers.join('; ')}). Do not accept this compiler pairing. ` +
      'See docs/series-c-ts7-parity-findings.md.'
  );
  process.exitCode = 1;
}

// Only run when invoked directly, so the parsing helpers above can be imported
// by scripts/__tests__/ts7-parity-check.test.mjs without executing a full
// full-workspace parity sweep as an import side effect (same convention as
// scripts/run-turbo-command.mjs).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
