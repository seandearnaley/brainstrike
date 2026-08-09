#!/usr/bin/env node

// Guard: no tracked JS/TS source file may contain a raw 0x00 byte.
//
// Four files shipped with a literal NUL where the two-character escape `\0` was
// intended — `orderedIds.join('<NUL>')` instead of `orderedIds.join('\0')`. The
// two forms are IDENTICAL at runtime (both produce U+0000), so nothing ever
// broke, which is precisely why it survived: the defect is one of visibility,
// not behavior.
//
// A single NUL flips how the toolchain classifies the file:
//   - `file(1)` reports it as `data`, not text.
//   - `grep` and `git grep` treat it as binary and SKIP it silently — the file
//     drops out of code search with no warning, so nobody can find what is in it.
//     This applies wherever the byte sits, because grep scans the whole file.
//   - The Explorer's background token indexer classifies it as binary and returns
//     'Binary file - cannot count tokens' instead of a count. That one is
//     POSITION-DEPENDENT: isBinaryContent() in
//     packages/token-cache/src/background-indexer.worker.ts samples only the
//     first 8192 UTF-16 units, so of the four original offenders only
//     threads-panel-dnd.ts (first NUL at 3037) actually went blank; the other
//     three carried theirs past the sample window and still counted normally.
//     The search invisibility, not the token count, is the reliable symptom.
//
// The remediation is always the same and always safe: write `\0`.
//
// Scope is by EXTENSION, not by content sniffing: tracked binary assets (.png,
// .ico, .wasm — icon.png alone holds ~31k NULs) are legitimately full of them.
// Enumeration is by `git ls-files`, so untracked scratch files and build output
// cannot fail the lane, and node_modules can never be wandered into.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createSpawnInvocation } from './spawn-command.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Exported so the paired test can assert its per-extension expectation map stays
// EXHAUSTIVE against this. Widening it without stating what you expect to find
// fails the test rather than silently extending the guard's reach on paper only.
export const GUARDED_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts', '.tsx']);

// Deliberately NO directory allowlist: `git ls-files` is called with no pathspec
// so every tracked file is enumerated and only the extension filter narrows it.
// An earlier revision restricted this to apps/packages/scripts (copied from
// typescript-compiler-wiring.test.mjs, where that scoping is meaningful) and the
// PR #2379 review caught the mismatch: the invariant claimed "no tracked JS/TS
// source", but 20 tracked files escaped it — live root config (commitlint.config.ts,
// eslint.config.js, vitest.config.mts, doctor.config.ts, playwright-merge.config.js)
// and all of spikes/**. A NUL in any of those causes identical breakage. Scanning
// everything also means a new top-level directory is covered the day it lands,
// which a hard-coded list would not do.

// There is deliberately NO allowlist. Every other guard in scripts/ has one
// because its rule has legitimate exceptions; this one does not. `\0` and a raw
// 0x00 produce the identical value, so the remediation costs nothing and never
// changes behavior — a file needing "a real NUL, not the escape" cannot exist.
// The two intentional NUL-handling fixtures (live-grep.integration.test.ts and
// fence-escape-resistance.integration.spec.ts) keep their NUL semantics through
// the escape and are not exceptions to anything. An allowlist would only ever
// serve to re-admit the invisibility this guard exists to remove.

// Anti-vacuous-green floor, in the style of MIN_VERIFY_SCRIPTS in
// verify-script-entrypoints.test.mjs. If the enumeration or the extension filter
// ever breaks, it returns nothing and this guard reports a clean tree
// while checking zero files. The tree holds ~4.2k guarded sources today; this
// floor only has to be low enough never to false-positive and high enough that
// a broken scan cannot slip past.
export const MIN_SCANNED_FILES = 1000;

const NUL_BYTE = 0x00;
const LINE_FEED = 0x0a;

function runGitLsFiles(root, extraArgs) {
  const invocation = createSpawnInvocation('git', ['ls-files', '-z', ...extraArgs]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: invocation.shell,
  });

  if (result.error) {
    throw new Error(`git ls-files could not be run in ${root}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed in ${root} (exit ${result.status}): ${(result.stderr ?? '').trim()}`
    );
  }

  return result.stdout.split('\0').filter(Boolean);
}

function trackedSourceFiles(root) {
  const isGuarded = (filePath) => GUARDED_EXTENSIONS.has(path.extname(filePath));

  // `git ls-files` reports the INDEX, so a tracked file deleted from the working
  // tree without staging the deletion — an ordinary mid-edit state — is still
  // listed with nothing on disk to read, and the run died on ENOENT (PR #2379
  // review). Subtracting --deleted models the real scan set, "tracked AND
  // present". Done here rather than by catching ENOENT at the read, because that
  // catch would also swallow permission errors and other genuine read failures:
  // a file that exists but cannot be read must still fail loudly.
  const deleted = new Set(runGitLsFiles(root, ['--deleted']).filter(isGuarded));

  return runGitLsFiles(root, [])
    .filter(isGuarded)
    .filter((filePath) => !deleted.has(filePath))
    .sort();
}

// Single forward pass: line numbers are tracked as we go rather than re-slicing
// the buffer per hit. Repeats on one line collapse to one entry (they are always
// adjacent in a forward scan) while `count` stays honest — threads-panel-dnd.ts
// had 4 NULs across 2 lines, and both numbers are worth reporting.
function scanForNulBytes(buffer) {
  if (buffer.indexOf(NUL_BYTE) === -1) {
    return null;
  }

  const lineNumbers = [];
  let count = 0;
  let line = 1;

  for (const byte of buffer) {
    if (byte === LINE_FEED) {
      line += 1;
    } else if (byte === NUL_BYTE) {
      count += 1;
      if (lineNumbers.at(-1) !== line) {
        lineNumbers.push(line);
      }
    }
  }

  return { count, lineNumbers };
}

/**
 * Scan tracked JS/TS sources for raw 0x00 bytes.
 *
 * Returns `{ scannedFiles, violations }`. `scannedFiles` is the posix-relative
 * enumeration the verdict was computed from — returned rather than a bare count
 * so the paired test can assert WHICH slices were reached, not merely how many
 * files in total. Each violation is `{ count, filePath, lineNumbers }`, sorted
 * by path. Throws if the tree cannot be enumerated — a root that yields no
 * answer must not read as a clean one.
 */
export function findRawNulByteViolations({ root = REPO_ROOT } = {}) {
  const scannedFiles = trackedSourceFiles(root);
  const violations = [];

  for (const filePath of scannedFiles) {
    const found = scanForNulBytes(readFileSync(path.join(root, filePath)));
    if (found) {
      violations.push({ count: found.count, filePath, lineNumbers: found.lineNumbers });
    }
  }

  return { scannedFiles, violations };
}

export function main({ repoRoot = REPO_ROOT } = {}) {
  const { scannedFiles, violations } = findRawNulByteViolations({ root: repoRoot });

  if (scannedFiles.length < MIN_SCANNED_FILES) {
    throw new Error(
      `Scanned only ${scannedFiles.length} tracked source file(s) under ${repoRoot}, below the ` +
        `floor of ${MIN_SCANNED_FILES}. Refusing to report a clean tree from a scan that ` +
        'almost certainly enumerated nothing.'
    );
  }

  if (violations.length === 0) {
    console.log(`No raw NUL bytes found in ${scannedFiles.length} tracked source files.`);
    return;
  }

  console.error(
    'These tracked source files contain raw 0x00 bytes, which makes them invisible to ' +
      'grep/git grep and unreadable to the token indexer. Replace each one with the ' +
      'two-character escape `\\0` — identical at runtime, but greppable:'
  );
  for (const violation of violations) {
    const plural = violation.count === 1 ? 'NUL' : 'NULs';
    console.error(
      `- ${violation.filePath} (${violation.count} ${plural} on line ` +
        `${violation.lineNumbers.join(', ')})`
    );
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
