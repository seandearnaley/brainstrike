# Code execution

## Isolation and authority

All assistant code execution enters the CodeExecutor seam after its existing
permission decision. An explicit `vm` request requires an available VM capability;
never downgrade it to an OS fence. Unsupported platforms or unrepresentable
policy refuse visibly. [ADR-0003](../adr/0003-mode-two-full-isolation-vm.md) records
the VM decision, not proof that every platform implements it.

The fence owns the pinned runtime, validated helper/assets and OS enforcement.
Missing helper, unsupported policy or failed confinement is a refusal, not a
system-Python/direct-spawn fallback. Resolve packaged assets from the actual
runtime layout and preserve their digest/containment checks.

The bundled CPython is unpacked at build time and ships as loose files; no
archive ships, and nothing is extracted or written at runtime. The resolver
checks only the tree's sentinel against the manifest pin and the interpreter's
executable bit, and every launch sets `PYTHONDONTWRITEBYTECODE=1` so no run
writes into the shipped (on macOS, signed) tree. Evidence:
[python-build-time-unpack](../archive/agent-contract-history/code-execution/python-build-time-unpack.md).

Workspace identity and permission come from validated host context. Network is
deny-first; requested domains grant nothing until the per-call decision allows the
exact validated list. Scratch-write confinement is not a claim that reads are
private or confined. Treat every file read and returned output as sensitive.

## Process lifecycle

Use structured argv and the existing bounded command/process-tree owner. The
request's deadline spans preparation and execution; cancellation or timeout must
reach physical work and join its exit. Preserve explicit completed, signaled,
refused and failed outcomes—only an actual completed process has an exit code.
A parent shell exiting does not prove its descendants released the workspace.

Join output streams, native process groups/Jobs and temporary-file cleanup before
releasing ownership. Report cleanup failure beside the original execution error;
never turn it into success or erase one cause with another. Cold interpreter
installation joins native resource close and staging cleanup;
retain the primary error and report secondary cleanup failures.
Failed physical cleanup retains the owner for its existing retry/retirement policy.

## Results and future VM work

Bound output at the executor and model projection, with honest omitted-byte
counts. UI shows safe actionable errors while correlated diagnostics retain the
cause. Tool output cannot confer permission or filesystem authority.

Future VM execution remains local and capability-gated, shares only explicitly
granted folders and uses deny-first egress. VM/rootfs/snapshot artifacts are
device-local reset surfaces, not sync data. Do not add Docker/container-runtime
installation or hosted execution as an implicit replacement for the chosen mode.

Implementation: `packages/agent` code-execution adapters, desktop runtime assets
and native process owners.
