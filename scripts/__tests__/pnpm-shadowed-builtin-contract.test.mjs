import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PNPM_SHADOWED_BUILTINS } from '../../.agents/skills/scribe-automation/scripts/collect-scribe-references.mjs';

/**
 * BST-852. Some pnpm subcommands SHADOW an identically-named package script:
 * `pnpm <name>` runs pnpm's builtin and the script NEVER runs. The failure is
 * silent and, worse, confidently green — `pnpm doctor` prints
 *
 *     All checks passed with 1 warning(s)
 *
 * and exits 0, which reads exactly like a clean run of the repo's react-doctor
 * script. AGENTS.md told every agent to run it that way, so a local "pass" for
 * a check that never executed could be followed by a red required PR check.
 *
 * This is the false-green gate-instrument class (cf. BST-836, where verify-*.mjs
 * scripts exited 0 on real violations). The fix is to make the collision
 * unreachable rather than documented-around: the script was renamed
 * `doctor` → `react-doctor`, and this contract stops the collision from being
 * reintroduced — either by a package declaring a shadowed script name, or by a
 * doc telling someone to type the shadowed shorthand.
 *
 * THE SHADOW SET IS EMPIRICAL. It lives in the scribe collector (imported
 * above) and must never be derived from `pnpm help -a`, which is wrong in both
 * directions — see the comment on PNPM_SHADOWED_BUILTINS for the verified
 * `doctor` (absent yet shadowing) and `clean` (listed yet harmless) cases.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tracked(...pathspecs) {
  return execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', ...pathspecs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

const manifestPaths = tracked('*package.json').filter(
  (candidate) => !candidate.includes('node_modules/')
);

test('no package.json declares a script whose name a pnpm builtin shadows', () => {
  const violations = [];
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, manifestPath), 'utf8'));
    for (const scriptName of Object.keys(manifest.scripts ?? {})) {
      if (PNPM_SHADOWED_BUILTINS.has(scriptName)) {
        violations.push(
          `${manifestPath} declares a script named ${JSON.stringify(scriptName)}, but pnpm's builtin ` +
            `"${scriptName}" subcommand claims the bare shorthand — \`pnpm ${scriptName}\` runs the builtin and ` +
            'this script never executes, while still exiting 0. Rename the script to something pnpm has no ' +
            'builtin for (this is why the react-doctor script is not called "doctor").'
        );
      }
    }
  }
  assert.deepEqual(violations, [], `Shadowed script names:\n${violations.join('\n')}`);
});

/**
 * Line-scoped opt-out for prose that must NAME the broken shorthand in order to
 * warn about it. Without this the contract would forbid documenting the very
 * hazard it enforces — and the natural workaround (exempting the whole file)
 * would blind it to `docs/agents/ci-quality.md`, the one doc most likely to
 * carry a real instruction. Keep the marker on the same line as the mention.
 */
const MENTION_MARKER = 'shadowed-shorthand-example';

test('no tracked doc instructs the shadowed bare shorthand', () => {
  // Only the BARE form is a defect. `pnpm run <name>` is unambiguous and always
  // reaches the script, so it is deliberately not matched here.
  const shadowed = [...PNPM_SHADOWED_BUILTINS];
  const pattern = new RegExp(String.raw`\bpnpm\s+(?!run\b)(${shadowed.join('|')})\b`);
  const violations = [];
  for (const docPath of tracked('*.md')) {
    const lines = readFileSync(path.join(repoRoot, docPath), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.includes(MENTION_MARKER)) {
        continue; // documenting the hazard, not instructing it
      }
      const match = line.match(pattern);
      if (match) {
        violations.push(
          `${docPath}:${index + 1} instructs \`pnpm ${match[1]}\`, which runs pnpm's builtin ` +
            `"${match[1]}" subcommand and exits 0 without running any package script. Use an explicit ` +
            '`pnpm run <script>` form naming a script that actually exists.'
        );
      }
    }
  }
  assert.deepEqual(violations, [], `Shadowed shorthand in docs:\n${violations.join('\n')}`);
});

test('the react-doctor script exists under a name pnpm cannot shadow', () => {
  // The positive half of the contract: the two tests above are satisfiable by
  // deleting the script outright, which would be a silent capability loss. This
  // pins that react-doctor is still reachable, and reachable by shorthand.
  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const script = rootManifest.scripts['react-doctor'];
  assert.equal(
    typeof script,
    'string',
    'root package.json must declare a "react-doctor" script (renamed from "doctor" in BST-852).'
  );
  assert.match(
    script,
    /\breact-doctor\b/,
    `the "react-doctor" script must actually invoke react-doctor (found ${JSON.stringify(script)}).`
  );
  assert.equal(
    PNPM_SHADOWED_BUILTINS.has('react-doctor'),
    false,
    'the script was renamed onto a name pnpm also shadows — pick another.'
  );
});

test('every mention-marker is live (no dead exemptions)', () => {
  // Allowlist discipline: a marker on a line that does not actually contain the
  // shorthand is a standing licence to reintroduce it there unnoticed. Same
  // reasoning as the *_ALLOWLIST meta-tests in
  // package-scripts-canonical-form-contract.test.mjs.
  const shadowed = [...PNPM_SHADOWED_BUILTINS];
  const pattern = new RegExp(String.raw`\bpnpm\s+(?!run\b)(${shadowed.join('|')})\b`);
  const violations = [];
  let markerCount = 0;
  for (const docPath of tracked('*.md')) {
    const lines = readFileSync(path.join(repoRoot, docPath), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.includes(MENTION_MARKER)) {
        continue;
      }
      markerCount += 1;
      if (!pattern.test(line)) {
        violations.push(
          `${docPath}:${index + 1} carries the ${MENTION_MARKER} marker but the line contains no shadowed ` +
            'shorthand, so the exemption is dead. Remove it.'
        );
      }
    }
  }
  assert.deepEqual(violations, [], `Dead mention-markers:\n${violations.join('\n')}`);
  assert.ok(
    markerCount <= 3,
    `${markerCount} lines carry the ${MENTION_MARKER} marker. This is meant for the handful of docs that ` +
      'explain the hazard; a growing count means it is being used to silence real instructions.'
  );
});

test('the shadow set is non-empty and pins the verified doctor case', () => {
  // Anti-vacuity. Every loop above iterates over PNPM_SHADOWED_BUILTINS; if it
  // were ever emptied (or the import silently resolved to undefined) the whole
  // contract would pass while checking nothing — the exact stale-green class it
  // exists to prevent.
  assert.ok(
    PNPM_SHADOWED_BUILTINS instanceof Set,
    'PNPM_SHADOWED_BUILTINS must be an imported Set; a broken import would make every test here vacuous.'
  );
  assert.ok(
    PNPM_SHADOWED_BUILTINS.size >= 1,
    'PNPM_SHADOWED_BUILTINS is empty, so every assertion in this file passes vacuously.'
  );
  assert.ok(
    PNPM_SHADOWED_BUILTINS.has('doctor'),
    '"doctor" is the empirically verified shadowing builtin this contract was written for (BST-852). ' +
      'Removing it would silently retire the guard.'
  );
});

test('manifest and doc enumeration is not vacuous', () => {
  // Both scans are git-ls-files driven. If the pathspec or cwd ever stopped
  // matching, the for-loops would iterate zero times and pass silently.
  assert.ok(
    manifestPaths.includes('package.json'),
    `manifest enumeration did not find the root package.json (found ${manifestPaths.length} manifest(s)). ` +
      'Fix the git ls-files pathspec, not this assertion.'
  );
  assert.ok(
    manifestPaths.length >= 30,
    `Expected at least 30 workspace manifests but found ${manifestPaths.length}; the enumeration is likely broken.`
  );
  const docs = tracked('*.md');
  assert.ok(
    docs.includes('AGENTS.md'),
    'doc enumeration did not find AGENTS.md — the file this contract was written for.'
  );
});
