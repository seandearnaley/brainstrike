# User Stop reaches the owned index reader

Rule: index querySelf execution carries its process-local execution/guard signal through acquisition and reader requests, and cancellation joins the actual reader exit before rejection.

2026-10-03: source inspection at candidate 98b15a814822aeafb35336a38c83a2e5ead55ee7 found the public native executor accepted no context and the index client no AbortSignal. Four causal executor cases failed before the fix: app/index pre-abort still attempted acquisition; in-flight Stop and guard abort requested zero kills. The focused tests traverse the actual executor, routing and client, substituting only the process transport and owned target acquisition.

The client now attaches cancellation to its existing request ID, checks prior abort both before spawn and before posting, kills the dedicated owner and joins its exit. A response removes its pending entry before settlement, so an old signal cannot kill subsequent work. A cancellation error retains phase, vendor owner PID, request kind and ID, and the existing log path reports code sqlite_query_cancelled. Signals and errors convey no authorization over IPC.

The protected Electron utility proof uses ordinary read-only recursive aggregate SQL with the unchanged 1000ms deadline. A 50ms controller abort rejects as query-phase cancellation only after the utility exit; OS PID lookup returns ESRCH at rejection. Electron app.getAppMetrics can still list that exited PID in the same event turn, so metrics inventory alone is not a synchronous liveness check. Fresh query acquisition and writer reopen succeed, and all pre-existing unsafe-SQL/hash/deadline tests remain intact.

This is source/client/utility evidence, not visible assistant Stop acceptance. Composition and qualification retain that acceptance on the composed unchanged candidate. App-target SQL still uses shared PGlite: pre-abort rejects before admission and late results are suppressed after statement settlement, with no per-statement interrupt guarantee.
