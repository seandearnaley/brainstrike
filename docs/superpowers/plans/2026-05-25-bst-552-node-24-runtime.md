# BST-552 Node 24 Runtime Plan

## Ticket Validation

- Linear issue: BST-552, still open, current, and reproduced by local pnpm engine warnings under Node `v24.14.0`.
- Scope is independent from BST-80 and limited to runtime/config/docs contracts.
- Shared package `engines.node` ranges remain `>=22` intentionally for package-level library compatibility; root and app runtime targets move to strict `24.x`.

## Scope

- Update `.nvmrc`, app `.nvmrc`, root/app engine declarations, CI cache prefixes, docs, and generated dependency report copy to Node 24.
- Update the CI workflow contract so stale `node22` Turborepo cache prefixes fail validation.
- Widen the affected-unit cloud timeout contract for cold Node 24 full-risk runs after PR CI timed out in `@brainstrike/desktop:test`.
- Keep the web `process.version` define as a browser shim, updated to the repo Node target with an inline rationale.

## Verification

- RED: `pnpm run lint:ci-workflow-contracts` failed while workflow cache prefixes still used `node22`.
- RED: `pnpm run lint:ci-workflow-contracts` failed after the affected-unit timeout contract was raised before the workflow was updated.
- GREEN: `pnpm run lint:ci-workflow-contracts`
- GREEN: `node --version` returned `v24.14.0`
- GREEN: `pnpm --version` returned `10.33.0`
- GREEN: `pnpm install --frozen-lockfile`
