@AGENTS.md

# Claude Code Instructions

## Agent skills

### Issue tracker

Issues are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels without overrides. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context layout. See `docs/agents/domain.md`.

## GitHub PR Auto Review Workflow

When running inside `.github/workflows/claude-code-review.yml`, tool access is intentionally narrow.

- Use only:
  - `mcp__github_inline_comment__create_inline_comment`
  - `gh pr view ...`
  - `gh pr diff ...`
  - `gh pr comment ...`
- Do not run generic shell or git commands such as `git log`, `git branch`, or `git status`.
  - These commands are not allowed in this workflow and cause the review job to fail.
- If you need repository context, rely on `gh pr view` and `gh pr diff` instead of local git inspection.
