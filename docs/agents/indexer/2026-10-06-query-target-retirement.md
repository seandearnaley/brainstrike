# Native query target retirement

The normal root dev candidate reached native readiness and progressed through
source scanning. At `2026-10-06T04:07:06.587Z`, isolated coverage began failing
with `Native coverage query target is unavailable.` The coordinator's live
status observation still reported a ready, authorized native writer and an
incomplete source scan. No full runtime failure appeared in that launch log.
The original database persisted and continued progress was observed earlier.

Evidence: `/Users/seandearnaley/Documents/brainstrike-m2-completion-20261005/root-dev-startup/reader-sequenced-root-dev.log`.
The log has no source-removal trace, so it does not identify the exact operation
that cleared the live target. No extra app launch or user-data mutation was
performed for this investigation.

Focused controls reproduce two concrete paths in the real runtime owner:

- A successful canonical source-removal mutation closes query owners and clears
  their target. Unchanged catalog identities then admitted a read through the
  cached writer without reinstalling the target.
- A catalog change after query retirement interrupts acquisition. If the
  catalog returns to the prior identities, the cached writer likewise admitted
  coverage while the target remained absent.

The runtime now invalidates its existing binding-readiness cache at every query
retirement. It publishes that cache only after final authority validation and
successful query-target installation. A retained query-retirement promise blocks
acquisition after failed physical cleanup until explicit terminal cleanup joins
the original query owners. Failed mutations retain their existing admission
failure; graceful shutdown cannot reinstall the target.

This changes no public API, writer ownership, timeout, scan-completion predicate,
or query-validation contract. The committed initial-window sequencing remains
intact. It does not claim the live scan completed or the final app proof passed.

Validation from `apps/desktop`:

- RED on the unchanged `11b64b095` runtime: 5 failures / 21 passing controls in
  `native-index-runtime.test.ts` (`/tmp/m2-query-target-final-red.log`). The
  failures cover successful removal, interrupted catalog acquisition, failed
  physical cleanup, failed target installation, and failed final validation.
- `pnpm exec vitest run src/__tests__/native-index-runtime.test.ts src/__tests__/native-index-activation.test.ts src/__tests__/native-index-source-retirement.test.ts src/__tests__/sqlite-query-host-manager.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism`: 51/51 passed (`/tmp/m2-query-target-final-green.log`).
- `pnpm exec biome check --write src/native-index-runtime.ts src/__tests__/native-index-runtime.test.ts`: exit 0 (`/tmp/m2-query-target-format.log`).
- `pnpm exec tsc --noEmit --project tsconfig.main.json`: exit 0 (`/tmp/m2-query-target-main-types.log`).
- `pnpm exec tsc --noEmit --project tsconfig.test.json`: exit 0 (`/tmp/m2-query-target-test-types.log`).
- `git diff --check`: exit 0.

The broader `native-authority-observation.test.ts` run has 7 failures / 10 passes,
reproduced on the unchanged committed runtime (`/tmp/m2-query-target-authority-baseline.log`).
Five assertions expect an older missing-mode message; two expect rejected
status for invalid preferences while the current contract returns unavailable
status. Those failures are preserved and are outside this runtime repair.
The broad run is not green. Full regression and final normal root dev app proof
remain delivery-owned checks.

**CI is disabled due to cost; validation must run locally.**
