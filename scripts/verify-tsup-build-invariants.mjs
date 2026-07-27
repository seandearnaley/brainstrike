#!/usr/bin/env node
// Guard: a workspace package whose build emits declarations with `tsc -b` must
// never let tsup clean the output directory or emit declarations itself.
//
//   * `clean` — tsup's clean step unlinks the whole outDir. In a `tsc -b . &&
//     tsup` build that runs AFTER TypeScript has already written the `.d.ts`
//     files, so a clean deletes the declarations the package is about to
//     publish. It is also not concurrency-safe: multiple app prebuilds invoke
//     workspace builds concurrently and a clean can unlink a sibling's outputs
//     mid-run (the rationale recorded in packages/agent/tsup.config.ts).
//   * `dts` — TypeScript owns declaration emit for these packages (composite
//     projects, `tsc -b`). Turning tsup's declaration bundler on duplicates that
//     work in a separate worker and causes severe build startup contention.
//
// WHY A GUARD AND NOT THE ORIGINALLY-PROPOSED FACTORY (BST-746 rescope).
// BST-746 first proposed a `createTsupConfig` factory in @brainstrike/build-utils.
// That was measured and rejected: only 9 of the 18 configs are simple, and they
// genuinely diverge on output-affecting fields (`sourcemap`, `format`, `target`,
// and `splitting` — tsup defaults `splitting` to TRUE for ESM, so build-utils,
// embeddings and text-splitter really do split today). Wiring a factory would
// also either add 8 new build-graph edges (none of those packages depend on
// build-utils) or land in the config-load hash-gap class that
// scripts/verify-config-load-hash-coverage.mjs exists to guard. A factory would
// have unified the 4 fields that must stay different while doing nothing to stop
// the 2 that must stay the same from drifting. This guard does the opposite: it
// pins exactly the invariants, and costs the build graph nothing.
//
// THE INVARIANT IS CONDITIONAL, AND THAT IS MEASURED, NOT ASSUMED. The repo runs
// two build architectures, and only one of them is governed here:
//
//   TYPESCRIPT-OWNED (17 packages, 14 of them with a tsup.config.ts) — `build`
//     runs `tsc -b .` (or `tsc --build`) and then tsup. TypeScript emits the
//     declarations; tsup emits JS into the same outDir. Both invariants above
//     apply. Three of them (queue, types, worker-runtime) drive tsup entirely
//     from CLI flags with no config file, which is why the flag check below is
//     not optional: a config-file-only scan would skip them completely.
//   TSUP-OWNED (4 packages: chunking-worker, file-tree-worker, test-utils,
//     token-cache) — `build` runs tsup ALONE (`type-check` is a separate
//     `tsc --noEmit`). Nothing else emits declarations, so tsup MUST enable
//     declaration emit, and its clean is safe because tsup is the only writer of
//     that outDir. Stating "every config sets clean/dts false" as a flat rule
//     would have been false for 4 of 18 configs on the day it was written.
//
// The tsup-owned class is not a dumping ground: it carries the INVERSE
// obligation (declaration emit must actually be enabled, or the package ships no
// `.d.ts` at all), enforced below. Moving a package between classes is a real
// build-architecture change, so it is derived from the `build` script rather than
// hand-listed — a hand list would rot the moment a build script changed.
//
// RULING 1 — DYNAMIC EXPRESSIONS ARE REJECTED. Values are classified as literal
// `false`, literal `true`, or DYNAMIC (anything else: `!options.watch`, a
// ternary, an env read, and also the non-boolean shapes tsup accepts —
// `dts: 'src/index.ts'`, `dts: { resolve: true }`, `clean: ['dist']`, all of
// which ENABLE the behaviour). For a TYPESCRIPT-OWNED package a DYNAMIC value is
// a VIOLATION, not a pass. The guard reads source text; it cannot prove an
// expression evaluates false at build time, and treating "not literally true" as
// safe would let `clean: process.env.CI ? true : false` walk straight through the
// check the guard exists to be. There is no legitimate reason to conditionally
// wipe declarations `tsc -b` just emitted — write the literal `false`.
//
// `clean: !options.watch` is therefore NOT a false positive today: every config
// using it is TSUP-OWNED, where the clean invariant does not apply at all. If it
// ever appears in a typescript-owned config it SHOULD fail, because during a
// plain `pnpm build` `options.watch` is falsy and the expression cleans.
//
// RULING 2 — `clean` AND `dts` MUST BE STATED EXPLICITLY (review round, P2 #2).
// tsup's own defaults for both are already `false`, so omission is *currently*
// harmless — and that is exactly the problem. Before this ruling the guard
// reported "17 packages pinned to clean:false/dts:false" while
// @brainstrike/text-splitter set NEITHER, i.e. it asserted something it had not
// verified: the same vacuous-green class the discovery floors exist to prevent.
// Option (b) — keep omission legal and merely soften the message — was rejected:
// it leaves the invariant resting on an upstream default nobody in this repo
// controls, and it makes DELETING `clean: false` from a governed config a silent
// no-op rather than a visible failure. So a governed config must state both, and
// each config now documents the invariant at its own call site.
//
// This ruling also backstops the comment-stripping below: if the stripper ever
// over-strips and eats a real `clean:`/`dts:` line, the field reads as ABSENT and
// FAILS, rather than silently vanishing from the checked set.
//
// The requirement applies to configs that EXIST. A TypeScript-owned package with
// no tsup.config.ts at all (queue, types, worker-runtime) is not forced to grow
// one: it has no config in which to drift, and its CLI flags are checked instead.
//
// RULING 3 — EVERY DECLARATION-EMIT SPELLING IS MODELLED, NOT JUST `dts`
// (review round, P2 #1). Verified against the INSTALLED tsup 8.5.1 rather than
// taken on trust — `node_modules/.../tsup/dist/index.d.ts` declares
// `experimentalDts?: boolean | string | ExperimentalDtsConfig` as a config key
// alongside `dts`, and the CLI in `dist/chunk-DI5BO6XE.js` registers FOUR
// declaration options, not one:
//
//     .option("--dts [entry]",        "Generate declaration file")
//     .option("--dts-resolve",        "Resolve externals types used for d.ts files")
//     .option("--dts-only",           "Emit declaration files only")
//     .option("--experimental-dts",   …)
//
// and normalises them with
//
//     if (flags.dts || flags.dtsResolve || flags.dtsOnly) { options.dts = {}; … }
//
// so `--dts-resolve` and `--dts-only` each independently ENABLE declaration emit
// on their own — they are not modifiers of `--dts`. The review that raised this
// named only `--experimental-dts`; the other two were found by reading the
// installed package. All four flags and both config keys are modelled below.
//
// To fix a failure: set the literal `false`, or — if the package genuinely has no
// `tsc -b` step — recognise that it is tsup-owned and that its build script says
// so. Do not weaken this guard to make a drifted config pass.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { packageManifestPaths } from './verify-catalog-references.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Config fields a governed package MUST state explicitly, as the literal
 * `false`. These two are the invariant itself — see RULING 2.
 */
export const REQUIRED_FALSE_FIELDS = Object.freeze(['clean', 'dts']);

/**
 * Config fields that may be omitted but must be the literal `false` when
 * present. `experimentalDts` is an alternate declaration-emit SPELLING, not an
 * invariant to be declared: requiring 14 configs to write
 * `experimentalDts: false` would be noise, but leaving it unmodelled was a
 * straight bypass of the `dts` rule (RULING 3).
 */
export const OPTIONAL_FALSE_FIELDS = Object.freeze(['experimentalDts']);

/** Every config field this guard inspects. */
export const GUARDED_FIELDS = Object.freeze([...REQUIRED_FALSE_FIELDS, ...OPTIONAL_FALSE_FIELDS]);

/**
 * tsup CLI flags that ENABLE declaration emit. All four are independent
 * switches — see RULING 3 for the normalisation source that proves
 * `--dts-resolve`/`--dts-only` are not mere modifiers of `--dts`.
 */
export const DECLARATION_CLI_FLAGS = Object.freeze([
  '--dts',
  '--dts-only',
  '--dts-resolve',
  '--experimental-dts',
]);

/** tsup CLI flags that enable the clean step. */
export const CLEAN_CLI_FLAGS = Object.freeze(['--clean']);

/**
 * Discovery floors. A guard that inspects NOTHING and reports "no violations" is
 * a vacuous green — the same silent-degradation class it exists to prevent. If a
 * legitimate change drops the real count below a floor, LOWER THE FLOOR
 * DELIBERATELY in a reviewed change; never delete the assertion.
 *
 * MIN_TSUP_CONFIGS guards the file scan (18 configs today).
 * MIN_TYPESCRIPT_OWNED_PACKAGES guards the CLASS the invariant governs (17
 * today) — a scan that found every config but classified them all as tsup-owned
 * would enumerate plenty of files and still check nothing.
 */
export const MIN_TSUP_CONFIGS = 12;
export const MIN_TYPESCRIPT_OWNED_PACKAGES = 8;

/** Matches `tsc -b`/`tsc --build`, the marker of TypeScript-owned declarations. */
const TSC_BUILD_RE = /\btsc\s+(?:-b\b|--build\b)/;

/**
 * Matches a build-script segment that actually invokes tsup.
 *
 * `/` is in the leading class so a path-prefixed invocation
 * (`node_modules/.bin/tsup --dts`) is recognised. Without it such a segment read
 * as "does not invoke tsup", which would skip a config-less package entirely and
 * leave its CLI flags unchecked — precisely the bypass class this guard exists
 * for (review round, claude[bot] note 5). The trailing `(?:\s|$)` is what keeps
 * `--config ./tsup.config.ts` from matching on its own.
 */
const TSUP_INVOCATION_RE = /(?:^|[\s(/])tsup(?:\s|$)/;

/**
 * A guarded property in the shape this repo writes: its own line, at the start of
 * that line, value terminated by a comma and an optional trailing comment.
 *
 * Deliberately line-shaped rather than a JS parse. These configs are TypeScript
 * that imports `tsup` and (in two cases) a local esbuild plugin, so evaluating
 * them would mean resolving the whole build toolchain from a lint script — far
 * too heavy, and the same reason verify-catalog-references.mjs hand-parses YAML.
 * The completeness of the line shape is not assumed: findGuardedFieldOccurrences()
 * cross-checks it against a permissive detector and THROWS on any occurrence the
 * line shape did not model, so an unfamiliar shape fails loudly instead of
 * escaping the guard.
 */
const FIELD_LINE_RE = /^\s*(experimentalDts|clean|dts)\s*:\s*(.+?)\s*,\s*(?:\/\/.*)?$/;

/** Permissive cross-check: any guarded token anywhere in the (comment-free) source. */
const FIELD_ANYWHERE_RE = /\b(experimentalDts|clean|dts)\s*:/g;

/**
 * Blank out comments while PRESERVING line structure.
 *
 * Both detectors run on the stripped text, so a prose comment that merely looks
 * like a setting — `// clean: kept false because tsc -b owns dist` — no longer
 * inflates the permissive count and throws a misleading "unmodelled shape" error
 * on a perfectly valid config (review round, claude[bot] note 4).
 *
 * Differs from stripComments() in verify-no-vitest-worker-mutation.mjs, which
 * collapses a block comment to a single space: line numbers are load-bearing here
 * (they are printed in the violation report), so block comments are blanked
 * character-for-character and newlines survive.
 *
 * CRLF is normalized first because the guarded field pattern anchors on `$`;
 * leaving `\r` behind makes a valid Windows line fail the strict parse while the
 * permissive cross-check still counts it and reports an unmodelled shape.
 *
 * Over-stripping cannot silently hide a violation: RULING 2 makes an ABSENT
 * `clean`/`dts` a failure, so a field eaten by the stripper fails loudly.
 */
export function blankComments(source) {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * Classify a guarded right-hand side.
 *
 * `dynamic` is a deliberate third state rather than being folded into `true`:
 * the remedy differs (write the literal `false` vs. flip a boolean) and the
 * report has to say WHY an expression is rejected — see RULING 1.
 */
export function classifyFieldValue(expression) {
  if (expression === 'false') {
    return 'false';
  }
  if (expression === 'true') {
    return 'true';
  }
  return 'dynamic';
}

/**
 * Every guarded assignment in one tsup config source.
 *
 * NO SILENT FALLBACK: if the permissive detector sees more occurrences than the
 * line shape parsed, an unmodelled shape is present (a value spanning lines, a
 * property inlined after `{`, a spread from a helper). Under-reporting there
 * would fake a green for exactly the config that got clever, so it throws.
 *
 * @param {string} source config file contents
 * @param {string} label path used in error messages
 * @returns {{ field: string, expression: string, kind: string, line: number }[]}
 */
export function findGuardedFieldOccurrences(source, label) {
  const code = blankComments(source);
  const occurrences = [];
  for (const [index, rawLine] of code.split('\n').entries()) {
    const match = rawLine.match(FIELD_LINE_RE);
    if (!match) {
      continue;
    }
    occurrences.push({
      expression: match[2],
      field: match[1],
      kind: classifyFieldValue(match[2]),
      line: index + 1,
    });
  }

  const permissive = code.match(FIELD_ANYWHERE_RE) ?? [];
  if (permissive.length !== occurrences.length) {
    throw new Error(
      `verify-tsup-build-invariants.mjs found ${permissive.length} guarded token(s) (clean:/dts:/experimentalDts:) ` +
        `in ${label} but could only parse ${occurrences.length} of them. One is written in a shape this guard does ` +
        'not model — a multi-line value, a property inlined after `{`, or a spread from a helper object. (Comments ' +
        'are blanked before this check, so a comment mentioning one of these names is NOT the cause.) Teach ' +
        'findGuardedFieldOccurrences() the new shape rather than letting a setting escape the check: an unparsed ' +
        '`clean: true` is exactly the drift this guard exists to catch.'
    );
  }

  // A second assignment to the same field would make the effective value depend
  // on object-literal ordering or a spread, and the guard would report on the
  // wrong one.
  const seen = new Set();
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.field)) {
      throw new Error(
        `verify-tsup-build-invariants.mjs found more than one \`${occurrence.field}:\` assignment in ${label} ` +
          `(line ${occurrence.line}). The effective value then depends on literal ordering or a spread, which this ` +
          'guard does not model. Collapse it to a single assignment.'
      );
    }
    seen.add(occurrence.field);
  }
  return occurrences;
}

/**
 * Which tool emits this package's declarations, read off its `build` script.
 *
 * Derived rather than hand-listed on purpose: the class a package belongs to IS
 * its build architecture, so a list would be a second copy of that fact, free to
 * disagree with the script it describes.
 */
export function classifyDeclarationOwner(buildScript) {
  return TSC_BUILD_RE.test(buildScript ?? '') ? 'typescript' : 'tsup';
}

/** True when `segment` passes `flag` (with an optional `[entry]`/`=value`). */
function segmentHasFlag(segment, flag) {
  return new RegExp(`\\s${flag}(?=\\s|=|$)`).test(segment);
}

/**
 * The declaration/clean flags on a build script's tsup invocation, as the exact
 * flag strings found. tsup accepts these on the CLI as well as in the config, so
 * a config-file-only guard would leave an open bypass:
 * `tsc -b . && tsup src/index.ts --dts` violates the declaration-ownership
 * invariant with a perfectly clean tsup.config.ts.
 *
 * Only segments that actually invoke tsup are inspected — `pnpm run clean &&
 * tsc -b . && tsup` must not read as a tsup clean.
 *
 * @returns {{ clean: string[], dts: string[] }}
 */
export function readTsupCliFlags(buildScript) {
  const found = { clean: [], dts: [] };
  for (const segment of (buildScript ?? '').split('&&')) {
    if (!TSUP_INVOCATION_RE.test(segment)) {
      continue;
    }
    for (const flag of DECLARATION_CLI_FLAGS) {
      if (segmentHasFlag(segment, flag) && !found.dts.includes(flag)) {
        found.dts.push(flag);
      }
    }
    for (const flag of CLEAN_CLI_FLAGS) {
      if (segmentHasFlag(segment, flag) && !found.clean.includes(flag)) {
        found.clean.push(flag);
      }
    }
  }
  return found;
}

/**
 * Every workspace package that builds with tsup, with the facts the rules need.
 * Enumerated from pnpm-workspace.yaml via the shared packageManifestPaths() so a
 * newly added package group cannot silently escape the scan.
 */
export function discoverTsupPackages(repoRoot) {
  const packages = [];
  for (const manifestPath of packageManifestPaths(repoRoot)) {
    const packageDir = path.dirname(manifestPath);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      // NO SILENT FALLBACK: an unparseable manifest is an unknown state, not a
      // clean one — its build script decides which rules apply.
      throw new Error(
        `verify-tsup-build-invariants.mjs could not parse ${path.relative(repoRoot, manifestPath)}: ` +
          `${err.message}. A manifest that does not parse cannot be certified; fix the JSON.`
      );
    }
    if (manifest.tsup !== undefined) {
      // NO SILENT FALLBACK: tsup also reads a `tsup` key from package.json. No
      // package uses one today; if one appears, its clean/dts settings would be
      // invisible to a config-file scan.
      throw new Error(
        `${path.relative(repoRoot, manifestPath)} declares a package.json \`tsup\` config block, which ` +
          'verify-tsup-build-invariants.mjs does not model — the clean/dts settings inside it would escape this ' +
          'guard entirely. Move the config into tsup.config.ts, or teach discoverTsupPackages() the shape.'
      );
    }

    const buildScript = manifest.scripts?.build ?? '';
    const configPath = path.join(packageDir, 'tsup.config.ts');
    let configSource = null;
    try {
      configSource = readFileSync(configPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err; // NO SILENT FALLBACK: only a genuinely absent config is skippable
      }
    }
    if (configSource === null && !TSUP_INVOCATION_RE.test(buildScript)) {
      continue;
    }
    packages.push({
      buildScript,
      configPath: configSource === null ? null : path.relative(repoRoot, configPath),
      configSource,
      declarationOwner: classifyDeclarationOwner(buildScript),
      name: manifest.name ?? path.relative(repoRoot, packageDir),
    });
  }
  return packages;
}

/** Rules for a package whose declarations come from `tsc -b`. */
function checkTypescriptOwned(pkg, occurrences, violations) {
  const record = (extra) => violations.push({ packageName: pkg.name, ...extra });

  for (const field of REQUIRED_FALSE_FIELDS) {
    const occurrence = occurrences.find((entry) => entry.field === field);
    if (occurrence === undefined) {
      // A config-less package has nothing to state — see RULING 2.
      if (pkg.configPath !== null) {
        record({
          expression: '(absent)',
          field,
          kind: 'config-absent',
          location: pkg.configPath,
        });
      }
      continue;
    }
    if (occurrence.kind !== 'false') {
      record({
        expression: occurrence.expression,
        field,
        kind: `config-${occurrence.kind}`,
        location: `${pkg.configPath}:${occurrence.line}`,
      });
    }
  }

  for (const field of OPTIONAL_FALSE_FIELDS) {
    const occurrence = occurrences.find((entry) => entry.field === field);
    if (occurrence !== undefined && occurrence.kind !== 'false') {
      record({
        expression: occurrence.expression,
        field,
        kind: `config-${occurrence.kind}`,
        location: `${pkg.configPath}:${occurrence.line}`,
      });
    }
  }

  const cliFlags = readTsupCliFlags(pkg.buildScript);
  for (const field of ['clean', 'dts']) {
    for (const flag of cliFlags[field]) {
      record({
        expression: flag,
        field,
        kind: 'cli-flag',
        location: `${pkg.name} package.json [scripts.build]`,
      });
    }
  }
}

/**
 * The INVERSE obligation on the tsup-owned class, which is what keeps the
 * exemption load-bearing instead of a place to park a config to silence the
 * guard. These packages have no `tsc -b`, so if tsup does not emit declarations
 * nothing does and the package publishes types it cannot back.
 *
 * Any declaration spelling satisfies it — `dts`, `experimentalDts`, or any of the
 * four CLI flags.
 */
function checkTsupOwned(pkg, occurrences, violations) {
  const enabledInConfig = occurrences.some(
    (entry) =>
      (entry.field === 'dts' || entry.field === 'experimentalDts') && entry.kind !== 'false'
  );
  if (enabledInConfig || readTsupCliFlags(pkg.buildScript).dts.length > 0) {
    return;
  }
  violations.push({
    expression: occurrences.find((entry) => entry.field === 'dts')?.expression ?? '(absent)',
    field: 'dts',
    kind: 'tsup-owned-without-dts',
    location: pkg.configPath ?? `${pkg.name} package.json [scripts.build]`,
    packageName: pkg.name,
  });
}

/**
 * Every tsup build-invariant violation across the workspace.
 *
 * @param {{ repoRoot?: string }} options
 */
export function findTsupInvariantViolations({ repoRoot = REPO_ROOT } = {}) {
  const packages = discoverTsupPackages(repoRoot);
  const configs = packages.filter((pkg) => pkg.configSource !== null);
  const typescriptOwned = packages.filter((pkg) => pkg.declarationOwner === 'typescript');

  // Vacuous-pass floors, asserted BEFORE the scan: with nothing discovered the
  // loop below finds zero violations and reports success while checking nothing.
  if (configs.length < MIN_TSUP_CONFIGS) {
    throw new Error(
      `Refusing to run: discovered only ${configs.length} tsup.config.ts file(s), below the floor of ` +
        `${MIN_TSUP_CONFIGS}. A near-empty scan would iterate almost nothing and report a vacuous green. Usually ` +
        'means pnpm-workspace.yaml stopped parsing or discoverTsupPackages() broke, not that 6+ packages ' +
        'legitimately dropped tsup at once.'
    );
  }
  if (typescriptOwned.length < MIN_TYPESCRIPT_OWNED_PACKAGES) {
    throw new Error(
      `Refusing to run: only ${typescriptOwned.length} package(s) classified as TypeScript-owned, below the floor ` +
        `of ${MIN_TYPESCRIPT_OWNED_PACKAGES}. That is the class the clean/dts invariants govern, so a collapsed ` +
        'classification would enumerate every config and still check none of them. Usually means ' +
        'classifyDeclarationOwner() stopped recognising `tsc -b` in build scripts.'
    );
  }

  const violations = [];
  for (const pkg of packages) {
    const occurrences =
      pkg.configSource === null
        ? []
        : findGuardedFieldOccurrences(pkg.configSource, pkg.configPath);
    if (pkg.declarationOwner === 'typescript') {
      checkTypescriptOwned(pkg, occurrences, violations);
    } else {
      checkTsupOwned(pkg, occurrences, violations);
    }
  }
  return violations;
}

/**
 * Human-readable report. The remedy is per-kind: telling someone with a dynamic
 * expression to "set it to false" is right, telling the tsup-owned package with
 * no declaration emit the same thing is exactly backwards.
 */
export function formatTsupViolations(violations) {
  return violations.map(describeViolation).join('\n');
}

function describeViolation(violation) {
  const { expression, field, location, packageName } = violation;
  switch (violation.kind) {
    case 'tsup-owned-without-dts':
      return (
        `${location} — ${packageName} builds with tsup ALONE (no \`tsc -b\` in its build script), so tsup is the ` +
        `only thing that can emit declarations, but \`dts\` is ${expression}. The package would publish no .d.ts ` +
        'at all. Either set `dts: true`, or add the `tsc -b .` step that makes TypeScript the declaration owner ' +
        '(which then requires `dts: false` and `clean: false`).'
      );
    case 'cli-flag':
      return (
        `${location} — ${packageName} runs \`tsc -b\` and then passes ${expression} to tsup on the command line. ` +
        `TypeScript owns declaration emit here; a tsup ${expression} duplicates it (or wipes it). Drop the flag ` +
        'from the build script.'
      );
    case 'config-absent':
      return (
        `${location} — ${packageName} runs \`tsc -b\` but its tsup config never states \`${field}\`. tsup's default ` +
        `happens to be \`false\` today, so this is not broken — but an unstated ${field} means the guard would be ` +
        `claiming an invariant it never verified, and DELETING \`${field}: false\` from a config would be a silent ` +
        `no-op instead of a visible failure. Add \`${field}: false\` so the invariant is stated where it applies.`
      );
    case 'config-dynamic':
      return (
        `${location} — ${packageName} sets \`${field}: ${expression}\`, a dynamic expression. This guard reads ` +
        'source text and cannot prove it evaluates false at build time, so a dynamic value is rejected rather than ' +
        `assumed safe. ${packageName} runs \`tsc -b\`, which emits the .d.ts files BEFORE tsup runs; a \`${field}\` ` +
        'that evaluates true then deletes or duplicates them. Write the literal `false`.'
      );
    default:
      return (
        `${location} — ${packageName} sets \`${field}: true\`, but it runs \`tsc -b\` and TypeScript owns ` +
        `declaration emit there. ${
          field === 'clean'
            ? "tsup's clean unlinks the whole outDir AFTER tsc -b wrote the declarations into it, and is not " +
              'concurrency-safe against sibling workspace builds.'
            : "tsup's declaration bundler duplicates what tsc -b already emitted, in a separate worker that causes " +
              'severe build startup contention.'
        } Set \`${field}: false\`.`
      );
  }
}

/**
 * @param {{ repoRoot?: string }} options — threaded so the BST-836 entrypoint
 *   contract test can drive this guard against a tree where it must not pass.
 */
export function main(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const violations = findTsupInvariantViolations({ repoRoot });
  if (violations.length === 0) {
    // The summary claims ONLY what was actually verified — see RULING 2. The
    // previous wording said all 17 TypeScript-owned packages were "pinned to
    // clean:false/dts:false" when 3 have no config to pin and one stated
    // neither field.
    const packages = discoverTsupPackages(repoRoot);
    const owned = packages.filter((pkg) => pkg.declarationOwner === 'typescript');
    const governed = owned.filter((pkg) => pkg.configSource !== null).length;
    const configless = owned.length - governed;
    console.log(
      `tsup build invariants hold: ${governed} TypeScript-owned tsup.config.ts file(s) explicitly state ` +
        `clean:false and dts:false with no declaration-emit opt-in; ${configless} config-less TypeScript-owned ` +
        `package(s) carry no ${[...CLEAN_CLI_FLAGS, ...DECLARATION_CLI_FLAGS].join('/')} flag on their tsup ` +
        `invocation; ${packages.length - owned.length} tsup-owned package(s) confirmed to emit declarations.`
    );
    return;
  }
  console.error('tsup build invariant violations:');
  console.error(formatTsupViolations(violations));
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
