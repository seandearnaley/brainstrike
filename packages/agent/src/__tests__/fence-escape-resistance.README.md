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

**Linux was not affected.** bubblewrap masks denied directories with `tmpfs` and
only punches holes for allow paths *under* the deny, so `/` never re-opened
anything. CI is Linux and would never have caught this. That asymmetry is why
the fix lives in our policy layer rather than in a platform check — and it is
the durable reason, independent of what CI happens to run. (Two earlier
revisions of this note leaned on CI instead: first "CI runs on Linux", then
"CI does not even RUN this suite". The second was true when written and is no
longer — see [Getting the two platforms](#getting-the-two-platforms). The
asymmetry argument never depended on either.)

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
red. **16/16 killed.** Reproduce with the harness recorded in the BST-1071 PR
description.

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

`@anthropic-ai/sandbox-runtime` is pinned to **0.0.75** in the workspace
catalog, and a test in this file asserts the installed version matches.

That is deliberate. The fence's guarantees *are* srt's guarantees, and the live
finding above was an off-by-one inside srt's own profile generation — the kind
of thing a patch bump can introduce or remove silently.

**Bumping srt requires re-greening this suite. Do not just update the constant.**

1. Run the full suite on **macOS and Linux** (the root-`allowRead` finding was
   macOS-only; a Linux-only run proves nothing about it — and the converse
   holds for the write-grant finding, non-guarantee 5). **CI supplies the Linux
   half as of BST-1316**; before that it did not, and the bump log's 0.0.73
   entry is what a bump reads like without it. See
   [Getting the two platforms](#getting-the-two-platforms) for where each half
   comes from and how to confirm the Linux one actually ran. Either way the
   bump log must say which platforms actually ran rather than which ones were
   assumed to be covered.
2. Re-read srt's README security sections and reconcile the non-guarantee list
   above with whatever changed.
3. Re-run the mutation table — a bump can make a guard redundant, which shows up
   as a mutation that stops killing.
4. Only then update `PINNED_SRT_VERSION` and
   `docs/agents/code-execution.md`.

### Getting the two platforms

**macOS: run it yourself.** Seatbelt needs nothing installed.

```bash
pnpm --filter @brainstrike/agent test:integration
```

**Linux: CI supplies it — as of 2026-08-16.** Do not read a green Unit check as
the Linux half without confirming the suite actually RAN. It did not, for the
whole life of this suite before that date: `checkDependenciesAsync()` requires
`bwrap`, `socat` and `rg` on Linux, no workflow installed them, and all three
real-fence suites skipped themselves — loudly in the log, green in the check
(`32 tests | 27 skipped`, with only the ungated version pin actually running).
The `unit-shard` job in `.github/workflows/test.yml` now installs the three
binaries and lifts `kernel.apparmor_restrict_unprivileged_userns`, which the
Ubuntu 24.04 runner image sets and without which bubblewrap cannot create a
namespace at all (`bwrap: setting up uid map: Permission denied`) — the
dependency check passes and every fenced run still produces nothing.
`docs/agents/code-execution.md` carries the measurements.

A bump PR reaches that lane on its own: the pin lives in `pnpm-workspace.yaml`,
so the lockfile change puts `@brainstrike/agent` in turbo's affected set.

What to check on the bump PR, in order:

1. `Unit (rest)` is green **and** its integration step shows this file with **no
   skips attributable to the host gate**. A `SUITE SKIPPED —` line in that log
   means the Linux half did not happen, whatever the check says.
2. The network cases ran (no `NETWORK CASES SKIPPED —` line). Runner egress is
   open, so a skip there is a signal, not weather.

If the lane ever cannot supply it — a runner image that blocks user namespaces
outright, say — the honest fallback is a documented manual run recorded in the
bump PR the way the macOS half is, **not** a green check. The 0.0.73 entry in
the bump log below is the worked example: a `--privileged` `node:24-bookworm`
container, and an explicit statement of which cases it could and could not
reach. Note what it could not: srt's vendored `apply-seccomp` cannot run under
Docker Desktop's LinuxKit kernel, so the network, unix-socket and process-tree
cases stayed unrun there. **The CI lane has no such hole** — it runs on a real
kernel with seccomp active (`checkDependenciesAsync()` returns no warnings), so
those cases now execute for the first time.

What any such host has to prove first, before a suite result from it counts, is
the thing this lane learned the hard way: that bubblewrap can actually build a
namespace there. `bwrap --ro-bind / / --dev /dev --unshare-all /bin/echo ok`
exiting 0 is that proof; the dependency check passing is not, since it only
looks for binaries on `PATH`.

**A skip can no longer go quiet.** The Unit integration steps set
`BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`, and `fixtures/fence-host-gate.ts` throws
rather than skips when it is set — so a runner that stops meeting the
prerequisites fails the lane instead of reporting a security suite it never
ran. The variable is deliberately unset on developer machines and in the
coverage lanes, which install nothing and keep the loud-skip behaviour.

**Every suite-wide reason escalates, not just the missing-dependency one.** The
escalation sits at `refuseToSkipInAPromisedLane`, the choke point that sees the
final reason, rather than inside the dependency check. Scoping it to
dependencies alone (this PR's first shape, caught in review) still left a
promised lane able to go green having proven nothing: a missing interpreter
skips all three suites, and an unreachable probe host skips `fence-executor`
and `run-python-tool` *entirely* — filesystem and process-tree proofs included.
The NETWORK-cases gate in this file escalates for the same reason: dropping the
raw-socket, DNS and allow-list proofs quietly is the same broken promise as
dropping the file.

---

### Bump log

- **0.0.73 → 0.0.75 (BST-1669, 2026-09-07).** Two upstream releases.
  **Platforms that actually ran: macOS locally; Linux from CI** (see below for
  how the Linux half was confirmed rather than assumed).

  **Step 1 — what changed upstream.** Diffed the published 0.0.73 and 0.0.75
  tarballs rather than reading 0.0.75 alone. Three things moved in the security
  surface: `macos-sandbox-utils` now folds literal deny paths into generated,
  anchored regexes instead of emitting one `subpath` filter per path
  (`groupLiteralDenyPaths`, `SBPL_STRING_MAX_BYTES = 900`,
  `MIN_DENY_GROUP_SIZE = 4`) — a profile-generation change, i.e. exactly the
  layer the root-`allowRead` finding lives in; `generate-seccomp-filter` and
  `linux-sandbox-utils` changed; and a new opt-in `javaAgentJarPath` injects a
  JVM proxy agent via `JAVA_TOOL_OPTIONS`. srt's README security sections are
  otherwise **identical** — no guarantee was added or withdrawn. The JVM agent
  does not reach this fence: it runs Python and Node, never a JVM.

  **Step 2 — the root-`allowRead` finding survives.** The re-emission test is
  `literalAllowDirs.some(a => deny.path.startsWith(a + '/'))` and is
  **byte-identical** between the two tarballs (0.0.73 line 154, 0.0.75 line
  155). For an allow of `/` that prefix is `//`, which no real path starts
  with, so the deny is still dropped. Confirmed live: `REFUSES a root-wide
  allowRead …` passes at 0.0.75. Non-guarantee 8 (`allowRead` beats `denyRead`
  on an exact collision) is unchanged for the same reason.

  **Step 3 — full macOS run, zero skips.** macOS 26.6.2, arm64, real Seatbelt:
  **31 passed, 1 failed**, the single failure being the version-pin test itself
  while the constant still read `0.0.73` — which is the intended order, since
  it proves every substantive case was exercised *before* the pin moved. No
  `SUITE SKIPPED` and no `NETWORK CASES SKIPPED`, so the network, fork,
  grandchild, timeout and abort cases all ran. The regex-folded deny paths
  changed no observable behaviour: `still permits a denyRead NESTED inside an
  allowRead` and `REFUSES an allowRead that sits directly on an always-denied
  store` both still hold.

  **Step 4 — mutation re-run, srt-sensitive subset: 5/5 still KILLED.** M2
  (glob refusal), M3 (root refusal), M4 (`ALWAYS_DENY_READ_PATHS` dropped), M12
  (allowWrite store containment) and M13 (exact collision) were each weakened
  and each named test went red. These are the five whose guards could have been
  made **redundant** by srt learning to deny on its own — the failure mode a
  bump introduces. The remaining eleven (M1, M5–M11b) guard process-lifecycle
  and env behaviour in our own executor, which srt's profile generation cannot
  make redundant; they were **not** re-run, and this entry says so rather than
  claiming 16/16.

- **0.0.67 → 0.0.73 (BST-1285).** Six upstream releases, all with published
  release notes. Nothing in them weakens a restriction this suite relies on;
  the two macOS filesystem changes (the profile compaction in 0.0.71 and the
  glob-deny fix in 0.0.72) are respectively text-only and deny-only, and srt's
  seccomp filter generator is byte-identical across the whole range.

  **Step 1 — macOS: full suite, 32/32 against real Seatbelt. Linux: the full
  suite did NOT run.** No lane installs srt's Linux dependencies, so the host
  gate skips it; this bump's own CI logged `SUITE SKIPPED — sandbox-runtime
  dependencies are missing on this linux host: ripgrep (rg) not found,
  bubblewrap (bwrap) not installed, socat not installed` (32 tests, 27 skipped,
  2ms). Do not record "Linux is covered by CI" — it is not, and was not here.

  What WAS measured on Linux, by execution rather than by reading the source:
  the two PLATFORM-ASYMMETRIC findings, in a bubblewrap container
  (`node:24-bookworm`, linux/arm64, Docker `--privileged`, srt 0.0.73 from npm,
  a synthetic 9-entry `~/.ssh`, entry COUNTS only):

  | arm | config handed to srt | `~/.ssh` entries |
  | --- | --- | --- |
  | unsandboxed control | — | 9 |
  | root read grant (the macOS leak) | `allowRead: ['/']` | 0 |
  | ancestor read grant (control) | `allowRead: [$HOME]` | 0 |
  | write grant on the store (M12) | `allowWrite: ['~/.ssh']` | **9** |
  | write grant elsewhere (control) | `allowWrite: [$HOME/plain]` | 0 |

  So at 0.0.73 Linux still HOLDS against the root-`allowRead` hole (tmpfs
  masking) and still LEAKS a read-denied store through a write grant. Both
  platform asymmetries this suite documents are re-earned at this version, and
  the M12 refusal is exactly as load-bearing on Linux as M3 is on macOS.

  That container is not a substitute for the suite: srt's vendored
  `apply-seccomp` helper cannot run under Docker Desktop's LinuxKit kernel (its
  `uid_map` write is refused), so it was removed and srt degraded to its
  documented "seccomp not available" warning. The arms above are bwrap
  mount-namespace behavior and do not depend on it — the network, unix-socket
  and process-tree cases do, and they remain UNRUN on Linux at 0.0.73.

  **Step 2 — the root-`allowRead` finding** was re-measured against 0.0.73 on
  macOS and is **unchanged**: handing srt the config our policy layer refuses
  (`allowRead: ['/']` plus the credential denies) let sandboxed python list 9
  entries in `~/.ssh`, while the same probe under a normal non-root ancestor
  allow (`$HOME/Documents`) listed 0. So the M3 guard did NOT become redundant
  — dropping it would re-open the stores today.

  **Step 3 — mutation table re-run on macOS at 0.0.73: 16/16 still KILLED.**
  Every row was re-applied to the source and the named test re-run; a row only
  counts as killed when that one test is the one that failed (`Tests 1 failed |
  31 skipped` in every case). A `-t` filter matching nothing also exits
  non-zero, so a bare non-zero exit is not evidence — one row initially
  reported `32 skipped` because vitest reads `-t` as a REGEX and `execute()`
  matched no title; it kills once the pattern is regex-safe. Two rows the
  release range put in question:

  - **M2 (glob refusal).** 0.0.72 #465 strengthened the DENY side — macOS now
    re-emits glob `denyRead` entries inside an `allowRead` region. Our refusal
    is about globs in `allowRead`, which srt would expand into paths the
    containment guard never compared, so nothing about it became redundant.
  - **M7 (network allow-list).** 0.0.68's `:port` suffixes cannot be expressed
    through `policyDomainSchema` (`DOMAIN_PATTERN` has no `:`), and a port-less
    pattern still matches every port
    (`matchesDomainPatternWithPort`), so the allow-list means exactly what it
    meant at 0.0.67.

  New upstream surface (`:port` domain suffixes, `deniedDomainReasons`,
  `commandId` attribution, Windows credential-store relocation) is additive and
  unreachable from `ExecPolicy`.

  **Postscript (BST-1316, one day later): the Linux gap this entry documents is
  closed.** The `unit-shard` job now installs `bwrap`/`socat`/ripgrep and lifts
  `kernel.apparmor_restrict_unprivileged_userns`, and the full suite runs on
  Linux at 0.0.73 — 53 tests, **zero skips**, the same 53 macOS runs. The cases
  this entry had to leave unrun (network, unix-socket, process-tree) execute
  there on a real kernel with seccomp active, which the `--privileged` container
  could not offer. One assertion needed fixing rather than the fence: the
  child-write case in `fence-executor` matched only Seatbelt's wording, while
  bubblewrap masks paths outside the write grant by re-mounting them read-only
  (`OSError: [Errno 30] Read-only file system`). Everything this entry measured
  by hand still stands; the next bump gets it from CI instead.

