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

## Linux sandbox qualification

Sandbox-runtime's seccomp helper needs capability-bearing nested user namespaces
before it restricts the executed command. A successful bare `bwrap` probe is not
readiness: run the executor's real readiness probe and escape-resistance suite.
On Ubuntu with AppArmor namespace restrictions, use the vendor-documented
application-specific `userns` profile for the qualification binary. Do not enable
`enableWeakerNestedSandbox`, `allowAllUnixSockets` or
`allowNestedUserNamespaces` to get a test green.

A qualification host may use a root-owned copy of the distro Bubblewrap binary
at `/opt/brainstrike-qualification/bin/bwrap`, with an AppArmor `unconfined`
profile attached to that exact path and granting `userns`. Select it through the
test process's `PATH`; retain the distro's `/usr/bin/bwrap` profile and the global
namespace restriction. This is a host administration exception, not a shipped
application setup or a claim that arbitrary Ubuntu installations are ready.
Refresh the copy and requalify when the distro binary changes. Removing the
profile and dedicated binary reverses this setup. Tests still run as an ordinary
user with disposable home directories and fake credentials.

See the [runtime's platform requirements](https://github.com/anthropics/sandbox-runtime/blob/v0.0.80/README.md#platform-specific-dependencies)
and the [Ubuntu AppArmor guidance](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).
