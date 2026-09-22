# Why ExecResult has per-stream omitted byte counts — evidence

Supports `docs/agents/code-execution.md` § "ExecResult semantics". Read this
before replacing the per-stream counts with a `truncated` boolean or inventing
a per-backend exit-code convention. The contract holds the rules; this file is
the record of why.

- `exitCode` is `null` exactly when the process was terminated by a signal —
  including a timeout kill — and `signal` names it. Pinning this here stops
  each backend inventing its own convention (`-1`, `124`, the signal number)
  that the tool layer would then have to normalize per-backend.
- Per-stream omitted byte counts replace a single `truncated` boolean (the
  shape the ticket originally named): one flag for two streams cannot say which
  stream was cut, and a boolean cannot tell the model whether 1 KB or 100 MB
  was dropped. `isExecResultTruncated(result)` is the convenience predicate.
- stdout/stderr are executor-bounded by `maxOutputBytes`; the tool layer's
  model projection still owes the standard tool output budgets
  (docs/agents/assistant-providers.md).
