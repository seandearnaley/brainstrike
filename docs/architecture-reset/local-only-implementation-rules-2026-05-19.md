# Local-Only Architecture Reset Rules

Date: 2026-05-19

This branch is the local implementation branch for the Brainstrike architecture
reset. It replaces the stacked PR workflow for this effort.

## Hard Rules

- Do not push this branch unless explicitly instructed.
- Do not open or update pull requests from this branch.
- Do not run `pnpm ci:prove` or `pnpm ci:verify-proof`.
- Do not refresh `.ci/proof/latest.json`.
- Do not run GitHub Actions commands that rerun or trigger workflows.
- Prefer targeted local tests for the package or file being changed.
- Commit each coherent architecture slice locally.

## Goal

Deliver real architecture change, not more process scaffolding. The branch should
reduce cross-domain imports, clarify package ownership, and make future agent
work more deterministic.

## Local Artifacts

- `docs/architecture-reset/peripheral-package-classification-2026-05-19.html`
  records the keep/revive/absent decisions for the packages originally flagged
  as zero-import or dormant.

## Local Verification Policy

Use red-green TDD for behavior changes. Start with the smallest local test that
proves the new boundary or contract, then broaden only when the slice is stable.

Broad local checks and E2E matrices require explicit approval before running.
