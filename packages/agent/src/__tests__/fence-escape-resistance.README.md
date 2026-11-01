# Fence escape-resistance suite (BST-1071)

`fence-escape-resistance.integration.spec.ts` red-teams the `FenceExecutor` (`packages/agent/src/fence/`). Its sibling `fence-executor.integration.spec.ts` proves the executor's contract (code runs, exit codes propagate, obvious denials deny). This suite assumes that contract and attacks it: traversal, symlinks, forks, detached descendants, raw sockets that ignore the proxy, and policies crafted to re-open what the fence always denies. It also records, as tests, what the fence does not stop.

```bash
# The whole suite (integration lane; real Seatbelt/bubblewrap)
pnpm --filter @brainstrike/agent test:integration

# Just this file
cd packages/agent && pnpm vitest run --config vitest.integration.config.mts fence-escape-resistance
```

## The fence is not a VM

- `@anthropic-ai/sandbox-runtime` (srt) is an OS fence that shares the host kernel. Anthropic ships it as a research preview to reduce an agent's blast radius; it is **not sufficient for fully adversarial code**.
- Any Seatbelt or seccomp/namespace bypass is a total bypass, and no test here would notice.
- "Only a hypervisor bug gets out" is mode two ([ADR-0003](../../../../docs/adr/0003-mode-two-full-isolation-vm.md)), not yet implemented. `resolveCodeExecutor` throws rather than downgrading `vm` to `fence`, so nobody gets the weaker boundary while asking for the stronger one.

## What the fence stops (each claim has a test)

| Claim | Notes |
| --- | --- |
| Writes outside `scratchDir`, including via `..` traversal and via a symlink planted inside `scratchDir` | Containment is resolved (`realpath`), so links and traversal don't dodge it |
| Reads of the always-denied credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`) | Holds even under the widest `allowRead` the policy accepts (`$HOME`) |
| Reads of any path the policy names in `denyRead` | Holds when `allowRead` names a *parent*. A policy naming the **same** path in both lists is refused (non-guarantee 8) |
| All direct network egress: a raw `socket.connect()` that ignores `HTTP(S)_PROXY` gets nothing | True even for allow-listed domains: the allow-list is enforced at srt's proxy, not in the kernel |
| DNS: the sandboxed process has **no resolver**, so hostname-encoded exfiltration can't leave | Even allow-listed names don't resolve in-process; resolution is proxy-side |
| HTTP(S) to a host outside `allowedDomains` | The proxy refuses the CONNECT |
| Inheritance by the whole process subtree: `subprocess`, `multiprocessing`, `os.fork()` and a depth-2 grandchild all inherit the fence | srt's key property, and why a fence beats a per-call guard |
| Host environment variables (`AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, `GITHUB_TOKEN`, provider API keys, …) | The environment is an allow-list (`INHERITED_ENV_VARS`), not a pass-through |
| Runaway CPU and runaway allocation | Killed by the request's timeout, with an asserted result shape (`exitCode: null`, a named `signal`, `timedOut: true`) |
| Descendants outliving the run | Nothing survives a normal settle, a timeout or an abort, including a grandchild that detached its stdio |
| Nested user namespaces (Linux): `unshare(CLONE_NEWUSER)` through the executor returns `EPERM` | The case first checks the call succeeds under bare bubblewrap on the host |
| Cancellation in both positions | Aborted mid-run and aborted while queued both throw `ExecAbortedError`; the queued case never runs the code |

## What the fence does not guarantee

1. **Reads are permissive by default.** srt's read model is deny-then-allow: everything is readable unless denied. Only the always-denied stores and the policy's `denyRead` are blocked, so a `.env`, a private checkout or a password-manager export elsewhere on disk is readable. Callers that want a read jail build the deny list. A test asserts this, so an srt release that flips the default turns it red.
2. **Exfiltration through an allow-listed domain is not addressed.** srt filters which hosts a run may reach, not what it sends. Allow-listing `github.com` permits pushing a stolen file to any repository. Narrow the allow-list; it is not DLP.
3. **CPU and memory are bounded only by the request timeout.** No memory ceiling, CPU quota or disk quota on `scratchDir`.
4. **Kernel-level attacks are out of scope.** A Seatbelt, seccomp/`bpf` or user-namespace bypass, or a kernel LPE, defeats the fence completely. ADR-0003 is the answer, not a stronger profile.
5. **Write grants are broad, and on Linux a write grant is also a read grant.** `ALWAYS_DENY_READ_PATHS` is read-scoped; a policy that puts `/` or `$HOME` in `allowWrite` really does grant writes across the machine. Write grants are the caller's decision.
   - Exception: an `allowWrite` at or under an always-denied store is refused (`FencePolicyError`). bubblewrap masks a denied directory with `--tmpfs`, then re-binds allowed write paths under it read-write, so `allowWrite: ['~/.ssh']` would re-open the store for reading on Linux. macOS keeps write and read authority separate. The refusal lives in the policy layer so it holds on either platform (mutation M12).
6. **A hard crash of the host process leaks the run.** Process groups are reaped on `process exit`, but a `SIGKILL` of the Electron/Node host can't run that handler; the sandboxed process keeps running, still fenced, past its timeout. Fixing this needs an out-of-process supervisor.
7. **Covert channels are not considered.** Timing, filesystem metadata and similar side channels are not modelled or tested.
8. **`allowRead` beats `denyRead`, so an exact collision is refused.** srt re-emits a nested deny only when `denied.startsWith(allowed + '/')`, which is false for equal paths, so `allowRead: [X]` + `denyRead: [X]` would silently drop the deny. That collision is a `FencePolicyError`; a deny strictly nested inside an allow still works (mutation M13).

## Root-wide `allowRead` is refused

- On macOS, srt's profile generator re-emits a nested deny only when `denied.startsWith(allowed + '/')`. For `allowed === '/'` that compares against `'//'` and never matches, so `allowRead: ['/']` exposed the credential stores (measured on srt 0.0.67: `~/.ssh` key filenames and `~/.config/gh/hosts.yml` contents were readable).
- Every ancestor short of the root (`/Users`, `$HOME`) is unaffected. Linux is unaffected: bubblewrap masks denied directories with `tmpfs` and re-opens only allow paths under the deny.
- `buildSandboxRuntimeConfig` therefore refuses a root-wide `allowRead` with a `FencePolicyError` (refused, never narrowed). The pinning test (`REFUSES a root-wide allowRead…`) is meaningful only on macOS, so re-green this suite on both platforms after an srt bump.

## Mutation-kill table

A security test that stays green when its guard is removed is decoration. Each mechanism below was weakened and the named test had to go red. 16/16 killed (last full run at srt 0.0.73; later bumps re-ran the srt-sensitive subset).

| # | Mechanism weakened | Test that must go red | Result |
| --- | --- | --- | --- |
| M1 | `INHERITED_ENV_VARS` allow-list replaced by the whole host environment | `lets NO host environment value cross the fence…` | KILLED |
| M2 | `fence-policy` glob refusal removed | `REFUSES a glob allowRead that srt would expand…` | KILLED |
| M3 | `fence-policy` filesystem-root refusal removed | `REFUSES a root-wide allowRead…` | KILLED |
| M4 | `ALWAYS_DENY_READ_PATHS` dropped from the srt config | `DENIES the always-denied credential stores…` | KILLED |
| M5 | policy `denyRead` dropped from the srt config | `DENIES a read through a symlink into a denied store…` | KILLED |
| M6 | `allowWrite` gains the filesystem root | `DENIES a write that traverses out of scratchDir…` | KILLED |
| M7 | `allowedDomains` widened behind the policy | `DENIES a non-allow-listed host while the allow-listed one succeeds…` | KILLED |
| M12 | `allowWrite` containment against the always-denied stores removed | `REFUSES an allowWrite on an always-denied store…` | KILLED |
| M13 | `allowRead`/`denyRead` exact-collision refusal removed | `REFUSES a policy that both allows and denies the SAME path…` | KILLED |
| M8 | process-group kill reverted to single-pid (`-pid` → `pid`) | `leaves no ticking descendant alive when execute() settles normally` | KILLED |
| M8b | same | `leaves no ticking descendant alive when the run is ABORTED` | KILLED |
| M8c | same | `does not let a leftover descendant of run A inherit run B's egress` | KILLED |
| M9 | mid-run abort listener removed | `leaves no ticking descendant alive when the run is ABORTED` | KILLED |
| M10 | queued-position abort check removed | `throws ExecAbortedError with processStarted:false when aborted while QUEUED…` | KILLED |
| M11 | timeout watchdog disabled | `kills an infinite CPU loop on timeout…` | KILLED |
| M11b | same | `kills an unbounded allocation on timeout…` | KILLED |

- `DENIES a raw socket that ignores the proxy environment…` and `gives the sandboxed process NO resolver at all…` have no source-level mutation: srt's OS-level egress denial guards them, and no policy change re-opens a raw socket or resolver.
  - Their control is the precondition probe: it runs the identical socket and name resolutions unsandboxed and refuses to run the network cases unless they succeed. Fence absent means connect and resolve succeed, so the tests fail.

## Writing tests here

- Ask what the result would be with the fence entirely absent. If it's the same, the test is decoration.
  - An off-list host must be shown reachable first: the precondition probe requires a real **200 unsandboxed** from the off-list URL, and the test separates `HTTPError` (the origin answered, so the request escaped) from other exceptions (the tunnel was refused).
  - DNS cases resolve only hostnames the precondition probe already fetched, so NXDOMAIN can't pass for a fence block.
- Skips are loud and split; no skip weakens an assertion.
  - **Host gate** (not macOS/Linux, srt dependencies missing, no python on `PATH`) skips the whole suite with a `console.warn` naming what's missing. It is shared with the other real-fence suites in `fixtures/fence-host-gate.ts`.
  - **Network gate** skips only the network cases, so an offline machine still gets the filesystem, policy, process-tree, environment and teardown proofs.
  - Where an assertion can't be proven on a host (no populated credential store, no `~/.ssh`), the suite asserts what it can and warns that the assertion was vacuous.
  - With `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`, `refuseToSkipInAPromisedLane` turns every suite-wide skip (missing dependency, interpreter or probe host) and the network-cases skip into a failure. Developer machines and coverage lanes leave it unset.
- No assertion is wall-clock tight. A timeout case asserts that the kill happened and its result shape, never that it happened within N ms.
  - Descendant survival uses a heartbeat counter, not a sleep: the descendant ticks a file every 50 ms; the test records the counter when `execute()` settles, waits a window many times the tick, and requires it unchanged. A landed tick proves the descendant ran; a frozen counter proves it's gone.

## srt version pin

`@anthropic-ai/sandbox-runtime` is pinned to **0.0.80** in the workspace catalog, and `PINNED_SRT_VERSION` in the spec asserts the installed version. The fence's guarantees are srt's, and a patch bump can change them silently. Bumping srt means re-greening this suite, not just updating the constant:

1. Run the full suite on **macOS and Linux**. The root-`allowRead` finding is macOS-only and the write-grant finding (non-guarantee 5) is Linux-only.
2. Re-read srt's README security sections and reconcile the non-guarantee list.
3. Re-run at least the srt-sensitive mutations (M2, M3, M4, M12, M13) on both platforms; a bump can make a guard redundant.
4. Only then update `PINNED_SRT_VERSION` and `docs/agents/code-execution.md`.
5. Record in the PR which platforms ran, with test counts and skips.

- **macOS:** run `pnpm --filter @brainstrike/agent test:integration` locally; Seatbelt needs nothing installed.
- **Linux:** the unit shards' integration steps in `.github/workflows/test.yml` run on the `linux-desktop-test-host` action (installs `bwrap`, `socat` and `rg`; lifts `kernel.apparmor_restrict_unprivileged_userns`) with `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`. A pin change puts `@brainstrike/agent` in turbo's affected set, so the queue's affected run covers it.
  - Confirm the suite ran: the integration step must show this file with no `SUITE SKIPPED —` or `NETWORK CASES SKIPPED —` lines. A green check alone is not proof.
  - Any other Linux host must first prove bubblewrap can build a namespace: `bwrap --ro-bind / / --dev /dev --unshare-all /bin/echo ok` must exit 0. The dependency check only looks for binaries on `PATH`.
  - On Ubuntu, the qualification host setup is in [code execution](../../../../docs/agents/code-execution.md#linux-sandbox-qualification).
- The 0.0.80 qualification (BST-2029) covered macOS arm64 and Ubuntu x64. Not qualified: packaged artifacts, Linux arm64, Windows.
- Since 0.0.75, srt folds macOS deny paths into regex groups and falls back to literal filters at its 900-byte cap, so no deny is dropped; recheck this on a bump.
