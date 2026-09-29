# Official conformance run evidence and gate posture — evidence

Supports `docs/agents/mcp-conformance.md` § "Official conformance evidence"
(BST-1557, BST-1582, BST-1589, BST-1590). Read this before changing an
evidence artifact's shape, the `required` claim, the Windows Job Object owner,
or a workflow budget. The contract holds the rules; this is the record of the
promotion runs, the artifact fields, and the budget arithmetic.

## Why this contract exists

# MCP conformance and verification contract

Owner of the MCP verification harness (`@brainstrike/mcp-test-lab`), the
production official-conformance client, the bounded official-runner driver, the
evidence schemas, and the durable official conformance evidence links. It was
split out of `docs/agents/assistant-providers.md` under BST-1590 so that every
conformance landing stops rewriting the provider contract; CI trigger shape,
budgets, and the red-`main` exit condition stay in `docs/agents/ci-quality.md`.
Update this document and `scripts/__tests__/mcp-verification-ci-contract.test.mjs`
in the same change.


## The durable green runs

## Official conformance evidence (BST-1589)

The first complete green official auth dispatch was
[run 33541373505](https://github.com/seandearnaley/brainstrike/actions/runs/33541373505):
28/28 baseline auth and 11/11 modern auth closeout, with zero expected failures.
The same matrices then passed twice at merged-main commit
`f76ec5149fa435a541eca2c56e42be02da6d7e32` in
[run 33545728828](https://github.com/seandearnaley/brainstrike/actions/runs/33545728828)
and
[run 33545945643](https://github.com/seandearnaley/brainstrike/actions/runs/33545945643).
These links are the durable run evidence; counts copied into prose do not replace
the exact-head workflow and its sanitized artifacts. This is protocol-lab proof,
not packaged Electron or live-provider acceptance evidence.

## Evidence artifacts, gate posture, and Windows ownership

The baseline driver writes one atomic, mode-0600
`packages/mcp-test-lab/artifacts/official-auth-evidence.json` file; the modern
closeout writes only
`packages/mcp-test-lab/artifacts/official-auth-modern-closeout-evidence.json`.
The baseline preserves BST-1560 schema `1.0.0` exactly and has no `profile` field;
the modern artifact uses schema `1.1.0` and records
`profile: "modern-closeout"`. Both bind their owning ticket, exact Git head and
clean/dirty state, verified empty ledgers, wave timings, fixed result ids, cleanup
status, and the explicit `{ prerelease: true, required: true }` conformance
classification. `required` records the project's gate posture (the official
jobs carry no `continue-on-error`; `mcp-verification-ci-contract.test.mjs`
pins the field to that absence), not whether a given run happened in CI, so a
local `pnpm run verify:mcp:official` writes the same value. No raw auth
artifact directory exists. On Windows (BST-1557, a bounded child of the
BST-1472 verifier project), the outer driver loads the existing
`@brainstrike/windows-job-native` capability from Desktop and assigns itself to
its kill-on-close Job Object before the first scenario spawn.
Sequential Windows runs clean each scenario's descendants before starting
the next; parallel baseline runs defer cleanup until all siblings in a revision
wave settle so one scenario cannot terminate another. Authoritative Job membership
is then checked and remaining descendants are terminated. Timeout, failed start, failed exit
and cleanup failure remain visible;
there is no process-enumeration fallback. The bundled desktop process entry
accepts only the exact auth context rules above and otherwise emits one fixed
stderr line. The official package is prerelease, and the evidence records it as
such; since BST-1582 the three official conformance jobs are nonetheless
required post-merge gates: they run on every push to `main` (plus the nightly
schedule and manual dispatch), a failing scenario fails the workflow and turns
`main` red, and — because they run after the merge — they detect regressions
rather than block them. `docs/agents/ci-quality.md` owns the trigger shape,
budget, and exit condition.

## Workflow budget arithmetic

The modern workflow step has a ten-minute timeout: eleven sequential 45-second
deadlines consume at most 495 seconds, leaving 105 seconds for runner setup,
cleanup, and evidence persistence. Its 21-minute required job also reserves four
minutes for the build, three for the bounded Electron provisioning step, and
four for workflow setup/upload. Contract tests compare
these values to the shared descriptor; per-scenario deadlines are not shortened.
