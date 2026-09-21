import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT_DIR = 'docs/agents';
const EVIDENCE_DIRS = ['ci-quality'];

/**
 * `_`-prefixed docs are generated or periodically regenerated audit artifacts
 * (`_freshness-report.md`), not contracts an agent reads before a change. An
 * exact pin on a regenerated report fails on regeneration with advice its
 * author cannot act on, and "shrink-only" is meaningless for one.
 */
const isContractDoc = (name) => name.endsWith('.md') && !name.startsWith('_');

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
  'agent-self-query.md': 644,
  'assistant-persistence.md': 4035,
  'assistant-providers.md': 5609,
  'assistant-runtime.md': 4944,
  'assistant-subagents.md': 3080,
  'changeset-diff.md': 1168,
  'ci-quality.md': 3957,
  'code-execution.md': 841,
  'database.md': 1670,
  'domain.md': 37,
  'explorer-search-tapestry.md': 1474,
  'issue-tracker.md': 56,
  'local-inference.md': 809,
  'mastra-boundary.md': 991,
  'mcp-conformance.md': 393,
  'platform-contracts.md': 2632,
  'README.md': 70,
  'triage-labels.md': 35,
  'ui-conventions.md': 898,
  'workspace-context.md': 1845,
};

/**
 * Line counts are `source.split('\n').length`, matching the app-shell precedent:
 * that is one MORE than `wc -l` for a newline-terminated file. Lowering a budget
 * by hand means using this number, not `wc -l`.
 *
 * Returns the failure message, or null when the count matches the budget.
 */
function checkShrinkOnlyBudget(label, lineCount, budget) {
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
  .filter((entry) => entry.isFile() && isContractDoc(entry.name))
  .map((entry) => entry.name)
  .sort();

test('every contract doc in docs/agents is registered with a line budget', () => {
  assert.deepEqual(contractFiles, Object.keys(CONTRACT_LINE_BUDGETS).sort());
});

test('agent contracts stay inside their shrink-only line budgets', () => {
  const failures = contractFiles
    .filter((name) => Object.hasOwn(CONTRACT_LINE_BUDGETS, name))
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

/** Citations are prose-wrapped across lines; compare on collapsed whitespace. */
const flatten = (text) => text.replace(/\s+/gu, ' ').trim();

/**
 * Anchored, not a substring test: a citation must name the WHOLE heading, or
 * the whole heading minus a trailing parenthetical (a ticket id, a filename, a
 * settled-on date). A substring test would let § "Coverage" satisfy
 * "Coverage is a separate workflow", which is the mis-citation worth catching.
 */
const citesHeading = (heading, wanted) =>
  heading === wanted || (heading.startsWith(`${wanted} (`) && heading.endsWith(')'));

test('every evidence file names a section its contract actually has', () => {
  const failures = [];
  for (const area of EVIDENCE_DIRS) {
    const contract = readFileSync(path.join(repoRoot, CONTRACT_DIR, `${area}.md`), 'utf8');
    const headings = contract
      .split('\n')
      .filter((line) => /^#{2,4} /.test(line))
      .map((line) => flatten(line.replace(/^#+ /, '')));
    for (const name of readdirSync(path.join(repoRoot, CONTRACT_DIR, area)).sort()) {
      const file = `${area}/${name}`;
      const source = readFileSync(path.join(repoRoot, CONTRACT_DIR, file), 'utf8');
      const cited = source.match(/§ "([^"]+)"/u);
      if (!cited) {
        failures.push(`${file} does not cite the contract section it supports (§ "<heading>")`);
        continue;
      }
      const wanted = flatten(cited[1]);
      if (!headings.some((heading) => citesHeading(heading, wanted))) {
        failures.push(`${file} cites § "${wanted}", which is not a heading in ${area}.md`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

/**
 * isFile, not exists: `existsSync` accepts a directory, so a directory named
 * `<topic>.md` would count as resolved while pointing at nothing readable.
 * `throwIfNoEntry: false` keeps a missing target a reported failure rather than
 * a throw, while a permission error stays loud.
 */
const pointerResolves = (target) => statSync(target, { throwIfNoEntry: false })?.isFile() === true;

test('every evidence pointer in a contract resolves to a file', () => {
  const failures = [];
  for (const name of contractFiles) {
    const source = readFileSync(path.join(repoRoot, CONTRACT_DIR, name), 'utf8');
    // Only `<area>/<topic>.md` pointers, so repo-root paths like `docs/x.md`
    // elsewhere in a contract are not mistaken for evidence references.
    const pointers = new RegExp(
      String.raw`\x60((?:${EVIDENCE_DIRS.join('|')})/[a-z0-9-]+\.md)\x60`,
      'gu'
    );
    for (const [, pointer] of source.matchAll(pointers)) {
      if (!pointerResolves(path.join(repoRoot, CONTRACT_DIR, pointer))) {
        failures.push(`${name} points at ${pointer}, which is not a readable file`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('a pointer resolves only to a readable regular file', () => {
  const area = path.join(repoRoot, CONTRACT_DIR, EVIDENCE_DIRS[0]);
  assert.equal(pointerResolves(path.join(area, 'claude-review.md')), true);
  assert.equal(pointerResolves(path.join(area, 'does-not-exist.md')), false);
  // The directory itself: what a revert to existsSync would wrongly accept.
  assert.equal(pointerResolves(area), false);
});

test('a citation must name the whole heading, not a fragment', () => {
  assert.equal(citesHeading('Workload boundaries', 'Workload boundaries'), true);
  assert.equal(citesHeading('Workload boundaries (BST-1)', 'Workload boundaries'), true);
  assert.equal(citesHeading('Coverage is a separate workflow', 'Coverage'), false);
  assert.equal(citesHeading('Workload boundaries extended', 'Workload boundaries'), false);
});

test('the budget can fail in both directions', () => {
  assert.equal(checkShrinkOnlyBudget('doc', 100, 100), null);
  assert.match(checkShrinkOnlyBudget('doc', 101, 100), /grew to 101 lines/);
  assert.match(checkShrinkOnlyBudget('doc', 99, 100), /Lower its budget from 100 to 99/);
});
