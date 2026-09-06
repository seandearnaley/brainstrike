import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/claude-code-review.yml', 'utf8');

test('automatic review runs on pull_request for any base; targeted review runs trusted default-branch code', () => {
  // pull_request runs from the PR merge commit for every base branch, so each
  // layer of a stack is reviewed against its own parent. pull_request_target is
  // ruled out: it would execute the intermediate branch's workflow copy, and
  // Anthropic's App exchange rejects its OIDC token anyway.
  assert.match(workflow, /^ {2}pull_request:/m);
  assert.doesNotMatch(workflow, /^ {2}pull_request_target:/m);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  // Drafts are reviewed at ready_for_review, not at open. The pull_request
  // clause must be explicit: GitHub coerces `null == false` to true.
  assert.match(
    workflow,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false\) \}\}/
  );
  assert.doesNotMatch(workflow, /github\.ref == format\('refs\/heads/);
  assert.match(workflow, /expected_head:/);
  assert.match(workflow, /focus:/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /ref:.*pull_request.head/);
});

test('review authenticates with the workflow token, never the App exchange', () => {
  // The App exchange validates OIDC event_name against an allowlist
  // (anthropics/claude-code-action#713 shows it rejecting pull_request_target).
  // Supplying github_token skips the exchange for every event type, so no
  // trigger choice can reintroduce that dependency. The action must receive the
  // workflow's own token and nothing broader, and the OIDC grant stays off.
  // Assert every occurrence, not just that one good one exists: a second
  // `github_token:` from any other source would otherwise reopen the App path.
  const tokenInputs = workflow.match(/github_token:.*/g) ?? [];
  assert.equal(tokenInputs.length, 1);
  assert.match(tokenInputs[0], /^github_token: \$\{\{ github\.token \}\}$/);
  assert.doesNotMatch(workflow, /id-token:/);
});

test('reporting always consumes explicit Claude conclusion instead of green eligibility', () => {
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /ACTION_CONCLUSION: \$\{\{ steps.claude-review.outputs.conclusion \}\}/);
  assert.match(
    workflow,
    /REVIEW_OUTPUT: \$\{\{ steps.claude-review.outputs.structured_output \}\}/
  );
  assert.match(workflow, /ACTION_OUTCOME: \$\{\{ steps.claude-review.outcome \}\}/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /node scripts\/claude-review.mjs report/);
});

test('review reads captured diff and preserves bounded lifecycle and targeted dispatch', () => {
  assert.match(workflow, /types: \[opened, ready_for_review, reopened\]/);
  assert.doesNotMatch(workflow, /types:.*synchronize/);
  assert.match(workflow, /prompt: \$\{\{ steps.request.outputs.prompt \}\}/);
  assert.match(workflow, /claude_args: \$\{\{ steps.request.outputs.claude_args \}\}/);
});
