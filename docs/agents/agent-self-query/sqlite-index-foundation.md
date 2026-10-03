# SQLite index sandbox foundation — 2026-10-02

Unwired BST-1924 foundation, derived from the recovered s-qs experiment and
the current Node/SQLite APIs. No application database migration or product
target/lens routing is included in this layer.

Electron 44.4.5 embeds Node 24.21.0 / SQLite 3.53.4. Its memory-accounting
compile-option probe is empty; hard_heap_limit reports 536870912; actual limits
report attach=0 and length=16777216. Standalone Node 24.16.0 reports
DEFAULT_MEMSTATUS=0 and must be refused. Future Electron-free Node host/CLI
runtime support remains unresolved under BST-1941, not qualified by Electron.

The 25 real-engine integration cases pass with the built client and host under
Electron's Node runtime: hostile SQL refusal/file hash stability, FTS5 and vec
functions, binding, introspection, duplicate columns, row cap, runaway process
kill, responsive parent, retained deadline error, writer reopening, and explicit
fresh-host recovery. This is child-process qualification using the Electron
engine; actual Electron utilityProcess and product consumer proof are pending.

Parent and child use the same executable/V8 build. An initial mixed standalone
Node/Electron test exposed incompatible advanced IPC serialization and failed;
the test runner now explicitly runs both sides under the chosen Electron build.
It does not select another engine on failure.

RED: unfinished ownership rejected startup before implementation. Earlier
missing-export and missing-built-entrypoint attempts were infrastructure failures,
not behavioral RED proofs. GREEN: /private/tmp/sqlite-query-electron-green.log,
25 passed in 721 ms. The runaway case completed in 400 ms. Strict TypeScript and
Effect diagnostics passed before subsequent unit-test/contract additions;
repeat closure is required before commit. No full-app, utility-process, Linux,
Windows, caller-ranking, or M2 completion claim follows from these checks.

Canonical APIs: https://nodejs.org/api/sqlite.html,
https://www.sqlite.org/c3ref/set_authorizer.html,
https://www.electronjs.org/docs/latest/api/utility-process.

## Current ordinary verification, 23:35 Eastern

The rebuilt enforced source passes 26 real-engine child-process cases, including
refusing a result beyond the 1 MiB IPC budget before parent deserialization.
Three actual Electron utility processes also passed 14 refusal cases, FTS5/vec
reads, bound input, duplicate columns, introspection, deadline kill, retained
error identity, writer reopening and fresh-host recovery. Parent13timer ticks
ran during the150ms runaway. No sleeps or process fallback were added.

The first utility lifecycle run was RED: a repeated kill returned false after
the first deadline kill and before the exit event. The client now records the
termination request and joins its exit without calling kill twice. Ordinary
GREEN is /private/tmp/sqlite-query-ordinary-final-integration.log. Separate
Node24.16 negative probe refused DEFAULT_MEMSTATUS=0 as expected; log
/private/tmp/sqlite-query-node-refusal.log. Linux/Windows remain unqualified.

A result-limit mutation validation was interrupted by automated safety review
after temporary setup. The enforced check was restored and rebuilt; the
interrupted mutation test was not executed and is unqualified, with no retry.
No claim that this specific guard is mutation-qualified is made. Build/types
+3protocolunits:6tasks passed(3cached), Effect12files0diagnostics;
18Effect contract checks and source-alias guard passed. Formatting15files clean.
