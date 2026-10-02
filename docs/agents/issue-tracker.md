# Issue tracker: Linear

> **Consumer:** external engineering skills installed in an agent environment.
> They are not vendored by this repository; this file configures them when they
> are available.

Human- and agent-authored product work, engineering tickets, and specs live in
the **Brainstrike** team in Linear and use the `BST-###` identifier space.
GitHub Issues are not the authoritative work tracker for this repository.

## GitHub Issue exceptions

- CI-owned GitHub Issue notifiers are limited to the `main-broken` push notifier
  in `test.yml` (`docs/agents/ci-quality.md`); nightly alerts go to Linear.
- `.github/workflows/claude.yml` accepts issues and issue comments containing
  `@claude` as a legacy request-ingress surface. Capture any resulting product
  or engineering work in Linear before implementation or PR handoff.

These exceptions do not authorize external engineering skills to create or use
GitHub Issues as tracker records.

## Authority and access

- Use the connected Linear integration for issue reads and writes. If it is
  unavailable or lacks a required capability, surface that failure and stop.
- Resolve exact `BST-###` identifiers before acting. Include current comments,
  labels, state, assignee, project, and blocking/related issue edges when the
  operation depends on them.
- Re-read live issue state immediately before and after a mutation. Historical
  plans and repository references are evidence, not current tracker state.
- Creating or mutating an issue, comment, relation, assignment, or label
  requires the user's explicit authorization.

## Pull requests

GitHub pull requests are implementation and review artifacts, not tracker
items. They are not part of the external triage queue. Every human-authored PR
description must contain its Linear identifier in exact `BST-###` form; see
`docs/agents/ci-quality.md`.

## Skill operations

When a skill says **publish to the issue tracker**, create a Linear issue in the
Brainstrike team with the approved title, description, state, priority, labels,
project, and relations. Re-read the created issue and report its `BST-###`
identifier and URL.

When a skill says **fetch the relevant ticket**, retrieve the exact Linear
issue plus the comments and relations needed by the task. Do not substitute a
GitHub issue, local markdown file, stale document, or inferred state.

Use Linear's native parent, blocking, blocked-by, duplicate, and related-issue
relations. If the connected integration cannot represent a required relation,
report the unsupported capability instead of encoding an alternate relation in
free-form text.
