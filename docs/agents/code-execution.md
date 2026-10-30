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

## Shell commands

Where the desktop agent host supplies the fence (macOS and Linux),
`executeCommand` runs inside it: writes only in the command's open folder and
sandbox-runtime's own `TMPDIR`, reads everything but the always-denied credential
stores, and no network. The fence only wraps the command; executeCommand's own
process owner spawns it, so streaming, output bounds, group teardown and the
workspace lease are unchanged. A readiness failure refuses the command with its
reason and never falls back. `dangerouslyDisableSandbox` runs one command
outside: run admission gives that call to the person in Ask and Auto (the auto
reviewer never approves it), and Full runs it. The standalone host, Windows and
command sessions run unsandboxed, and a result says `sandboxed: false`.

Every sandboxed process reads sandbox-runtime's process-wide
`network.allowedDomains`, so it stays empty. A run_python call's approved domains
go to that one command through `registerCommandNetworkLists`, keyed by a 128-bit
id the wrap gives it. The vendor calls the id attribution, not a boundary: a
process presenting another live command's id gets that list. Each Linux sandbox's
PID namespace, and the macOS profile's same-sandbox `process-info` rule, keep one
sandbox from reading another's environment, where the id lives. Release
sandbox-runtime's per-command cleanup only for a wrap that handed out a command;
it undoes a wrap that threw itself.

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
