## Summary

-

## Validation

-

## CI Plan

- [ ] Ran `pnpm ci:select --base origin/main --head HEAD`
- [ ] Reviewed the computed `risk`, `requiredJobs`, and E2E matrices
- [ ] Ran the relevant listed `localCommands` or documented why cloud-only is sufficient
- [ ] Did not add CI routing labels or commit generated proof artifacts

Use `origin/main` for PRs targeting `main`; replace it with the target branch ref
when inspecting a PR against another branch.
