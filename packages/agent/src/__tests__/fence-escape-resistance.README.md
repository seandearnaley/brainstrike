# Fence escape-resistance suite (BST-1071)

Paired with `fence-escape-resistance.integration.spec.ts`.

This is the red team for the `FenceExecutor` (`packages/agent/src/fence/`). Its
sibling `fence-executor.integration.spec.ts` proves the executor's **contract**
— code runs, exit codes propagate, the obvious denials deny. This suite assumes
the contract holds and attacks it: traversal, symlinks, forks, detached
descendants, raw sockets that ignore the proxy, and policies crafted to re-open
what the fence always denies.

It also writes down, in executable form, what the fence **does not** stop.

```bash
# The whole suite (integration lane; real Seatbelt/bubblewrap, never cached)
pnpm --filter @brainstrike/agent test:integration

# Just this file
cd packages/agent && pnpm vitest run --config vitest.integration.config.mts fence-escape-resistance
```

---

## The headline: read this before you trust the fence

`@anthropic-ai/sandbox-runtime` is an **OS fence, not a VM**. It shares the host
kernel. Anthropic ships it as a research preview to reduce an agent's blast
radius; it is **not sufficient for running fully adversarial code**. Every macOS
Seatbelt or Linux seccomp/namespace bypass is a total bypass, and no test in
this file would notice.

If the requirement is "a hypervisor bug is the only way out", that is **mode
two**, designed in `docs/adr/0003-mode-two-full-isolation-vm.md` (Accepted,
2026-08-01) and not yet implemented. `resolveCodeExecutor` throws rather than
downgrading `vm` to `fence` precisely so nobody gets the weaker boundary while
believing they asked for the stronger one.

---

## What the fence DOES stop (each claim has a test)

| Claim | Notes |
| --- | --- |
| Writes outside `scratchDir`, including via `..` traversal and via a symlink planted inside `scratchDir` | Containment is resolved (`realpath`), so links and traversal do not dodge it |
| Reads of the always-denied credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`) | Holds even under the widest `allowRead` the policy still accepts (`$HOME`) |
| Reads of any path the policy names in `denyRead` | Holds when `allowRead` names a *parent* directory. A policy that names the **same** path in both lists is **refused** — see non-guarantee 8 |
| All direct network egress — a raw `socket.connect()` that ignores `HTTP(S)_PROXY` gets nothing | True even when the domain **is** allow-listed: the allow-list is enforced at srt's proxy, not in the kernel |
| DNS: the sandboxed process has **no resolver at all**, so hostname-encoded exfiltration cannot leave | Even allow-listed names do not resolve in-process; resolution is proxy-side |
| HTTP(S) to a host outside `allowedDomains` | The proxy refuses the CONNECT |
| Inheritance by the whole process subtree — `subprocess`, `multiprocessing`, `os.fork()`, and a depth-2 grandchild all inherit the fence | This is srt's key property and the reason a fence beats a per-call guard |
| Host environment variables (`AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, `GITHUB_TOKEN`, provider API keys, …) | The environment is an **allow-list** (`INHERITED_ENV_VARS`), not a pass-through |
| Runaway CPU and runaway allocation | Killed by the request's timeout, with an asserted result shape (`exitCode: null`, a named `signal`, `timedOut: true`) |
| Descendants outliving the run | Nothing survives a normal settle, a timeout, or an abort — including a grandchild that detached its stdio |
| Cancellation in both positions | Aborted mid-run and aborted while queued both throw `ExecAbortedError`; the queued case never runs the code at all |

---

## What the fence does NOT guarantee

These are not bugs. They are the shape of the tool, and pretending otherwise is
how people get hurt.

1. **Reads are permissive by default.** srt's read model is deny-then-allow —
   its README states read access is allowed everywhere unless denied. The only
   reads a run cannot perform are the always-denied credential stores plus
   whatever the policy names in `denyRead`. A `.env`, a private repo checkout,
   or a password manager export sitting anywhere else on disk **is readable**.
   Callers that want a read jail must build the deny list; the fence will not
   infer it. There is a test asserting this permissive behaviour explicitly, so
   a future srt that flips the default turns it red instead of silently
   changing what we ship.
2. **Exfiltration through an allow-listed domain is not addressed.** srt filters
   *which hosts* a run may reach, not *what it sends them*. Allow-listing
   `github.com` permits pushing a stolen file to any repository. srt's own
   README says as much. Narrow the allow-list; do not treat it as DLP.
3. **CPU and memory are bounded only by the request timeout.** There is no
   memory ceiling, no CPU quota, and no disk-quota on `scratchDir`. A run can
   allocate until the host swaps, for as long as `timeoutMs` allows.
4. **Kernel-level attacks are out of scope.** A Seatbelt policy bypass, a
   seccomp/`bpf` bypass, a user-namespace escape, or a kernel LPE defeats the
   fence completely. Shared-kernel isolation cannot defend against this class.
   ADR-0003 is the answer, not a stronger profile here.
5. **Write grants are broad, and a write grant is also a READ grant on Linux.**
   `ALWAYS_DENY_READ_PATHS` is read-scoped by design, and a policy that puts
   `/` or `$HOME` in `allowWrite` really does grant writes across the machine.
   Write grants are the caller's explicit decision and are not second-guessed.

   The one place that is *not* left to the caller: an `allowWrite` **at or
   under** an always-denied credential store is now **refused**
   (`FencePolicyError`). bubblewrap masks a denied directory with `--tmpfs`,
   then re-binds every allowed write path at or under it with a read-**write**
   `--bind` — and there is no write bind you cannot read. So `allowWrite:
   ['~/.ssh']` would have re-opened the store for READING on Linux, through a
   channel the `allowRead` containment check never looks at. macOS keeps write
   and read authority separate and would not have leaked. That is the
   root-`allowRead` finding with the platforms swapped, which is exactly why
   the refusal lives in the policy layer instead of trusting whichever platform
   the run lands on. (Raised in review of the BST-1071 PR; derived from srt
   0.0.67's `pushReadDenyDirMounts`, and covered by mutation M12. **Still live
   at 0.0.73**, re-measured by EXECUTION under real bubblewrap rather than by
   reading that function — see the bump log: a write grant on the store listed
   9 entries where the control listed 0.)
6. **A hard crash of the host process leaks the run.** Live process groups are
   reaped on `process exit`, but a `SIGKILL` of the Electron/node host cannot
   run that handler. The sandboxed process keeps going — still inside its
   fence, but past its timeout. Fixing this needs an out-of-process supervisor.
   (Pre-existing; recorded in `docs/agents/code-execution.md`.)
7. **Covert channels are not considered.** Timing, filesystem metadata, and
   similar side channels are not modelled or tested.
8. **`allowRead` beats `denyRead`, so an exact collision is refused.** srt
   documents `allowRead` as taking precedence. A nested deny survives a broader
   allow only because srt re-emits it when `denied.startsWith(allowed + '/')` —
   which is false when the two paths are **equal**. `allowRead: [X]` +
   `denyRead: [X]` would therefore let the allow stand and drop the deny
   silently. That collision is now a `FencePolicyError`: the caller wrote a
   contradiction and gets told, rather than getting a config that does not mean
   what it says. A deny strictly *nested* inside an allow is the supported
   shape and still works. (Raised in review of the BST-1071 PR; mutation M13.)

---

## Live finding: root-wide `allowRead` defeated the credential deny (macOS)

Found while building this suite, on srt **0.0.67**, and **fixed in the same
change**.

`buildSandboxRuntimeConfig` permitted an `allowRead` entry that was an
*ancestor* of an always-denied store, on the documented assumption that srt
re-emits the nested deny after the broader allow. That assumption held for
every ancestor **except the filesystem root**.

srt's macOS profile generator re-emits a nested deny when
`denied.startsWith(allowed + '/')`. For `allowed === '/'` that compares against
`'//'` and never matches, so the last-match-wins `(allow file-read* (subpath
"/"))` won. Measured result with `allowRead: ['/']`:

- `glob.glob('~/.ssh/*')` returned real key filenames, including a private key;
- `~/.config/gh/hosts.yml` was read in full, contents and all.

`allowRead: ['/Users']` and `allowRead: [$HOME]` were **not** affected — the
re-emission works for every ancestor short of the root.

**Linux was not affected:** bubblewrap masks denied directories with `tmpfs` and only re-opens allow paths *under* the deny. That asymmetry is why the fix lives in our policy layer, not in a platform check.

**Fix:** `buildSandboxRuntimeConfig` now refuses a root-wide `allowRead` with a
`FencePolicyError` — refused, never narrowed, per the no-silent-fallback rule.
Every ancestor short of the root is still accepted.

Note the direction of the residual risk: the test that pins this
(`REFUSES a root-wide allowRead…`) is non-vacuous on macOS and vacuously true on
Linux. Anyone re-greening this suite after an srt bump must run it on **both**
platforms.

---

## Mutation-kill table

A green security test that stays green when its guard is removed is decoration.
Every mechanism below was weakened, the named test was re-run, and it had to go
red. **16/16 killed** (last full run at srt 0.0.73; later bumps re-ran the
srt-sensitive subset).

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
| M8 | process-GROUP kill reverted to single-pid (`-pid` → `pid`) | `leaves no ticking descendant alive when execute() settles normally` | KILLED |
| M8b | same | `leaves no ticking descendant alive when the run is ABORTED` | KILLED |
| M8c | same | `does not let a leftover descendant of run A inherit run B's egress` | KILLED |
| M9 | mid-run abort listener removed | `leaves no ticking descendant alive when the run is ABORTED` | KILLED |
| M10 | queued-position abort check removed | `throws ExecAbortedError with processStarted:false when aborted while QUEUED…` | KILLED |
| M11 | timeout watchdog disabled | `kills an infinite CPU loop on timeout…` | KILLED |
| M11b | same | `kills an unbounded allocation on timeout…` | KILLED |

### The two tests with no source-level mutation

`DENIES a raw socket that ignores the proxy environment…` and
`gives the sandboxed process NO resolver at all…` are guarded by srt's
**OS-level egress denial**, which nothing in our policy layer can weaken —
widening `allowedDomains` does not re-open a raw socket or a resolver, so a
policy mutation cannot kill them and pretending otherwise would be a fake entry
in the table above.

Their answer to "would this pass with the fence entirely absent?" is the
suite's own precondition probe: it runs the **identical** raw socket and the
identical name resolutions **unsandboxed** and refuses to run the network cases
unless they succeed. Fence absent ⇒ connect and resolve succeed ⇒ the tests
fail. That is the control.

---

## Two ways these tests could lie, and what stops them

Both of these were real defects caught while building this suite, not
hypotheticals.

**A "blocked" host that was never reachable.** The off-list assertion originally
used `example.org`, which answers **403** to python's default user agent from
some networks. `urlopen` raises on a 403 exactly as it raises on a refused proxy
tunnel, so the test passed while the allow-list was mutated wide open. Two
guards now: the precondition probe requires a real **200 unsandboxed** from the
off-list URL, and the test splits `HTTPError` (the origin answered — the request
escaped) from every other exception (the tunnel was refused).

**A DNS canary that never existed.** The DNS case originally resolved
`<canary>.example.org`, which returns NXDOMAIN — the very same `gaierror` a
fence block produces — with no fence in sight. It now resolves only hostnames
the precondition probe has already fetched successfully.

The general rule for anything added here: **ask what the result would be if the
fence were entirely absent.** If the answer is "the same", the test is
decoration.

---

## Skips are loud, and split

- **Host gate** (platform is not macOS/Linux, srt dependencies missing, no
  python on `PATH`) skips the whole suite with a `console.warn` naming exactly
  what is missing. Shared with the other two real-fence suites in
  `fixtures/fence-host-gate.ts`, which is also where the skip becomes a THROW
  in a lane that declared `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1` — a skip is the
  right answer on a laptop without bwrap and the wrong one in a lane built to
  run this.
- **Network gate** skips *only* the network cases, so an offline machine still
  gets the filesystem, policy, process-tree, environment and teardown proofs.
- Where an assertion cannot be proven on a given host — no populated credential
  store, no `~/.ssh` — the suite still asserts what it can and **warns that the
  assertion was vacuous** rather than reporting a proof it did not earn.

No skip ever weakens an assertion.

---

## Timing discipline

This suite runs on a heavily loaded machine. **No assertion is wall-clock
tight.** A timeout case asserts that the kill *happened* and what shape it left,
never that it happened within N milliseconds.

Descendant survival is checked with a **heartbeat counter** rather than a sleep:
the descendant ticks a file every 50 ms, the test records the counter the moment
`execute()` settles, waits a window many times longer than the tick, and
requires the counter not to have moved. A tick that already landed proves the
descendant really ran (non-vacuous); a frozen counter proves it is gone
(timing-independent). A flaky security test gets disabled, and a disabled
security test is worse than none.

---

## This suite is pinned to an exact srt version

`@anthropic-ai/sandbox-runtime` is pinned to **0.0.80** in the workspace catalog, and `PINNED_SRT_VERSION` in the spec asserts the installed version. The fence's guarantees are srt's guarantees, and a patch bump can change them silently.

**Bumping srt requires re-greening this suite; do not just update the constant.**

1. Run the full suite on **macOS and Linux**. The root-`allowRead` finding is macOS-only and the write-grant finding (non-guarantee 5) is Linux-only, so one platform proves nothing about the other.
2. Re-read srt's README security sections and reconcile the non-guarantee list.
3. Re-run at least the srt-sensitive mutations (M2, M3, M4, M12, M13) on both platforms; a bump can make a guard redundant.
4. Only then update `PINNED_SRT_VERSION` and `docs/agents/code-execution.md`.
5. Record in the PR which platforms actually ran, with test counts and skips.

### Getting the two platforms

- **macOS:** run `pnpm --filter @brainstrike/agent test:integration` locally. Seatbelt needs nothing installed.
- **Linux:** CI's unit shards in `.github/workflows/test.yml` install `bwrap`, `socat` and `rg`, lift `kernel.apparmor_restrict_unprivileged_userns`, and set `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`. A bump PR reaches that lane automatically because the pin change puts `@brainstrike/agent` in turbo's affected set.
  - Confirm the suite ran: the integration step must show this file with no `SUITE SKIPPED —` or `NETWORK CASES SKIPPED —` lines. A green check alone is not proof.
- With `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`, `refuseToSkipInAPromisedLane` in `fixtures/fence-host-gate.ts` turns every suite-wide skip (missing dependency, interpreter or probe host) and the network-cases skip into a failure. Developer machines and coverage lanes leave it unset and keep the loud skip.
- Any other Linux host must first prove bubblewrap can build a namespace: `bwrap --ro-bind / / --dev /dev --unshare-all /bin/echo ok` must exit 0. The dependency check only looks for binaries on `PATH`.

### Bump log

- **0.0.75 → 0.0.80 (BST-2029, 2026-10-18).** Baseline 47/47 on macOS arm64 and Ubuntu 26.04 x64; the candidate passed every behavior case before the pin moved. New Linux case: `unshare(CLONE_NEWUSER)` through the executor now returns `EPERM` (and must succeed under bare bubblewrap on the host first). M2, M3, M4, M12, M13 killed on both platforms. Ubuntu used the dedicated Bubblewrap copy and AppArmor profile in `docs/agents/code-execution.md`. Not qualified: packaged artifacts, Linux arm64, Windows. `allowNestedUserNamespaces` and other weakening options stay unset.
- **0.0.73 → 0.0.75 (BST-1669, 2026-09-07).** macOS 32/32 locally; Linux 32/32 with zero skips in CI. macOS deny paths are now folded into regex groups; the 900-byte cap falls back to literal filters, so no deny is dropped. The root-`allowRead` re-emission check is unchanged upstream. M2, M3, M4, M12, M13 killed.
- **0.0.67 → 0.0.73 (BST-1285).** macOS 32/32 and 16/16 mutations killed. Linux measured by hand in a privileged container: still holds against root `allowRead`, still leaks a read-denied store through a write grant (M12 stays load-bearing). Linux CI coverage arrived the next day (BST-1316).
