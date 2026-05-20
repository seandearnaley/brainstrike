# Brainstrike Architecture Reset Release Candidate Notes

Generated: 2026-05-20

Branch: `codex/local-architecture-reset`

Base ref: `origin/main`

Base SHA after refresh: `0fc94414c0edb4f546faad2385762cc634df1008`

Release-candidate head before this note: `86ef7872a05473de3ebce1b70d4f09f1dfd39fce`

## Release Candidate Policy

This branch is being prepared as a local-only release candidate. No pull request, push, GitHub Actions rerun, or cloud CI path is implied by this note.

`origin/main` was fetched on 2026-05-20 and is already an ancestor of the branch. The base update is therefore intentionally a no-op: the release-candidate proof must use `origin/main` at `0fc94414c0edb4f546faad2385762cc634df1008` as the frozen base.

Proof-manifest policy is local-only:

- `.ci/proof/latest.json` is restored to the `origin/main` version in this release-candidate commit.
- The architecture reset branch will not carry a stale proof manifest from an earlier stacked PR phase.
- If this branch later moves to a PR path, a new proof manifest must be generated after the release-candidate proof and committed as the final proof-only commit.
- Until that explicit PR-path decision is made, `.ci/proof/latest.json` is not release evidence for this branch.

## Review Map

The prior branch review counted 156 commits. This release-candidate note includes that report commit as well, so the current branch contains 157 commits over `origin/main` before this note. The work maps into three review sections: pipeline, ownership, and desktop platform.

### 1. Pipeline And Proof Economics

Purpose: make the proof path risk-based, timed, deterministic, and cheaper to operate locally before any cloud path is used.

Primary review files:

- `scripts/ci-select.mjs`
- `scripts/ci-risk-rules.mjs`
- `scripts/ci-proof.mjs`
- `scripts/ci-timing-summary.mjs`
- `scripts/ci-proof-timing-summary.mjs`
- `scripts/turbo-run-diagnostics.mjs`
- `scripts/check-ci-workflow-contracts.mjs`
- `scripts/ci-risk-fixtures.json`
- `turbo.jsonc`
- `package.json`
- `.github/workflows/test.yml`
- `docs/architecture-reset/pipeline-*.json`
- `docs/architecture-reset/pipeline-*.md`
- `docs/architecture-reset/pipeline-risk-lanes-report-2026-05-20.html`

Commit map:

- Guardrail/proof setup and local-only containment: `069966598`, `4a046b733`, `543b29490`, `03f1b8857`, `021310db3`, `86792b5aa`, `9d7dc006d`, `0981bb268`, `8123b2c1f`
- Risk-based lane selection and timing ownership: `dbf3c2955`, `eae5b41e7`, `0bfba454d`, `5d145e7cc`, `580b6c6aa`, `feaaad134`, `4dad44442`, `d55a4691c`, `baefeaef7`
- Lane calibration, fixtures, and audit evidence: `5b541df74`, `ff823749b`, `4fd65edda`, `c83604768`, `3eb0b4e36`, `796d7bd7a`, `f70ab0ef2`, `701c7cea4`, `9ec93a389`, `5c5b83fdc`, `ed63bea51`, `75f38f92c`, `ee9724366`, `eaff8933d`, `2ce8eb091`, `601a3e069`, `3ea69aeec`, `5fcee9c9d`
- Release/branch reports and operating evidence: `1510ddc1b`, `86ef7872a`
- Supporting repo hygiene that affects pipeline confidence: `78f45cf4b`, `bc8b7ad37`, `5af5e71eb`, `f723a86c6`, `badd03ecb`

Reviewer focus:

- `pnpm ci:select --base origin/main --head HEAD` must deterministically classify this branch as full release risk.
- Low-risk fixture cases must not select expensive E2E or embedding diagnostics.
- Timing output must remain machine-readable and explicit about selected command budgets.
- No proof command should silently fall back to a different meaning when input is invalid.

### 2. Domain Ownership And Hotspot Reduction

Purpose: move the architecture from legal imports to practical ownership, so humans and agents can work in non-overlapping write sets.

Primary review files:

- `packages/assistant-contract/**`
- `packages/indexing-contract/**`
- `packages/pipeline/**`
- `packages/file-explorer-ui/src/{tree,preview,indexing,shell}/**`
- `packages/embeddings/src/worker/**`
- `packages/db/src/**`
- `packages/file-explorer*/**`
- `packages/app-shell/src/**`
- `packages/ui/src/**`
- `scripts/architecture-domain-contract.mjs`
- `scripts/architecture-domain-boundaries.mjs`
- `docs/architecture-reset/domain-ownership-*.{md,html}`

Commit map:

- Domain contract and boundary enforcement: `1e890540b`, `d674d1f46`, `fe73a9c13`
- Assistant contract extraction and exception retirement: `ae6a94ded`, `a015fd7a8`, `4ced8a1b0`, `98356c61f`, `815fc54da`, `d4301e44f`, `c7ac4062d`, `07d62712e`, `153d3bdf0`, `3c4bd5f93`, `0b2276983`, `5c6f3e372`, `d46a80668`
- Indexing and pipeline ownership: `44e335bcb`, `081460b00`, `5554527ef`, `fc2b79563`, `9cee7cf0b`, `a6a4791f1`, `fd24f1ebb`, `1b31ea48d`, `a3bc1c21d`, `f96f9c4bd`, `0fb48efdf`
- File explorer domain barrels and slice enforcement: `a9f91fa4a`, `14474e000`, `59d7473f6`, `a181a92fe`, `12179d7f5`, `a39a14f86`, `588172b64`, `eca779789`
- Hotspot splitting across worker, file explorer, assistant, DB, and tests: `f0a029533`, `023e55daa`, `5c5944aa8`, `a3df4c5d9`, `1632356ee`, `ba3a61e95`, `ef2176b09`, `a1a441ee8`, `037c20d7e`, `357d02299`, `d310c07c9`, `45ce042c4`, `fdf7eaa2a`, `c35bb9dc4`, `9da4710b9`, `78b64c223`, `775d33289`, `9b73da9bd`, `43e74e2b9`, `7fb604493`
- Boundary retirements, documentation, and package classification: `a709a38f9`, `a3e1978d2`, `7212bd409`, `b0a97bd0f`, `06ce4fc76`, `dbe9a2b8c`, `e4e0f686c`, `11592064c`

Reviewer focus:

- Public barrels are now the intended ownership surfaces; review deep imports carefully.
- `embedding-worker.ts` should remain a composition point over support modules, not regain provider, queue, DB, telemetry, and lifecycle responsibilities.
- `@brainstrike/pipeline` is now production-owned; it should not drift back to built-but-unused.
- Domain boundary checks must remain `0/0` exceptions.

### 3. Desktop Platform, IPC, And Local AI Hosts

Purpose: make desktop runtime behavior typed, observable, and owned by platform registries instead of ad hoc Electron IPC drift.

Primary review files:

- `apps/desktop/src/ipc-handlers.ts`
- `apps/desktop/src/ipc-registry/**`
- `apps/desktop/src/ipc-domains/**`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/embedding-host-manager.ts`
- `apps/desktop/src/llm-host-manager.ts`
- `apps/desktop/src/diagnostics/**`
- `apps/desktop/e2e/**`
- `packages/preferences/src/factory-reset/**`
- `scripts/architecture-domain-boundaries.mjs`

Commit map:

- Platform contract guardrails and preload/logging contracts: `f8051f83b`, `beee5c25f`, `2599dc51e`, `8c7d0b3a5`, `66e25641e`, `864746a60`, `07824cc57`, `a5e9717e4`, `5746facbd`
- IPC registry foundation and domain extraction: `8dee607b0`, `dbdd73478`, `ceaed9487`, `b72b0a47b`, `c384dba36`, `77371803c`, `5167697cd`, `466ee4720`, `6e1452cfa`, `b10e29d28`, `522481c37`, `f2fbc97ba`, `4878b7215`, `771938f33`, `5957e7aa1`, `952ec4f0d`, `0f1aaff29`, `82a3c14cb`, `024e5c2e1`, `ae34050d2`, `93dc0aa85`, `936895748`
- Hidden host lifecycle, renderer-only guards, diagnostics, and recovery: `1a8c5ddb0`, `32e84e630`, `ba80a78c9`, `681706e99`, `18bf6b47c`, `d28b451b2`, `2bb245623`, `a77feedd4`, `a8f8f8c47`, `eade196d0`, `a80abbe6a`, `312de842d`, `4b99b957d`
- Desktop E2E and reset lane explicitness: `f1dde9b52`
- Supporting desktop test splits and app integration: `78b64c223`, `9b73da9bd`, `43e74e2b9`

Reviewer focus:

- `apps/desktop/src/ipc-handlers.ts` should remain a thin registry/composition file.
- New IPC channels should have a named contract, owner domain, handler, preload exposure if needed, and focused test.
- Local LLM and embedding workers must remain renderer-only; architecture guards should fail on main-process imports.
- Reset and recovery behavior should prove DB, persistent UI storage, IndexedDB, CacheStorage, embedding host, and LLM host reset/recovery.

## Release Proof Plan

The release proof is intentionally one explicit run after this note and proof-policy commit land. It must not be repeated without an explicit decision, because repeat full-suite attempts are the cost problem this branch is meant to solve.

Planned commands:

1. `pnpm ci:select --base origin/main --head HEAD`
2. `git diff --check`
3. `node --test scripts/__tests__/ci-risk-rules.test.mjs scripts/__tests__/ci-select.test.mjs scripts/__tests__/ci-timing-summary.test.mjs scripts/__tests__/ci-proof-timing-summary.test.mjs scripts/__tests__/ci-proof.test.mjs scripts/__tests__/turbo-run-diagnostics.test.mjs scripts/__tests__/check-ci-workflow-contracts.test.mjs scripts/__tests__/check-ci-risk-fixtures.test.mjs scripts/__tests__/run-changed-unit-tests.test.mjs scripts/__tests__/ci-calibrate-proof-commands.test.mjs scripts/__tests__/ci-calibration-summary.test.mjs scripts/__tests__/ci-risk-audit.test.mjs`
4. `pnpm run ci:risk-fixtures`
5. `pnpm run lint:ci-workflow-contracts`
6. If selected by `ci:select`, run the full local suite command selected for `full-local-suite`.

Expected selector result for this branch:

- Lane: `full-release-high-risk`
- Label: `ci:full`
- Required command group includes: `diff-check`, `ci-script-tests`, `workflow-contracts`, and `full-local-suite`

## Done Conditions For This Release Candidate

| Condition | Required Evidence |
| --- | --- |
| Base refreshed once | `git fetch origin main`; `origin/main` remains ancestor of `HEAD`; no further base movement during proof |
| Proof-manifest ambiguity resolved | `.ci/proof/latest.json` has no diff from `origin/main` for local-only path |
| Branch review map exists | This note maps commits into pipeline, ownership, desktop platform |
| Selector agrees branch is full risk | Fresh `pnpm ci:select --base origin/main --head HEAD` output |
| Explicit proof run completed once | Fresh command output from the selected release proof |
| No cloud work triggered | No push, PR, GitHub Actions rerun, or `gh run rerun` |
| Working tree clean | `git status --short --branch` after commits and proof |

## Open Integration Choice

After the release proof, the remaining product decision is how to integrate:

- Local-only integration: keep `.ci/proof/latest.json` unchanged from `origin/main`; use this note and fresh local proof output as the evidence packet.
- PR integration: generate `.ci/proof/latest.json` after the successful proof and commit it as the final proof-only commit before opening or updating a PR.

Do not mix these policies. A stale proof manifest is worse than no proof manifest because it looks authoritative while proving the wrong head.
