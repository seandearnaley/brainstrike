## Summary

-

## Validation

-

## CI Proof

- [ ] Ran `pnpm ci:select --base origin/main --head HEAD`
- [ ] Added every listed `ci:*` label to this PR
- [ ] Ran `pnpm ci:prove --base origin/main --head HEAD`
- [ ] Committed `.ci/proof/latest.json` as the final proof-only commit
- [ ] Ran `pnpm ci:verify-proof --base origin/main --head HEAD --labels '<ci:labels>'`

Use `origin/main` for PRs targeting `main`; replace it with the target branch ref
when opening a PR against another branch.
