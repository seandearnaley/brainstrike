import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT_DIR = 'docs/agents';

/**
 * SHRINK-ONLY CONTRACT BUDGETS — same shape as the file budget in
 * docs/agents/ci-quality.md § "SHRINK-ONLY FILE BUDGETS"; do not turn it into a
 * cap with headroom.
 *
 * An agent reads a whole contract before touching its area, so every line is
 * paid for on every task. Each number is the file's CURRENT line count, never an
 * allowance. Growth fails: move the material to an evidence file
 * (`docs/agents/<area>/<topic>.md`, exempt from this budget) per
 * docs/agents/README.md. The budget is an EXACT pin, not a ceiling: shrinking
 * below it fails too, so the number is lowered in the same commit. A tolerance
 * band would let a contract shed a few lines without re-baselining and a later
 * change add them back while still passing.
 */
const CONTRACT_LINE_BUDGETS = {
  '_freshness-report.md': 41,
  'agent-self-query.md': 644,
  'assistant-persistence.md': 4035,
  'assistant-providers.md': 5609,
  'assistant-runtime.md': 4944,
  'assistant-subagents.md': 3080,
  'changeset-diff.md': 1168,
  'ci-quality.md': 924,
  'code-execution.md': 841,
  'database.md': 1670,
  'domain.md': 37,
  'explorer-search-tapestry.md': 1474,
  'issue-tracker.md': 56,
  'local-inference.md': 809,
  'mastra-boundary.md': 991,
  'mcp-conformance.md': 393,
  'platform-contracts.md': 2632,
  'README.md': 52,
  'triage-labels.md': 35,
  'ui-conventions.md': 898,
  'workspace-context.md': 1845,
};

/** Returns the failure message, or null when the count sits inside the budget. */
export function checkShrinkOnlyBudget(label, lineCount, budget) {
  if (lineCount > budget) {
    return (
      `${label} grew to ${lineCount} lines, past its shrink-only budget of ${budget}. ` +
      'Move the new material to an evidence file (docs/agents/README.md); do not raise the number.'
    );
  }
  if (lineCount < budget) {
    return (
      `${label} shrank to ${lineCount} lines. Lower its budget from ${budget} to ${lineCount} ` +
      'in this commit so the recovered headroom cannot be spent later.'
    );
  }
  return null;
}

const contractFiles = readdirSync(path.join(repoRoot, CONTRACT_DIR), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)
  .sort();

test('every agent contract is registered with a line budget', () => {
  assert.deepEqual(contractFiles, Object.keys(CONTRACT_LINE_BUDGETS).sort());
});

test('agent contracts stay inside their shrink-only line budgets', () => {
  const failures = contractFiles
    .filter((name) => name in CONTRACT_LINE_BUDGETS)
    .map((name) => {
      const source = readFileSync(path.join(repoRoot, CONTRACT_DIR, name), 'utf8');
      return checkShrinkOnlyBudget(
        `${CONTRACT_DIR}/${name}`,
        source.split('\n').length,
        CONTRACT_LINE_BUDGETS[name]
      );
    })
    .filter((failure) => failure !== null);
  assert.deepEqual(failures, []);
});

test('the budget can fail in both directions', () => {
  assert.equal(checkShrinkOnlyBudget('doc', 100, 100), null);
  assert.match(checkShrinkOnlyBudget('doc', 101, 100), /grew to 101 lines/);
  assert.match(checkShrinkOnlyBudget('doc', 99, 100), /Lower its budget from 100 to 99/);
});
