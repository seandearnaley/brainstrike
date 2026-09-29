#!/usr/bin/env node
// PER-RULE eslint warning ratchet. Replaces the single `--max-warnings=N`
// scalar that `lint:eslint` used to carry.
//
// Why per-rule (BST-1220, #2372): one scalar over two independent warning families
// (`react-hooks/*` compiler diagnostics and `react-refresh/*` Fast Refresh
// boundary) lets them trade headroom invisibly — burning 20 Fast Refresh
// warnings without lowering the ceiling silently grants 20 warnings of slack to
// compiler diagnostics. That is not hypothetical: this repo shipped a 194
// ceiling while the real count was 186, and the 8-warning gap went unnoticed
// because no instrument compared them.
//
// The rules enforced here:
//   1. ZERO error-severity findings. Always. Errors never get a budget.
//   2. No rule may exceed its baseline entry.
//   3. No rule may fall BELOW its baseline entry without updating the baseline.
//      This is the anti-slack rule: a burn-down must bank the win by lowering
//      the number, or the freed headroom silently becomes budget for a
//      regression in that same rule.
//   4. A rule reporting findings with NO baseline entry fails. New warning
//      families must be declared, not absorbed.
//   5. A baseline entry above 0 whose rule reports nothing fails — that is
//      either a completed burn-down (lower it) or a rule that stopped existing.
//      A zero count is ambiguous between "clean" and "gone"; see
//      `scripts/__tests__/lint-rule-liveness-contract.test.mjs`.
//
// Re-baseline with: `pnpm run lint:eslint --write-baseline`
//
// Entrypoint contract (BST-836): main() is exported, throws rather than calling
// process.exit so it can be driven in-process, and refuses to report success on
// a root it cannot read. See scripts/__tests__/verify-script-entrypoints.test.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_FILENAME = 'eslint-warning-baseline.json';

// The lint surface. Kept here rather than in package.json so the target list and
// the baseline that describes it cannot drift apart; a contract test asserts
// this matches eslint.config.js's `files` globs.
const TARGETS = [
  'apps/desktop/src',
  'apps/web/src',
  'packages/app-shell/src',
  'packages/app-state/src',
  'packages/assistant-ui/src',
  'packages/db-explorer/src',
  'packages/db/src',
  'packages/file-explorer-hooks/src',
  'packages/file-explorer-ui/src',
  'packages/file-import/src',
  'packages/hooks/src',
  'packages/notes-vault/src',
  'packages/settings-ui/src',
  'packages/token-cache/src',
  'packages/ui/src',
  'packages/vector-management/src',
  'packages/workspace-search/src',
];

// Anti-vacuous-green floor: if lintFiles silently matches nothing, every
// comparison below is trivially satisfied and the gate reports a clean run over
// zero files. Well under the real figure (4189 files at time of writing).
const MIN_LINTED_FILES = 500;

export function parseCliArgs(argv) {
  let repoRoot = DEFAULT_REPO_ROOT;
  let repoRootSeen = false;
  let writeBaseline = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write-baseline') {
      if (writeBaseline) {
        throw new Error('verify-eslint-warning-baselines: duplicate --write-baseline');
      }
      writeBaseline = true;
      continue;
    }
    if (argument === '--repo-root') {
      if (repoRootSeen) {
        throw new Error('verify-eslint-warning-baselines: duplicate --repo-root');
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('verify-eslint-warning-baselines: --repo-root requires a path');
      }
      repoRoot = path.resolve(value);
      repoRootSeen = true;
      index += 1;
      continue;
    }
    throw new Error(`verify-eslint-warning-baselines: unsupported argument ${String(argument)}`);
  }

  return { repoRoot, writeBaseline };
}

function countWarningsByRule(results) {
  const counts = new Map();
  for (const result of results) {
    for (const message of result.messages) {
      if (message.severity !== 1) {
        continue;
      }
      const ruleId = message.ruleId ?? '(no rule)';
      counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
    }
  }
  return counts;
}

function diffAgainstBaseline(counts, baseline) {
  const failures = [];
  for (const [ruleId, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const allowed = baseline[ruleId];
    if (allowed === undefined) {
      failures.push(
        `  ${ruleId}: ${count} warnings but NO baseline entry. A new warning ` +
          `family must be declared in ${BASELINE_FILENAME}, not absorbed.`
      );
    } else if (count > allowed) {
      failures.push(
        `  ${ruleId}: ${count} warnings, baseline ${allowed} (+${count - allowed}). ` +
          'Fix the new findings; do not raise the baseline to match.'
      );
    } else if (count < allowed) {
      failures.push(
        `  ${ruleId}: ${count} warnings, baseline ${allowed} (-${allowed - count}). ` +
          'Burn-down must BANK the win: lower this entry, or the freed headroom ' +
          'silently becomes budget for a future regression in this same rule.'
      );
    }
  }
  for (const [ruleId, allowed] of Object.entries(baseline)) {
    if (!counts.has(ruleId) && allowed > 0) {
      failures.push(
        `  ${ruleId}: baseline ${allowed} but ZERO findings. Either the backlog ` +
          'was cleared (lower the entry to 0) or the rule stopped running — ' +
          'confirm which before editing the baseline.'
      );
    }
  }
  return failures;
}

export async function main({ repoRoot = DEFAULT_REPO_ROOT, writeBaseline = false } = {}) {
  const baselinePath = path.join(repoRoot, BASELINE_FILENAME);
  // Read the verdict input before starting ESLint. Besides failing earlier on a
  // malformed root, this gives the executable entrypoint test a deterministic
  // proof that its explicit fixture root reached main().
  const baseline = writeBaseline ? undefined : JSON.parse(readFileSync(baselinePath, 'utf8'));
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintFiles(TARGETS);

  if (results.length < MIN_LINTED_FILES) {
    throw new Error(
      `Linted only ${results.length} file(s), below the floor of ${MIN_LINTED_FILES}. ` +
        'Either the target list broke or this was pointed at the wrong root — ' +
        'every baseline comparison would be vacuously green.'
    );
  }

  const counts = countWarningsByRule(results);

  if (writeBaseline) {
    const next = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    console.log(`Wrote ${BASELINE_FILENAME} — ${counts.size} rules, ${total} warnings.`);
    return;
  }

  const errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
  if (errorCount > 0) {
    const formatter = await eslint.loadFormatter('stylish');
    console.log(await formatter.format(results));
    throw new Error(`eslint: ${errorCount} error-severity finding(s). Errors never get a budget.`);
  }

  const failures = diffAgainstBaseline(counts, baseline);
  if (failures.length > 0) {
    throw new Error(
      `eslint warning baselines out of date (${failures.length} rule(s)):\n` +
        `${failures.join('\n')}\n\n` +
        'Re-baseline with: pnpm run lint:eslint --write-baseline'
    );
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  console.log(`eslint: 0 errors, ${total} warnings across ${counts.size} rules — all at baseline.`);
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main(parseCliArgs(process.argv.slice(2)));
}
