# Where the Linux half of the fence suites comes from — evidence

Supports `docs/agents/code-execution.md` § "Where the Linux half actually comes
from". Read this before changing the dependency install, the AppArmor sysctl,
`BRAINSTRIKE_FENCE_DEPS_REQUIRED`, its `turbo.jsonc` declaration, or the
placement of the skip escalation. The contract holds the rules; this file is
the record of why, with the measurements.

Corrected at extraction (verified against `.github/workflows/test.yml`): the
last paragraph's `Unit (rest)` is no longer where `packages/agent` runs — the
`rest` shard filters that package out and `agent-1` / `agent-2` own it. The
BST-1285 observation itself is historical and unchanged.

The srt bump procedure below requires re-greening on macOS AND Linux. **Until
2026-08-16 the Linux half was unobtainable from CI, and nothing said so.**
`SandboxManager.checkDependenciesAsync()` requires `bwrap`, `socat` and `rg` on
Linux; no workflow installed any of them, so all three real-fence suites
(`fence-executor`, `run-python-tool`, `fence-escape-resistance`) skipped
themselves on every Linux run — loud in the log, green in the check:

```
[fence-escape-resistance] SUITE SKIPPED — sandbox-runtime dependencies are missing
on this linux host: ripgrep (rg) not found, bubblewrap (bwrap) not installed,
socat not installed
✓ src/__tests__/fence-escape-resistance.integration.spec.ts (32 tests | 27 skipped)
```

The only assertion that ever ran on Linux was the ungated version pin. The
`unit-shard` job in `.github/workflows/test.yml` now supplies the half, and two
things beyond the install were load-bearing:

- **The install alone makes the lane RED, not covered.** On
  `ubicloud-standard-4` (Ubuntu 24.04.4, kernel 6.14.0-azure, bubblewrap 0.9.0)
  the three binaries install in ~8 s and the dependency check goes green — and
  then every fenced run dies before executing a line:
  `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, and under
  `--unshare-user`, `bwrap: setting up uid map: Permission denied`. Ubuntu
  23.10+ ships `kernel.apparmor_restrict_unprivileged_userns=1` and the image
  carries no AppArmor profile granting bwrap `userns create` (only the generic
  `unprivileged_userns` and `lxc-usernsexec` profiles). **Measured: installing
  the dependencies and nothing else took the suites from 27 quiet skips to 44
  failures across 3 files**, every one of them the same empty stdout. The lane
  therefore also lifts that sysctl — Ubuntu's own documented remediation, on an
  ephemeral VM that already runs this repo's code under passwordless sudo. It
  changes only whether bwrap can BUILD its namespace, never what the fence
  denies inside one, which is the entire subject of these suites. The install
  step ends with a bwrap smoke test so a future image change fails there, with
  the kernel's own message, rather than 40 assertions deep in a security suite.
- **The skip must not be able to go quiet again.** The Unit integration steps
  set `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`, which the shared host gate
  (`packages/agent/src/__tests__/fixtures/fence-host-gate.ts`) reads to
  escalate a skip into a collection failure. It is scoped to lanes that
  PROMISED the prerequisites: developer machines and the coverage lanes install
  nothing and keep the loud-skip behaviour. Because turbo runs tasks in Strict
  env mode, the variable is also declared on `test:integration` in
  `turbo.jsonc` — without that it never reaches vitest and the guarantee is
  inert.
  - **EVERY suite-wide reason escalates, not only the dependency one**, and the
    escalation therefore lives at the choke point that sees the COMPLETE reason
    (`refuseToSkipInAPromisedLane`), never inside the dependency check. Scoping
    it to `checkDependenciesAsync()` alone — the shape this first shipped as,
    caught in review — left three other roads to a green lane that proved
    nothing: no `python3` on `PATH` (all three suites), and an unreachable
    probe host, which skips `fence-executor` and `run-python-tool` *entirely*,
    filesystem and process-tree proofs included. The escape-resistance
    network-cases gate escalates too: silently dropping the egress proofs is
    the same broken promise as dropping the suite.
  - The network prerequisite is the debatable one, since it depends on hosts
    this repo does not control and a transient outage would red a required
    lane. Accepted deliberately: that failure names itself in one line and a
    reader can see it is not a code defect, whereas the silent skip it replaces
    is undiagnosable by construction. If it proves flaky the answer is a more
    robust probe, not a return to green-on-unrun.
  - The install step also asserts `python3 --version`, so a runner image that
    drops the interpreter fails as provisioning rather than reaching the
    runtime gate at all.

  Every leg — install, sysctl, interpreter, env flag, turbo declaration, and
  the completeness of the escalation — is pinned with control tests in
  `scripts/__tests__/linux-fence-lane-contract.test.mjs`.

An srt bump reaches this lane automatically: the pin lives in
`pnpm-workspace.yaml`, so the lockfile change puts `@brainstrike/agent` in
turbo's `...[origin/main]` selection (verified on the BST-1285 bump PR, whose
`Unit (rest)` job did collect the escape-resistance file — and skipped 27 of
its 32 tests, which is what surfaced all of this).

**One Linux assertion was platform-blind and is now fixed, not weakened.**
`fence-executor`'s "DENIES a CHILD process spawned by the sandboxed code from
writing outside scratchDir" matched only Seatbelt's wording. Seatbelt refuses
the open (`PermissionError` / "Operation not permitted"); bubblewrap masks
everything outside the write grant by re-mounting it read-only, so CPython
raises `OSError: [Errno 30] Read-only file system`. Its sibling "DENIES a write
outside scratchDir" already named that shape. The regex now enumerates both
rather than dropping to "any error" — the same test still asserts the file does
not exist and the child's return code is non-zero.

**Read this as a product finding too, not only a CI one.** `isFenceSupported()`
and `checkDependenciesAsync()` both look for binaries on `PATH`; neither builds
a sandbox. A stock Ubuntu 24.04+ host carries the same kernel restriction the
runner did, so on such a host the fence constructs successfully and then fails
per run with bubblewrap's message. That is not silent degradation — the run
reports a non-zero exit and the bwrap stderr, and `resolveCodeExecutor` never
hands back a weaker tier — but it is not diagnosable either, and no capability
field says "this host cannot build a namespace". Closing it needs a
construction-time probe that actually spawns through bwrap. **Filed as BST-1317
with the two candidate shapes** (throw at construction vs. report it as a
capability); deliberately not fixed alongside the CI lane.

## Product readiness follow-up (2026-09-30)

BST-1317 replaces the deferred-construction behavior above with a bounded real
fence probe. See `fence-readiness.md` for its lifecycle and unmodified-host
measurements. CI provisioning remains unchanged; a development host refusal
is not evidence that the successful real-fence integration suite ran.
