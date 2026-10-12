# Populated native startup allowance

The native writer performs full SQLite, porter/trigram FTS, canonical binding,
vector and scoped-store validation before readiness. The original deadline was
five seconds; increasing it to fifteen seconds and sequencing native reader
readiness ahead of the first visible renderer did not support the grown store
under the normal root dev workload.

The previously retained 323 MB store completed full checks in 3.322 seconds with
the app closed. Loaded traces showed SQLite integrity taking 6.386 seconds,
porter FTS 2.232 seconds and trigram validation still running at fifteen seconds.
The sequencing candidate initially succeeded and indexing grew the original
store to about 586 MB / 8,007 acknowledged files. A final normal root build and
dev launch on `b345a52a0` again exceeded fifteen seconds before readiness.

The coordinator then measured the grown original store's full validation at
5,455.9 ms with the app closed. All checks passed and its SHA-256 remained
unchanged. These results demonstrate launch-workload contention and a populated
validation cost, rather than evidence that validation may be removed. They do
not measure foreground p95, a cross-platform bound, or a guaranteed scaling law.

The coordinator approved an explicit finite sixty-second allowance for native
startup only. This is a product startup policy, not a vendor default or a reused
PGlite lock timeout. Interactive requests remain five seconds; close and exit
remain one second. Full validation and readiness fences are unchanged. The
transport still kills and physically joins a process that exceeds the caller's
startup deadline, preserving the original failure and independent cleanup
failures. Scan completion and inference remain independent of initial rendering.

There is no new scheduler, retry, dynamic size budget or priority adjustment.
The coordinator owns the final normal root launch, records actual readiness
time, and will not further increase the allowance if that launch fails.

Validation uses the actual `createIndexerConnection` transport from the native
activation caller with a fake clock and its existing runtime-ready payload.
Before the policy change, the thirty-second readiness controls failed under the
fifteen-second deadline (two failures / two passing retained-failure controls,
`/tmp/m2-populated-allowance-red.log`). The positive control sends readiness at
thirty seconds. The negative control exceeds sixty seconds, observes process
kill, then joins physical exit before reporting retained startup failure. A
separate request control proves that a ready connection still expires at five
seconds. No test asserts source text or documentation prose.

Detailed actual-launch and quiet-validation evidence is under
`/Users/seandearnaley/Documents/brainstrike-m2-completion-20261005/root-dev-startup`.
Focused tests cannot qualify the final app, full regression or Windows/Linux
native behavior. Those checks remain delivery-owned.

Focused local receipt:

- `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/native-index-startup.test.ts src/__tests__/native-index-startup-window.test.ts src/__tests__/native-index-activation-error.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism`: 23/23 passed (`/tmp/m2-populated-allowance-green.log`).
- `pnpm exec tsc --noEmit --project tsconfig.main.json` from `apps/desktop`: exit 0 (`/tmp/m2-populated-allowance-main-types.log`).
- `pnpm exec tsc --noEmit --project tsconfig.test.json` from `apps/desktop`: exit 0 (`/tmp/m2-populated-allowance-test-types.log`).
- `pnpm dlx ultracite fix` on the two changed TypeScript files: exit 0 (`/tmp/m2-populated-allowance-ultracite.log`).
- `git diff --check`: exit 0.

The known seven failures in the broader authority-observation suite were
previously reproduced on the unchanged runtime and are preserved. This focused
startup receipt is not a full regression pass.

**CI is disabled due to cost; validation must run locally.**
