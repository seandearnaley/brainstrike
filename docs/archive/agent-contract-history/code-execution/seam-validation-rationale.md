# Seam input validation — why each field is required — evidence

Supports `docs/agents/code-execution.md` § "Validation is the whole request,
not just the policy". Read this before proposing to make `signal` or
`maxOutputBytes` optional, before hardcoding a timeout default or ceiling in
the seam, or before changing `isPathCoveredBy`'s separator or case rules. The
contract holds the rules; this file is the record of why.

Verified at extraction: `MAX_EXEC_TIMEOUT_MS` is 600000 and
`run-python.ts` declares `executionBudget: { defaultMs: 30_000, maxMs: 600_000 }`,
so the single-sourcing claim below still holds.

**`timeoutMs`'s default and ceiling are not this module's own numbers
(BST-1777).** `run_python`'s `defineNativeTool()` definition declares
`executionBudget: { defaultMs: 30_000, maxMs: 600_000 }`
(`packages/assistant-contract/src/native-tools/definitions/run-python.ts`) —
the ONE source both the approval card and the executor read.
`RUN_PYTHON_DEFAULT_TIMEOUT_MS` (`run-python-approval-context.ts`) reads
`NATIVE_TOOL_EXECUTION_BUDGETS.get(NATIVE_TOOL_ID.runPython).defaultMs` rather
than hardcoding it, and `MAX_EXEC_TIMEOUT_MS` (this seam's own re-exported
ceiling) is declared to match the same tool's `maxMs`, so the card, the input
schema's ceiling, and the per-tool execution guard's declared budget cannot
drift apart. The per-tool execution guard
(`packages/agent/src/tools/guard-tool-execution.ts`, see
`docs/agents/assistant-runtime.md`) grants this call
`min(timeoutMs, executionBudget.maxMs) + TOOL_GUARD_MARGIN_MS` (5000ms) — a
head start over the seam's own `timeoutMs` so a self-terminating tool's richer
`timed_out` result (below) wins the race against the guard's generic
`tool_timeout`.

Two of these are deliberate, load-bearing choices:

- **`signal` is required, not optional.** The desktop runtime aborts its
  registered execution controller when the user presses Stop
  (docs/agents/assistant-runtime.md), and native tools already receive that
  signal. Without it at this seam, a cancelled assistant run leaves a spawned
  process running and producing side effects until `timeoutMs` expires.
  Backends MUST terminate the process tree when it fires. An `AbortSignal` is
  trivially constructible, so requiring it costs a caller nothing and
  guarantees the propagation path exists. Since BST-1777 the signal
  `run-python-tool.ts` passes is `resolveGuardedToolSignal(context)`
  (`packages/agent/src/tools/tool-guard-deadline.ts`) — the caller's own signal
  folded with the per-tool execution guard's deadline — so a guard timeout now
  aborts the process tree through this same seam rather than leaving it
  running until its own `timeoutMs` elapses.
- **`maxOutputBytes` is required**, so the capture bound is a property of the
  request rather than a per-backend constant. Otherwise the same script could
  return truncated output under one backend and complete output under another,
  with no way for the caller to know why.

`scratchDir ⊆ allowWrite` is enforced (`isPathCoveredBy`, segment-wise) because
the alternative is an interpreter that cannot write its own scratch dir,
failing as an opaque runtime error instead of a clear validation error.

`isPathCoveredBy` is exported and is the ONLY containment predicate backends
should use, including on runtime-computed paths. Its rules:

- **An unresolved `..` in either operand returns false.** It never claims
  coverage it cannot prove — a segment-prefix compare would report
  `/tmp/scratch/../../etc/passwd` as covered by `/tmp/scratch`. Resolving
  first is a requirement, not just the fix for this case; see below.
- **Separators follow the path's own shape.** A backslash is a separator only
  in a Windows-shaped path; on POSIX it is a legal filename character, so
  `/tmp/scratch\run` is a sibling directory named `scratch\run`, not a
  descendant of `/tmp/scratch`.
- **Only the Windows VOLUME segments are case-folded** — the drive letter
  (`C:`), or the host AND share for a UNC path (`\\server\share`, both
  case-insensitive at the SMB protocol level). Never directory segments, never
  on POSIX. Volume case is what Node APIs spell inconsistently; directory
  segments are a different question, because NTFS supports per-directory case
  sensitivity (WSL enables it), so folding them could report coverage the
  filesystem does not grant. That is a false PERMIT, the unsafe direction, and
  the same platform-shaped guess this doc rejects for darwin below.
  Case-insensitive volumes are served correctly by resolving first — but only
  with the NATIVE resolver, see the next bullet.
- **Resolve with `realpath.native`, not `fs/promises`' `realpath`.** Node's JS
  implementation resolves symlinks but copies non-symlink components verbatim
  from the input string; it does NOT return the OS-canonical case. Only the
  native binding (`realpath(3)`, `GetFinalPathNameByHandleW`) does. Measured on
  darwin: for an on-disk `MixedCase`, the JS version returns `mixedcase`, the
  native one `MixedCase`. Since directory segments compare case-sensitively,
  the JS resolver silently voids both the containment guarantee and the
  always-deny check on a case-insensitive volume.
