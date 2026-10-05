# Desktop E2E process-exit guard — evidence

Supports `docs/agents/ci-quality.md` § "Desktop E2E process-exit guard"
(BST-1087, BST-1728). Read this when a desktop spec fails with an unexpected
Electron exit, `signal=SIGKILL`, or an `_object` `TypeError`, and before
changing `ElectronHarness` close/restart, `ElectronProcessExitGuard`, or the
interactive delegated-child fixture.

Desktop E2E fixture teardown is a correctness boundary, not cleanup-only.
Every process launched by `ElectronHarness` is registered with
`ElectronProcessExitGuard`. Any exit before the fixture begins intentional
close fails the owning Playwright test with the recorded code and signal, even
when the test body already passed. Once intentional close begins, both graceful
exit and the harness's bounded forced-termination path are accepted. Before
marking a close intentional, the guard checks the child process's recorded exit
state so a reaped process cannot be misclassified while its Node `exit` event is
still pending. The anti-vacuity floor applies after a context successfully
launches; a skipped test or a launch that already threw is not replaced by a
fixture-teardown error. Restart uses the same close/guard path and must surface
close failures; if close and process health both fail, both errors are retained.
Do not restore the former warn-and-relaunch behavior.

The interactive delegated-child decision fixture uses
`runInteractiveChildFixture` to preserve the original scenario failure alongside
diagnostic and teardown failures. Failure-text extraction or attachment must not
replace the assertion. Provider close and environment restoration still run
when Electron disposal fails. Capture the owned process before Playwright
disposal, observe its exit separately from `app.close()`, and only remove the
disposable workspace after confirmed exit; a sent signal is not proof of exit.
If exit cannot be confirmed, retain the workspace and report its path. These
decision scenarios additionally require a zero exit code, so forced termination
is a test failure even after the UI assertions pass. The real consumer remains
`delegated-child-interactive.desktop.test.ts`; injected diagnostic, disposal,
provider, launch and process-exit failures are covered by
`interactive-child-fixture.test.ts` (BST-1728).

**A harness-owned app may only be closed through the harness.** Tests that seed
on-disk userData (`electron-storage.json`) need the app down mid-test so no
process owns the file; they must call `ElectronHarness.closeForStateSeeding()`,
never `closeElectronApp(context)` directly. An out-of-band close is invisible to
the guard, so the process's exit is recorded as unexpected and the *next*
`restart()` fails the test — with `signal=SIGKILL`, which is just Playwright
reaping the child after `app.close()`, plus a `TypeError` reading `_object` from
the already-disposed `ElectronApplication`. That combination is a lifecycle-bypass
signature, not a crash, not memory pressure, and not an orphaned process: read it
as "somebody closed the app behind the harness's back". All ten
`file-explorer-selection-restore.desktop.test.ts` specs failed this way the
moment the desktop lane started loading again. Whether the failure surfaces as
the bare guard error or as an `AggregateError` pairing it with the `_object`
`TypeError` depends on whether Playwright has disposed the `ElectronApplication`
yet — that run produced 7 of the latter and 3 of the former; both mean the same
thing.

The seeding helpers take `SeedableElectronHarness`, whose required
`closeForStateSeeding` puts the guarded path in reach at every seeding call site.
The type does not *prevent* an out-of-band close — `ensureContext()` still hands
back the `ElectronApplication` — so this stays a convention backed by the paired
test, not a compiler guarantee. `file-explorer-selection.shared.ts` deliberately
does not re-export `loadElectronHelpers`, so the module that states the rule does
not also hand out `closeElectronApp`. Specs that launch their own Electron app
(`launchElectronDevAppInTest`) are unaffected — the harness never observes those
processes. Paired test:
`apps/desktop/src/__tests__/electron-harness-state-seeding.test.ts`.

## Native abort during intentional close (2026-10-05)

The terminal restart test passed its marker assertion at tree
`c7621eb3397d87288bce100f15f8a015d3f71162`, but main subsequently exited with
SIGABRT. The intentional-close flag discarded that exit and the close helper
treated any exit event as completion. The flag identifies a requested shutdown;
it cannot make a native abort healthy. Reject abnormal post-close exits while
preserving the existing bounded SIGKILL teardown and code-zero controls.
See `platform-contracts/terminal-shutdown-join.md` for retained incident evidence.
