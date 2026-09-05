# Claude auto-review: return to `pull_request`, review every stack layer once

**Date:** 2026-09-05 · **Status:** approved, implemented in the same PR · **Supersedes:** the trigger choice in BST-1640 (#2980); keeps everything else it built.

## Problem

BST-1640 moved Claude Auto Review to `pull_request_target` for tamper-resistant orchestration. Two consequences surfaced within hours:

1. Anthropic's `github-app-token-exchange` rejects `pull_request_target` OIDC tokens (`401 Invalid OIDC token`, upstream claude-code-action#713). 7/7 automatic reviews failed. #2994 restored auth by passing `github_token`.
2. Stacked layers (base ≠ `main`) get nothing: the job's `github.ref == main` gate is false, and `prepare()` rejects a non-default base. Under `pull_request_target` this cannot be relaxed — it would execute the intermediate branch's workflow copy with base-repo credentials. The repo delivers stacks constantly; the previous `pull_request` design reviewed every layer (verified on #2959/#2960, 2026-09-04).

A third, unrelated ceiling: diffs over ~128 KiB crash the action at bash spawn (`Argument list too long`) with no disposition.

## Facts that decided the design

- Anthropic's official PR-review examples all use `pull_request`; `pull_request_target` appears only in a status-check example. Passing `github_token` is documented.
- Codex reviews stacked non-draft PRs correctly and ignores drafts; it re-reviews only on `@codex review`. No Codex change is needed.
- Claude currently reviews a draft at `opened` and again at `ready_for_review` — a double cold review.
- The action's `checkWritePermissions` runs on every PR context regardless of token source (#2994's docs claimed otherwise; corrected here).
- 60/60 recent PRs are authored by the repository owner. There is no CODEOWNERS file and `require_code_owner_review` is off; in a one-human repo it could not be satisfied anyway.

## Design

**Trigger.** `pull_request: [opened, ready_for_review, reopened]` + existing `workflow_dispatch`. Job condition: `event_name == 'workflow_dispatch' || pull_request.draft == false`. The `github.ref == main` gate is removed.

**Trust.** Under `pull_request` the workflow file and script run as PR-author code with `CLAUDE_CODE_OAUTH_TOKEN` and a write token in scope — that is the exposure accepted in exchange for stack coverage; mitigations (secret rotation cadence, protected `environment:`) are GitHub-side options. Dispatch pins `refs/heads/<default>`; `pull_request` pins `refs/pull/<N>/merge`, which derives from the same payload as `GITHUB_REF`, so the checkout-equals-`GITHUB_SHA` check is the load-bearing one. Any branch of this repository is an acceptable base (stacked layers pass; the base-repo comparison is a malformed-response tripwire). Head must be in this repository for automatic runs; fork runs hold a read-only token, so their skip reaches the job summary but not the PR. Live head/base rechecked before and after capture. `github_token` stays; `id-token` stays off. The `--ref main` dispatch remains the trusted path for reviewer-touching PRs.

**Size.** If the encoded prompt exceeds 100 KiB, `prepare()` emits an **incomplete** disposition stating the size, the budget, and "split this PR." No narrower diff is substituted.

**Budget (both reviewers).** One automatic review per lifecycle event; one targeted follow-up (Claude dispatch / `@codex review`) after the fix batch. Restacking and base-retarget trigger nothing.

## Rejected

- *Keep `pull_request_target`, relax base check* — runs PR-author workflow code with base credentials for stacked layers.
- *`pull_request` → `workflow_run` two-stage* — tamper-proof and stack-capable, but a second workflow plus SHA→PR plumbing to defend against the owner's own agents editing a file the owner reads anyway.

## Verification

Contract test pins the trigger, the explicit draft gate, `types:` without `synchronize`, single `github.token` input, no `id-token`, no PR-head checkout. Script tests cover: stacked base accepted (automatic and dispatch), malformed base payload rejected, `pull_request_target` rejected, wrong ref for the event rejected, oversize → incomplete with size and no dispatch hint, plus all prior cases. First live proof of the automatic path is the next non-draft PR opened after merge; the dispatch path was live-verified on `4848137e9`.
