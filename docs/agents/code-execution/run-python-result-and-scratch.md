# run_python result mapping, scratch dir, and the approval card — evidence

Supports `docs/agents/code-execution.md` § "The run_python tool". Read this
before changing `toRunPythonResult`'s arms, the per-call scratch dir, the
double output bound, or `run-python-approval-context.ts`. The contract holds
the rules; this file is the record of why.

Corrected at extraction (verified against the repo): the desktop composition
root registers the tool in
`apps/desktop/src/assistant-server/native-tool-executors-execution.ts`, not
`assistant-tools.ts` as the first line below says. That file's own comment
about Gate A is likewise stale — it still describes the pre-1.57 self-raised
approval suspension, while the tool and the permission gate now use the
framework's per-tool `requireApproval` clone.

- **Registered as the factory-returned Mastra Tool object**, never re-wrapped
  in the desktop registry's `{description, execute, id, inputSchema}` literal —
  that shape drops `suspendSchema`, which is exactly what BST-1070 will add.
  A desktop test asserts the real Tool object so the trap is armed before the
  schema exists. Excluded for the built-in local provider, alongside
  `askUser`/`submitPlan`.
- **Per-call scratch dir is the only writable path**: `mkdtemp` under
  `os.tmpdir()`, `realpath`'d (macOS `/var` → `/private/var`, and the seam
  compares resolved paths for `scratchDir ⊆ allowWrite`), removed in a
  `finally` on every exit path. Under `os.tmpdir()` rather than userData so a
  hard-crash orphan is reaped by the OS.
- **Five distinct terminal states**, mapped in `toRunPythonResult`:
  `completed` (the ONLY arm carrying `exitCode`, so a signal kill can never
  render as exit 0), `timed_out`, `killed` (`exitCode: null` with
  `timedOut: false` — a REAL state per the seam's "including a timeout kill",
  reachable via SIGSEGV/OOM, not a defensive branch), `cancelled` (carries
  partial output; never an empty success), and `unavailable`. An unrecognised
  error RETHROWS rather than being labelled with a diagnosis this layer cannot
  make.
- **`interpreter_unavailable` is distinct from `no_sandbox_configured`.** Host
  resolution is async (the bundled CPython may need a first-run unpack), and a
  `python_*`-coded failure from BST-1061's resolver maps to its own reason so
  the user is told WHICH half is missing. Matched structurally by code prefix —
  this package must not depend on `apps/desktop`, and the seam's own codes are
  all `exec_*`/`executor_*`/`fence_*`, so the prefixes cannot collide.
- **Output is bounded twice, and both counts are reported.** The executor cap
  (`RUN_PYTHON_MAX_OUTPUT_BYTES`) stops a runaway loop exhausting memory; the
  model projection fits the tool budget. Anything the projection trims is ADDED
  to the executor's `stdoutOmittedBytes`/`stderrOmittedBytes`, so the model can
  tell "the script produced 4 MB" from "we showed you the last 10 KB". The tail
  is kept — a traceback ends with the exception.
- **The approval card's facts are server-computed (BST-1070 Gate A, LIVE).**
  `run-python-approval-context.ts` derives a `CodeExecutionApprovalContext`
  (tool-approval contract) from the SAME strict schema + constants execute()
  uses — network `[]`, scratch under `os.tmpdir()` (only the PARENT is namable
  pre-mkdtemp, hence `scratchParentDir`), `defaultReadAccess: 'permissive'`
  (the fence's honest read semantics — see the escape-resistance README), the
  shared timeout default (single-sourced with the tool via
  `RUN_PYTHON_DEFAULT_TIMEOUT_MS`). `policyFingerprint` rides the context so
  approval-time and execute-time terms are COMPARABLE; the execute-time
  enforcement is deliberately deferred until workspace exec config introduces
  a real drift input — today both sides are the same pure function of the
  durable args in the same process, so a compare would be a guard whose
  failure no test can provoke. Wire path + card behaviour:
  docs/agents/assistant-runtime.md § PERMISSION ENGINE step 4.
