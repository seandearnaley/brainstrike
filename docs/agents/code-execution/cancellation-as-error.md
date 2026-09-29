# Why an abort is an error, not an ExecResult — evidence

Supports `docs/agents/code-execution.md` § "Cancellation". Read this before
encoding an abort as a result, or before letting a serializing backend honour
an abort only once spawned. The contract holds the rules; this file is the
record of why.

**Why an error and not an `ExecResult`.** `ExecResult` describes a run that
COMPLETED, normally or by timeout. Encoding an abort as a result would make it
distinguishable from a timeout only by the ABSENCE of a flag
(`exitCode: null, signal: 'SIGKILL', timedOut: false`), so every consumer would
have to reverse-engineer "why is `exitCode` null while `timedOut` is false?" —
exactly the implicit encoding this module exists to kill. One `catch` is the
whole contract.

Nothing is discarded: `partialStdout`, `partialStderr`, `stdoutOmittedBytes`
and `stderrOmittedBytes` ride on the error, so a debug bundle still has whatever
the process produced before it was killed, without pretending the run finished.
`processStarted` separates "nothing ever spawned" (no side effects) from
"killed mid-run" (possible partial ones).

A backend that serializes executions must honour an abort WHILE QUEUED, not
only once spawned — otherwise pressing Stop behind two other runs waits for
them.
