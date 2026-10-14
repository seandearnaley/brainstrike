# Interactive terminal shutdown ownership

Supports `platform-contracts.md` section Graceful shutdown ownership.

On 2026-10-05, the Mac mini remaining desktop regression at tree
`c7621eb3397d87288bce100f15f8a015d3f71162` passed the terminal restart marker
assertion but Electron PID 35000 aborted during fixture close. The retained
stdout logged graceful shutdown completed at 16:11:43.729Z; the matching macOS
report captured SIGABRT at 16:11:44.1004Z. The native stack enters
`pty.node` `Napi::ThreadSafeFunction::CallJS` during Node
`Environment::CleanupHandles` and reports an uncaught `Napi::Error`.
The exact N-API error message and originating JavaScript error were not retained.

The source establishes a separate ownership defect: renderer destruction removes
the terminal from the live IPC registry while an asynchronous descendant walk
and the node-pty exit callback remain outstanding. Later shutdown previously
saw an empty registry and could not join those operations. Keep cleanup owned
until both settle, preserving descendant-first killing and the application
shutdown deadline. Do not suppress native errors or infer normal exit from a
completed shutdown log. This correction requires actual Electron verification;
unit tests alone do not prove the observed native abort is eliminated.

The regression packet remains at
`/Users/seandearnaley/Documents/brainstrike-desktop-regression/remaining-28c3-20261005-120341/`.
The later-discovered OS report is
`/Users/seandearnaley/Library/Logs/DiagnosticReports/Electron-2026-10-05-121154.ips`
on the Mac mini. The original sealed packet stated that no matching report had
been obtained; preserve that packet and retain the later report separately.

Guards: `apps/desktop/src/__tests__/terminal-shutdown-join.test.ts`,
`terminal-ipc-handlers.integration.test.ts`, and `electron-process-exit-guard.test.ts`.
