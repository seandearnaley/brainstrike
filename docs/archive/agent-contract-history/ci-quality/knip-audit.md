# Knip audit — evidence

Supports `docs/agents/ci-quality.md` § "REACT DOCTOR (LINT)" — the rule that
Knip, not React Doctor, owns file/dependency graph analysis (BST-1761,
BST-1642). Read this before promoting the audit to a PR gate, adding a baseline
or threshold, re-enabling React Doctor's graph rules, or trying workspace-scoped
Knip `rules`. Initial inventory: `docs/knip-audit-2026-09-18.md`.

## Ownership and the scheduled workflow

- **Knip is the authoritative file/dependency auditor.** `.github/workflows/knip.yml`
  runs `pnpm knip` weekly (Monday 06:37 UTC) and via `workflow_dispatch`, followed by
  `node scripts/check-knip-liveness.mjs`. Owner: Sean Dearnaley (`@seandearnaley`),
  BST-1761. Findings, prerequisite build failures and tool failures remain nonzero;
  no `continue-on-error`, tolerated baseline, or issue-count threshold is allowed.
  The owner inspects failed Actions runs and dispositions findings in BST-1761.
  Dispatch with `gh workflow run knip.yml --ref main` once the workflow is merged;
  schedules use the default branch. The 15-minute job timeout bounds setup plus
  both scans; each liveness subprocess is additionally bounded to two minutes.
  The audit is separate from required PR checks: local initial cost was 14.62s,
  but runner install cost and sustained signal are not yet measured. Promote to
  a PR gate only with that evidence, not by adding a second whole-graph scan.
  See `docs/knip-audit-2026-09-18.md` for the initial inventory and measurements.
  React Doctor 0.9.13 removed deslop; its native graph rules are opt-in and excluded
  from changed/staged scans. `doctor.config.ts` explicitly disables that analysis
  and its six native graph rules so dependency exceptions have one owner.
  This audit covers unused files/dependencies. Renderer source cycles remain
  owned by `lint:no-source-cycles`, and built bundle cycles by
  `scripts/verify-no-cross-chunk-cycles.mjs`; disabling React Doctor's graph
  rules does not disable either guard.
  Knip's existing export/type/duplicate exclusions remain; a clean audit is not
  proof that every exported compatibility helper has a production caller.

## Local command and known Knip limits

Local and scheduled dependency audit: run `pnpm knip` from the repository root after installing
dependencies. The command builds `@brainstrike/platform-utils` and
`@brainstrike/build-utils` through the bounded Turbo wrapper before Knip loads
the Vite/Playwright configs, so absent
`dist/` directories need no manual preparation; a failed build stops the audit,
and an audit failure remains nonzero. `scripts/__tests__/knip-workflow.test.mjs`
exercises that command ordering and both failure paths. The web-only
`@brainstrike/mcp-app-host-ui` ignore documents its real CSS `@import`, which the
workspace's TS/TSX project glob does not follow. Knip 6.32.2 (installed when
this was tried; the catalog pin is now `^6.34.0`, not re-tested) rejected
workspace-level `rules` (including `exports: "warn"`), so the BST-1642 trial for
`types`, `utils`, `logging`, `tokenization`, and `worker-runtime` has no warning
counts; keep existing global severities until a version supporting scoped rules
is deliberately adopted. App category registration is tested through each app's
rendered settings navigation; settings-ui tests must not read either app's source
without declaring those cross-package inputs in Turbo.
