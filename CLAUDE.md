@AGENTS.md

# Claude Code Instructions

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
