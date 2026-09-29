import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (filePath) => readFileSync(path.join(repoRoot, filePath), 'utf8');

const agents = readRepoFile('AGENTS.md');
const domain = readRepoFile('docs/agents/domain.md');
const issueTracker = readRepoFile('docs/agents/issue-tracker.md');
const triageVocabulary = readRepoFile('docs/agents/triage-labels.md');

test('review and CI budgets are discoverable without an external delivery skill', () => {
  const quality = readRepoFile('docs/agents/ci-quality.md');
  assert.match(agents, /PR review\/remediation, stacked delivery, CI reruns.*ci-quality\.md/);
  for (const rule of [
    /45 minutes/,
    /90 minutes without an exact-head-ready PR layer/,
    /initial whole-PR review and one re-review/,
    /Do not push each comment\s+separately/,
    /Keep one CI watcher/,
    /Do not close\/reopen PRs/,
    /before rebasing descendants once/,
  ]) {
    assert.match(quality, rule);
  }
});

test('AGENTS routes each external engineering-skill contract exactly once', () => {
  for (const contractPath of [
    'docs/agents/issue-tracker.md',
    'docs/agents/triage-labels.md',
    'docs/agents/domain.md',
  ]) {
    assert.equal(
      agents.split(contractPath).length - 1,
      1,
      `${contractPath} must have exactly one canonical AGENTS.md route`
    );
  }
});

test('the tracker contract keeps Linear authoritative while naming active GitHub exceptions', () => {
  const claudeWorkflow = readRepoFile('.github/workflows/claude.yml');
  assert.match(claudeWorkflow, /^\s*issues:/m, 'the Claude workflow still accepts issues');
  assert.match(
    claudeWorkflow,
    /^\s*issue_comment:/m,
    'the Claude workflow still accepts issue comments'
  );

  assert.match(issueTracker, /Brainstrike[\s\S]*Linear[\s\S]*`BST-###`/);
  assert.match(issueTracker, /CI-owned GitHub Issue notifiers/);
  assert.match(issueTracker, /\.github\/workflows\/claude\.yml/);
  assert.match(issueTracker, /not the authoritative work tracker/i);
  assert.doesNotMatch(
    issueTracker,
    /\bgh issue\b/,
    'agents must not receive GitHub Issue commands'
  );
});

test('the triage contract pins live Linear representations and canceled-state recovery', () => {
  for (const expectedMapping of [
    '| `needs-triage` | `needs-triage` label | Available |',
    '| `needs-info` | `needs-info` label | Available |',
    '| `ready-for-agent` | `agent-ready` label | Available |',
    '| `ready-for-human` | `needs-human` label | Available |',
    '| `wontfix` | `Canceled` issue state | Available; no state label is applied |',
  ]) {
    assert.match(triageVocabulary, new RegExp(expectedMapping.replaceAll('|', '\\|')));
  }

  assert.match(
    triageVocabulary,
    /leaving `wontfix`[\s\S]*transition[\s\S]*`Backlog`/i,
    'leaving wontfix must reactivate the Linear issue before applying a label-backed role'
  );
});

test('the domain contract reports the root glossary seam factually', () => {
  const contextExists = existsSync(path.join(repoRoot, 'CONTEXT.md'));
  if (contextExists) {
    assert.doesNotMatch(domain, /root glossary has not\s+yet been created/i);
    return;
  }

  assert.match(domain, /root glossary has not\s+yet been created/i);
  assert.match(domain, /AGENTS\.md[\s\S]*docs\/agents\/[\s\S]*docs\/adr\//);
});
