# Recoverable FSEvents overflow and native partial reads

The normal-root M2 live run reported twelve actual Parcel FSEvents client
rescan-required errors, twelve DesktopMain watcher-health errors and five
status/coverage IPC failures. The overflow itself is real. This correction
addresses amplification: the activation callback previously stored every
`degraded` watch as a fatal read failure, preventing committed partial reads
while the canonical owner already had full-root reconciliation queued.

## Vendor classification

Installed `@parcel/watcher` 2.6.0's `src/macos/FSEventsBackend.cc` emits exactly
three messages under `kFSEventStreamEventFlagMustScanSubDirs`, retaining its
subscription: client-dropped, kernel-dropped and too-many-events. The adapter
matches these complete messages only under the explicit `fs-events` backend,
emitting `rescan-required` degraded health and the original warning. Other
messages remain backend errors. A changed failure class is delivered even when
the state remains degraded, and both warning and subsequent error are logged.

Windows `ERROR_NOTIFY_ENUM_DIR` throws `WatcherError`; `Backend::handleWatcherError`
unwatches that subscription. Linux `IN_Q_OVERFLOW` is continued by the vendor
without producing an error. Neither path establishes recoverable live watch
ownership here. No guessed cross-platform message or fallback was added.

Activation invalidates both workspace and collection completion proofs before
admitting reads for this typed, nonterminal FSEvents recovery only. It never
sets a fatal watch failure for that event, nor clears an independently retained
one. The existing mounted owner forwards degraded health as overflow and the
existing canonical runtime reconciles the complete affected root. Healthy
watch events cannot recreate source proofs; an actual complete manifest must
finish. Unknown backend errors and failed/stopped watches still close reads
and report their actual errors.

## Local verification

CI is disabled due to cost; validation must run locally.

All pnpm commands used `pnpm_config_verify_deps_before_run=error` with the
retained Node 26.8.2 runtime first on PATH.

- RED: `pnpm --filter @brainstrike/file-system exec vitest run src/__tests__/parcel-watchers.test.ts -t 'classifies the native FSEvents|unknown failure that follows'` failed four new controls: the three vendor messages had `backend-error`; a following unknown failure was suppressed.
- RED: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/native-index-activation.test.ts -t 'keeps native reads admitted'` failed at the actual `native-index-read-authority` watch-failure throw, preserving the recorded FSEvents client message.
- GREEN: `pnpm --filter @brainstrike/file-system exec vitest run src/__tests__/parcel-watchers.test.ts src/__tests__/parcel-watch-retirement.test.ts` passed 51 tests. These preserve root invalidation, explicit warning/error classification, portable negative controls and physical retirement ownership.
- GREEN: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/native-index-activation.test.ts src/__tests__/ipc-domains/workspace-root-watch-owner.test.ts` passed 31 tests. The added control uses the actual activation, publication and read authority; completeness becomes false, native reads remain admitted, clean health cannot restore completeness, full manifest recovery restores proofs, and later unknown/failed/stopped errors still close reads. A later recoverable event cannot clear those failures. The mounted owner emits the existing overflow recovery signal while retaining its native producer.

These bounded groups do not establish a full regression, real OS overflow
prevention, new live M2 qualification or Windows/Linux runtime acceptance.
No root build, lint, restart, install or commit was performed by this subtask.
