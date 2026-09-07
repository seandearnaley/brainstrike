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

test('the prompt never becomes an argument or an environment variable', () => {
  // The load-bearing contract. anthropics/claude-code-action's only prompt input
  // is `prompt`, and its action.yml carries that into the runner through
  // environment variables, where Linux caps one at 128 KiB (MAX_ARG_STRLEN).
  // Invoking the CLI directly puts the prompt on stdin instead, which is a pipe
  // and has no size limit. Reintroducing the action would silently restore the
  // ceiling, so its absence is asserted rather than assumed.
  // Match usage, not the word: the comment above the step names the action to
  // explain why it is gone, and that explanation must not fail its own test.
  assert.doesNotMatch(workflow, /^\s*uses:.*claude-code-action/m);
  assert.doesNotMatch(workflow, /^\s*prompt:/m);
  assert.doesNotMatch(workflow, /claude_args:/);
  // The CLI is pinned by exact version, the way the action used to be by SHA.
  assert.match(workflow, /npm install --global @anthropic-ai\/claude-code@\d+\.\d+\.\d+$/m);
  assert.match(workflow, /run: node scripts\/claude-review.mjs run/);
});

test('only the OAuth credential reaches the model step, and no App identity exists', () => {
  // With the action gone there is no App-token exchange to route around and no
  // OIDC allowlist to trip (claude-code-action#713). The OAuth token is the sole
  // secret in scope, and the trusted reporter publishes with the workflow token.
  const secrets = [...workflow.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(secrets, ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.doesNotMatch(workflow, /id-token:/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('reporting always consumes an explicit step outcome instead of green eligibility', () => {
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /ACTION_OUTCOME: \$\{\{ steps.claude-review.outcome \}\}/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /node scripts\/claude-review.mjs report/);
  // The review text comes off disk. Carrying it back through an environment
  // variable would reintroduce the same class of limit in the other direction.
  assert.doesNotMatch(workflow, /REVIEW_OUTPUT:/);
  assert.doesNotMatch(workflow, /structured_output/);
});

test('review preserves the bounded lifecycle and gates every model step on eligibility', () => {
  assert.match(workflow, /types: \[opened, ready_for_review, reopened\]/);
  assert.doesNotMatch(workflow, /types:.*synchronize/);
  // Both the install and the run must be gated, or an ineligible PR would still
  // spend a runner and, worse, could reach the CLI without a prepared request.
  const gated = workflow.match(/if: \$\{\{ steps.request.outputs.eligible == 'true' \}\}/g) ?? [];
  assert.equal(gated.length, 2);
});

test('the probe checks the exact CLI version the workflow installs', () => {
  // Two independent literals for one version is a drift hazard: the probe could
  // certify a boundary on a build CI never runs. Pin them to each other.
  const probe = readFileSync('scripts/probe-claude-review-tools.mjs', 'utf8');
  const installed = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(workflow);
  const asserted = /assert\.equal\(version, '(\d+\.\d+\.\d+) \(Claude Code\)'/.exec(probe);
  assert.ok(installed, 'the workflow must pin an exact CLI version');
  assert.ok(asserted, 'the probe must assert an exact CLI version');
  assert.equal(asserted[1], installed[1]);
});
