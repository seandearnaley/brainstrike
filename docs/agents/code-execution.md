# Code execution

Implementation: `packages/agent` code-execution adapters, desktop runtime assets and native process owners.

## Isolation and authority

- All assistant code execution enters the CodeExecutor seam after its permission decision.
- An explicit `vm` request needs an available VM capability; never downgrade it to an OS fence. Unsupported platforms or unrepresentable policy refuse visibly.
  - [ADR-0003](../adr/0003-mode-two-full-isolation-vm.md) records the VM decision, not proof that any platform implements it.
- `run_python` runs only in the fence, so a run is offered it only where the executor's own fence check passes. Windows and WSL 1 never offer it, rather than asking the person to approve a call that can't run.
- The fence owns the pinned runtime, validated helper/assets and OS enforcement.
  - A missing helper, unsupported policy or failed confinement is a refusal, never a system-Python or direct-spawn fallback.
  - Resolve packaged assets from the actual runtime layout and keep their digest and containment checks.
- The bundled CPython is unpacked at build time and ships as loose files; nothing is extracted or written at runtime.
  - The resolver checks only the tree's sentinel against the manifest pin and the interpreter's executable bit.
  - Every launch sets `PYTHONDONTWRITEBYTECODE=1`, so no run writes into the shipped (on macOS, signed) tree.
- Workspace identity and permission come from validated host context.
- Network is deny-first: requested domains grant nothing until the per-call decision allows the exact validated list.
- Scratch-write confinement doesn't make reads private or confined. Treat every file read and returned output as sensitive.

## Shell commands

- Where the desktop agent host supplies the fence (macOS and Linux), `executeCommand` runs inside it:
  - writes only in the command's open folder and its own temp folder (`TMPDIR`, removed with the command)
  - reads everything but the always-denied credential stores
  - no network
  - sandbox-runtime's own `TMPDIR` (`/tmp/claude`) is writable only where that folder already exists, so nothing relies on it
- The fence only wraps the command. executeCommand's own process owner spawns it, so streaming, output bounds, group teardown and the workspace lease are unchanged.
- A readiness failure refuses the command with its reason; it never falls back.
- `dangerouslyDisableSandbox` runs one command outside the fence. Run admission gives that call to the person in Ask and Auto (the auto reviewer never approves it); Full runs it.
- The standalone host, Windows and command sessions run unsandboxed, and the result says `sandboxed: false`.
  - An executeCommand approval carries the same fact (`sandboxed` on `interaction.requested`, from the tool's own check), so the card says the command will run unsandboxed before the person approves it.
- sandbox-runtime's process-wide `network.allowedDomains` is read by every sandboxed process, so it stays empty.
  - A `run_python` call's approved domains go to that one command through `registerCommandNetworkLists`, keyed by a 128-bit id the wrap gives it.
  - The vendor calls the id attribution, not a boundary: a process presenting another live command's id gets that list. Each Linux sandbox's PID namespace, and the macOS profile's same-sandbox `process-info` rule, stop one sandbox reading another's environment, where the id lives.
  - Release sandbox-runtime's per-command cleanup only for a wrap that handed out a command; a wrap that threw undoes itself.

## Process lifecycle

- Use structured argv and the existing bounded command/process-tree owner.
- The request's deadline spans preparation and execution. Cancellation or timeout reaches physical work and joins its exit.
- Keep explicit completed, signaled, refused and failed outcomes; only a completed process has an exit code.
- A parent shell exiting doesn't prove its descendants released the workspace.
- Join output streams, native process groups/Jobs and temp-file cleanup before releasing ownership.
  - Report cleanup failure beside the original execution error; never turn it into success or let one cause erase another.
  - Cold interpreter installation joins native resource close and staging cleanup, keeping the primary error.
  - Failed physical cleanup keeps the owner for its existing retry/retirement policy.

## Results and future VM work

- Bound output at the executor and in the model projection, with honest omitted-byte counts.
- The UI shows safe, actionable errors; correlated diagnostics keep the cause.
- Tool output never confers permission or filesystem authority.
- Future VM execution stays local and capability-gated, shares only explicitly granted folders and uses deny-first egress.
  - VM, rootfs and snapshot artifacts are device-local reset surfaces, not sync data.
  - Don't add Docker/container-runtime installation or hosted execution as an implicit replacement for the chosen mode.

## Linux sandbox qualification

- sandbox-runtime's seccomp helper needs capability-bearing nested user namespaces before it restricts the command.
  - A successful bare `bwrap` probe is not readiness: run the executor's real readiness probe and the escape-resistance suite.
  - On Ubuntu with AppArmor namespace restrictions, use the vendor-documented application-specific `userns` profile for the qualification binary.
  - Never enable `enableWeakerNestedSandbox`, `allowAllUnixSockets` or `allowNestedUserNamespaces` to get a test green.
- A qualification host may use a root-owned copy of the distro Bubblewrap at `/opt/brainstrike-qualification/bin/bwrap`, with an AppArmor `unconfined` profile attached to that exact path granting `userns`.
  - Select it through the test process's `PATH`; keep the distro's `/usr/bin/bwrap` profile and the global namespace restriction.
  - This is a host administration exception, not shipped app setup or a claim that arbitrary Ubuntu installs are ready.
  - Refresh the copy and requalify when the distro binary changes. Removing the profile and binary reverses the setup.
  - Tests still run as an ordinary user with disposable home directories and fake credentials.
- References: [sandbox-runtime platform requirements](https://github.com/anthropics/sandbox-runtime/blob/v0.0.80/README.md#platform-specific-dependencies), [Ubuntu AppArmor guidance](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).
