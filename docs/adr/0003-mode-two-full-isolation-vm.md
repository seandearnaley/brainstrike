# ADR-0003: Mode two ("full isolation") — embed Virtualization.framework directly

- **Status:** Accepted (2026-08-01, decided by Sean Dearnaley)
- **Date:** 2026-08-01
- **Ticket:** BST-1069 (design only — no implementation lands with this ADR)
- **Builds on:** BST-1060, the `CodeExecutor` seam (`packages/agent/src/code-execution.ts`,
  contract in `docs/agents/code-execution.md`), merged to `main` as d809f0dc5. This ADR
  designs the `vm` backend of that seam and changes nothing about it.
- **Context source:** `docs/sandboxing-research-2026-07-25.html` (the report that established
  the two-mode path and rejected containers/hosted sandboxes as the *default*); Apple's
  Virtualization framework documentation, re-verified 2026-08-01; Anthropic's published Cowork
  architecture overview; third-party Cowork teardowns and the SharedRoot escape write-up.

## Evidence labels used throughout

Claims in this document carry their provenance, because "what the framework actually does"
and "what someone said a competitor's binary does" are not the same kind of fact.

| Label | Meaning |
| --- | --- |
| **[APPLE]** | Verified against `developer.apple.com` documentation on 2026-08-01. Availability versions are quoted from the docs, not from memory. |
| **[VENDOR]** | Anthropic-published, in the Claude Cowork architecture overview (support.claude.com article 14479288). |
| **[INFERENCE]** | Third-party teardown / reverse-engineering of a shipped binary. **Not vendor-confirmed**, may be version-specific, may already be wrong. Never load-bearing for a security claim here — only used to explain why a shape is plausible. |

---

## Context

The `CodeExecutor` seam defines two modes and refuses to blur them:

- **`fence`** (mode one, BST-1062) wraps a bundled pinned CPython in an
  `@anthropic-ai/sandbox-runtime` OS fence — Seatbelt on macOS, bubblewrap on Linux. It bounds
  the blast radius of code running against *the user's real machine and real toolchain*.
- **`vm`** (mode two, this ADR) answers a different question: **run something where a
  hypervisor bug is the only way out.** Not "confine my toolchain" but "I do not trust this
  code with my machine at all."

These are not two points on one dial. A fence shares the host kernel; every macOS Seatbelt or
Linux seccomp bypass is a total bypass. Mode two exists so that a workspace can ask for a
boundary whose failure mode is a hypervisor CVE, not a sandbox-profile mistake. That is why
`resolveCodeExecutor` throws instead of downgrading: a workspace that asked for a hypervisor
and got a syscall filter has been lied to.

House constraints that bind this design:

- **Local-first.** No hosted-microVM tier. The 2026-07-25 report already rejected
  E2B/Vercel/Daytona/Modal for the default path: they send the user's code to someone else's
  cloud, against the privacy wedge. Nothing here reopens that.
- **No user-visible install step.** "Install Docker first" is the bar we are clearing, not a
  compromise we are willing to make (D9; Alternative C is rejected, not deferred).
- **Capability-based gating.** `vm` is available iff the host advertises a `vm` factory. Never
  `isElectron()`, never `process.platform` checks in shared code.
- **No silent fallbacks.** Every unrepresentable policy, failed health check, and missing
  capability throws visibly.
- **Sync stance (BST-911).** Future sync covers the *mind* — threads and memory. VM
  bundles, rootfs images, disk images, and snapshots are **device-local artifacts that must
  never enter a sync set**, and must be wired into factory reset like any other persistence.

---

## Decision

**D1. Embed Apple's Virtualization.framework directly**, in a small signed helper process that
Electron main owns — not a shell-out to a third-party CLI, and not a requirement that the user
install Docker/OrbStack/Podman. This follows the Cowork/Tart/OrbStack pattern: the app links
the framework and owns the VM configuration.

**D2. One warm VM per workspace root**, booted lazily on first `execute()`, reused across runs,
torn down on an idle timer / workspace close / app quit. Cold-boot-per-run is not the default.
**Isolation granularity is per workspace, not per session inside a shared VM** — two workspaces
never share a guest kernel — with a **default cap of one warm VM** and LRU eviction on the idle
timer. That cap is the answer to the memory ceiling in risk 2; raising it is a measured decision,
not a default.

**D3. A pinned, minimal ARM64 Linux rootfs that we build and own**, content-addressed by digest,
**fetched-and-verified on first enable** rather than shipped in the app bundle, refreshed as part
of an app release. Direct kernel boot (`VZLinuxBootLoader`) rather than EFI + full disk image.
Owning the rootfs and kernel pipeline is an accepted, funded obligation, not a fallback we take
if something easier fails — see D9.

**D4. VirtioFS exposes granted folders only. There is never a share rooted at `/`, `$HOME`, or
any ancestor of them — not even one gated on guest-root.** This is the one place we knowingly
diverge from the shape Cowork shipped, and the divergence has evidence behind it (see
"Folder-mount scoping").

**D5. Deny-first egress through a host-side proxy reached over vsock. The guest gets no virtio
network device at all.** The security claim is not "our proxy is well configured"; it is "there
is no network interface in the machine."

**D6. A second fence inside the guest** — bubblewrap + a seccomp filter + a per-run unprivileged
user. The VM boundary is not trusted alone, and (importantly) the guest fence is also where
policy fidelity lives, not merely defense in depth (see the lossiness table).

**D7. `vm` is gated as a host capability** computed from: helper binary present, entitled,
`VZVirtualMachine.isSupported` true [APPLE], and a verified rootfs digest on disk. When any of
those is false the `vm` factory is simply absent and the seam's existing
`ExecutorKindUnavailableError` fires. Nothing new is needed at the seam.

**D8. macOS on Apple silicon only for v1.** Everything else is fence-only, with no stub and no
"vm (unavailable)" ghost in shared code. Windows/Hyper-V is a later, separate ADR. Mode two is
explicitly allowed to ship on one platform first rather than waiting for parity.

**D9. No dependency on a user-installed container runtime, in any form.** Gating mode two on
Docker, OrbStack, or Podman is rejected outright — not deferred, not held as a descope valve.
The ruling on acceptance: *no other stuff like Docker is acceptable; follow canonical and modern
idioms for 2026 — whatever folks like Claude Code, OpenCode, and oh-my-codex do.* Those tools
converge on embedding the platform's own isolation primitives and shipping their own runtime,
with no third-party daemon in the user's install path, and that is the idiom this design follows.
Alternative C below remains documented as a **rejected** alternative so the reasoning survives;
it is not a plan B.

---

## Why direct-embed (the decision space)

| | **Direct-embed VZ** (D1) | Shell out to Apple `container` CLI | Embed `Containerization.framework` | Require Docker/OrbStack/Podman |
| --- | --- | --- | --- | --- |
| **Install burden on user** | None (helper ships with app; rootfs auto-fetched) | User installs a CLI; macOS 26+ | None, but macOS 26+ floor | **High** — a multi-GB third-party install, sometimes a paid licence |
| **Who maintains the boundary** | Us: rootfs, kernel pin, guest daemon | Apple, but through a text interface we parse | Apple (Swift API) | The runtime vendor |
| **Control over mounts / egress** | Total — we choose every share and there is no NIC | Weak — the CLI's networking and mount model, not ours | Moderate — container-shaped, not VM-shaped | Weak — bind mounts + bridge networking we do not own |
| **Warm reuse** | Native (warm VM, `share` re-pointable at runtime [APPLE]) | Fights the model (VM-per-container) | Fights the model (ephemeral containers) | Yes, but a container, not a VM |
| **macOS floor** | 11.0 for the core API [APPLE]; realistically 14.0 for save/restore | 26 | 26 | Whatever the runtime needs |
| **Cross-platform** | No — Windows needs a Hyper-V sibling | No | No | **Yes**, and that is its one real advantage |
| **5-year survival** | Good: VZ is Apple's own supported public framework, load-bearing for their own container stack, growing (nested virt in macOS 15 [APPLE]) | Unproven: v1.0.0 June 2026, high star count, but no shipped downstream adopters — Lima and Podman both have *open* threads, not shipped drivers | Same framework risk as the CLI, minus the CLI | Good but not ours; Docker Desktop licence terms have moved before |

The project canon that pointed at direct-embed holds up, with one refinement worth recording:
the earlier demotion of Apple's `container` was about the **CLI**. `Containerization.framework`
— the Swift library underneath it — is a genuinely different and more attractive option than the
CLI was, and it is recorded as Alternative B rather than swept in with the CLI. It still loses
for v1, but for narrower reasons.

The decisive argument for direct-embed is not performance. It is **the mount and egress model**.
D4 and D5 are the substance of mode two, and both require choosing precisely which host
directories become a `VZSharedDirectory` and refusing to attach a network device at all. Every
CLI/container option makes those decisions for us and hands us the result. We would then be
writing this ADR's security section about someone else's defaults.

---

## Seam integration

### Where it plugs in

The `vm` backend is a `CodeExecutorFactory` supplied as `CodeExecutorHostCapabilities.vm`.
`resolveCodeExecutor('vm', host)` returns it when present and throws
`ExecutorKindUnavailableError` when absent — **already implemented and tested** in
`packages/agent/src/code-execution.ts`. This ADR does not redesign, extend, or special-case any
of that. In particular: there is no `vm`→`fence` downgrade, and a persisted workspace
`executorKind: 'vm'` opened on a Linux or Intel-Mac host raises the typed error up to the tool
layer, which surfaces it. That is the correct behavior, not a bug to smooth over.

`capabilities()` for the VM executor:

```
{ languages: ['python', 'javascript', 'bash'],
  maxIsolationTier: 'vm',
  platform: 'darwin',
  supportsNetwork: true }
```

`supportsNetwork: true` describes the *backend*, not a run: it means this executor is capable of
egress when a policy allows a domain. A run whose `allowedDomains` is `[]` has no egress. The
seam already treats `allowedDomains: []` as "no network" with no separate flag, and the VM
backend must not introduce one.

### ExecPolicy → VM terms, and where the mapping is lossy

This is the part most likely to be got wrong, so it is stated as a table with the lossiness
called out explicitly rather than buried.

The compiler's input is an `ExecInput`, not an `ExecPolicy`. Per
`packages/agent/src/code-execution.ts`, `execPolicySchema` is `.strict()` and holds exactly
`allowedDomains`, `allowRead?`, `allowWrite`, `denyRead?`; `scratchDir` and `timeoutMs` are
`ExecInput` fields sitting *beside* `policy`. Reading them off `policy` yields `undefined`, so
the source object is named per row below.

| Field (source) | VM realization | Lossy? |
| --- | --- | --- |
| `allowWrite: string[]` (`ExecPolicy`) | Each entry is resolved at compile time; **a directory entry becomes the share itself**, a file entry becomes a share of its parent directory. The result joins the `bs-rw` `VZMultipleDirectoryShare`; the guest fence bind-mounts the exact entry | **Yes, for file entries only.** VirtioFS shares a *directory*, so allowing one file widens to its parent at the VirtioFS layer; the fence narrows it back. Directory entries are exact. |
| `allowRead?: string[] \| undefined` (`ExecPolicy`) | Same resolution rule, into a read-only `VZSharedDirectory(url:readOnly: true)` [APPLE] in the `bs-ro` share | **Yes**, same file-entry widening. |
| `denyRead?: string[] \| undefined` (`ExecPolicy`) | **Not expressible at the VirtioFS layer at all** — a share has no deny list | **Yes, and dangerously so.** A `denyRead` path nested inside an `allowRead` directory is enforced *only* by the guest fence's bind set. |
| `allowedDomains: string[]` (`ExecPolicy`) | The host proxy's allowlist. `[]` ⇒ the host registers no proxy acceptor for the run ⇒ nothing to connect to | No, this one is faithful. |
| `scratchDir: string` (**`ExecInput`**) | A dedicated read-write share (`bs-scratch`) owned by the run's guest uid | No. |
| `timeoutMs: number` (**`ExecInput`**) | Enforced twice: guest daemon kills the process group, host RPC deadline is authoritative and kills the VM's run regardless | No. |

**Resolution rule for every path entry**, because the widening above is only safe if the entry's
kind is known: `realpath` the entry at compile time and branch on directory-vs-file. A path that
does not exist has no knowable kind and no containing directory to infer — it raises
`PolicyNotRepresentableError` rather than being guessed at. Comparisons for the forbidden-share
list (below) run on the **resolved** path, never the literal string.

**`undefined` and `[]` are different and the compiler must treat them so.** `allowRead` and
`denyRead` are `.optional()`: absent means "the policy expresses no opinion", empty means "the
policy expressly grants/denies nothing". They compile to the same empty share today, but a
compiler that conflates them will get the eventual "deny everything not named" semantics wrong,
so the distinction is preserved at the boundary.

Three rulings follow from the lossiness:

1. **The guest fence is load-bearing for policy fidelity, not just defense in depth.** File
   granularity and `denyRead` are enforced *inside* the guest. A bug in the guest bwrap spec is
   a policy bug, not a missing extra layer. D6 is therefore not optional and cannot be dropped
   as an optimization.
2. **Policy compilation throws rather than widening silently.** When compiling an `ExecInput`
   into a VM configuration, any entry that cannot be represented within the sharing model —
   e.g. a `denyRead` that is not enforceable given the resulting bind set, a nonexistent path
   whose kind cannot be resolved, or an `allowWrite` **file** whose parent directory would drag
   in an unrelated tree — must raise a typed `PolicyNotRepresentableError` naming the offending
   entry. It must never round up to a wider share. This is the NO SILENT FALLBACKS rule applied
   at the exact place it is most tempting to break.
3. **Ownership semantics differ and must be documented, not absorbed.** [APPLE] The framework
   reads and writes shared files using the **host effective user's UID**, refuses reads or
   overwrites of files that user cannot access, and **ignores guest requests to change UID or
   GID**. So `chown` inside the guest silently no-ops on shared paths, and guest-side ownership
   of shared files is not what a build script expects. Tool-facing docs must say so.

There is also lossiness in the *other* direction: the VM provides isolation the policy has no
vocabulary for (its own kernel, its own PID/mount/net namespaces, its own page tables).
`ExecPolicy` cannot describe it, and `capabilities()` must not over-claim it — `maxIsolationTier:
'vm'` is the whole vocabulary we have, and that is fine.

---

## Host ↔ guest control channel

### Transport

`VZVirtioSocketDevice` (vsock), macOS 11.0+ [APPLE].

- Host → guest: `connect(toPort:completionHandler:)` [APPLE].
- Guest → host: a `VZVirtioSocketListener` registered with `setSocketListener(_:forPort:)`
  [APPLE].
- On macOS, `AF_VSOCK` is not a general host socket family — connections are established and
  mediated by the framework through the `VZVirtioSocketDevice` object [APPLE, corroborated by
  the framework's own connection model]. **This is a security property worth stating**: no other
  process on the Mac can reach the guest daemon; only the helper that owns the VM object can.

Two ports:

| Port | Direction | Purpose |
| --- | --- | --- |
| `1024` | host → guest | Control RPC (exec, health, mounts, session lifecycle) |
| `1025` | guest → host | Egress proxy stream (one vsock connection per proxied TCP connection), first frame bearing the authorizing run token |

**A fenced run process must never be able to open an `AF_VSOCK` socket.** The guest seccomp
filter denies `socket(AF_VSOCK, …)` outright. Otherwise the innermost sandbox could talk
directly to the host control channel and ask it to run things.

**Invariant: the guest daemon never binds control RPC on loopback.** Control is vsock-only, in
both directions. This matters because the fence deliberately does not `--unshare-net` (see the
egress section), so untrusted run code shares the guest netns with every loopback listener the
daemon owns — today that is the proxy and nothing else. Moving any control surface onto
`127.0.0.1` "for convenience" would hand the payload the control channel, which is exactly what
the `AF_VSOCK` seccomp denial exists to prevent.

### Message shapes

Newline-delimited JSON, request/response correlated by `id`, streaming frames tagged by `runId`.
Deliberately boring — this is a control channel, not a data plane; file data moves over VirtioFS
and network bytes over the proxy port.

```
→ hello        { protocolVersion, hostBuild }
← ready        { protocolVersion, rootfsDigest, kernelRelease, toolchain: { python, node } }

→ exec.start   { runId, argv, env, cwd, sessionId, fence: FenceSpec, egressToken, limits: { timeoutMs, maxOutputBytes } }
← exec.started { runId, pid }
← exec.output  { runId, stream: 'stdout'|'stderr', seq, chunk }      (repeated)
← exec.exit    { runId, exitCode, timedOut, truncated }
→ exec.kill    { runId, signal }
→ egress.revoke { runId }          # retire egressToken; kill surviving tunnels

→ mount.sync   { mounts: [{ tag, guestPath, mode: 'ro'|'rw' }] }
← mount.synced { mounts }

→ health.ping  { nonce }
← health.pong  { nonce, uptimeMs, memAvailableBytes, loadavg }

→ session.reset { sessionId }      # purge the run user, its scratch, its /tmp
← session.reset.ok { sessionId }
```

**`env` is built from scratch, never inherited.** The helper is a child of Electron main, whose
environment holds provider API keys (`docs/agents/assistant-providers.md`). Inheriting
`process.env` into a run — the path of least resistance — would put those keys inside the
sandbox and make every allowlisted domain an exfiltration route. The run environment is
constructed explicitly from `PATH`, `HOME`, the proxy variables, and the run's own additions,
and the helper passes an empty base environment to the guest. Note `ExecInput` has no `env`
field today, so nothing at the seam constrains this — this ADR is where it gets decided.

**`egressToken` is minted per run** and is the only thing that authorizes a proxied connection
(see the egress section). It is retired at `exec.exit` or on `egress.revoke`, whichever comes
first.

`FenceSpec` is the bubblewrap/seccomp description derived from the compiled `ExecPolicy`: the
exact bind set (ro/rw), the run uid, and the seccomp profile id. The guest daemon **does not
interpret `ExecPolicy`** — policy compilation happens host-side, where the policy lives, and the
guest receives an already-resolved bind set. One place decides, one place obeys.

`protocolVersion` is pinned to the rootfs digest. A mismatch is fatal: the VM is stopped and a
typed error is raised. No compatibility shims, no "best effort with an older daemon."

### Lifecycle

```
cold ──boot──▶ booting ──ready──▶ ready ⇄ busy
                  │                 │
                  │            idle-timeout
                  │                 ▼
                  └──fail──▶ poisoned ──▶ stopping ──▶ stopped
```

- **Boot** happens lazily on the first `execute()` for a workspace root. Boot cost is a target
  to measure during implementation, not a number this ADR is entitled to claim.
- **Warm reuse**: subsequent runs reuse the `ready` VM. Runs are serialized per VM by default;
  concurrency inside one VM is a later question and should not be assumed by callers.
- **Snapshot fast-start is an optional optimization, gated at runtime.** [APPLE]
  `saveMachineStateTo(url:)` / `restoreMachineStateFrom(url:)` are macOS 14.0+; save requires the
  VM to be **paused**, restore requires it to be **stopped**, and Apple states plainly that "not
  all configuration options can be safely saved and restored" — hence
  `validateSaveRestoreSupport()` [APPLE]. **Whether a configuration carrying VirtioFS shares and
  a vsock device is savable is unverified** and is an explicit implementation spike. The design
  must be correct without snapshots; if `validateSaveRestoreSupport()` throws, we boot normally
  and say so in diagnostics.
- **Health**: the host pings on an interval and before dispatching a run after any idle gap. A
  missed pong, a protocol mismatch, or a guest daemon exit moves the VM to `poisoned`.
- **Poisoned never silently recovers.** The VM is killed and the in-flight run fails with a typed
  error. A fresh boot is permitted only *between* runs and must be surfaced in the run's event
  stream — silently rebooting mid-session would discard guest filesystem state (`/tmp`, installed
  packages, background processes) while pretending continuity.
- **Teardown**: idle timer (default: minutes, tunable), workspace close, app quit. The helper
  watches its parent; if Electron main dies the helper stops the VM and exits. A leaked
  `VZVirtualMachine` holding gigabytes is the most likely user-visible failure of a warm design,
  so this gets a test, not a comment.

---

## Rootfs build / update pipeline

**Shape.** A minimal ARM64 Linux userland with a pinned kernel + initramfs, booted with
`VZLinuxBootLoader(kernelURL:)` plus `initialRamdiskURL` and an explicit `commandLine` [APPLE].
Direct kernel boot is preferred over EFI + full disk image: fewer moving parts, no bootloader to
maintain, and the kernel command line is ours (which matters — `user_namespaces`, module
autoloading, and console settings are all boot-arg decisions).

**Contents**, deliberately small:

- The guest daemon (static binary), and **bubblewrap setuid-root — the single privileged binary
  in the image** (see the egress section for why it must be setuid given unprivileged userns is
  off, and what that trade costs). Nothing else in the image is setuid or capability-endowed.
- A pinned CPython for **linux-aarch64** matching the version mode one pins for the host
  (BST-1061 pins a macOS-host python-build-standalone artifact; the guest needs the
  *linux-aarch64* build of the same version — this is a real cross-ticket dependency and not a
  detail to discover during implementation).
- Node, and the handful of tools the code tools actually need.
- **No** sshd, **no** package manager at runtime, **no** systemd if a minimal init suffices.

**Reproducibility and distribution.** Built in CI from a checked-in recipe (mkosi/debootstrap or
equivalent), content-addressed by digest. The app pins exactly one digest per release.

- Not in the app bundle — the size cost is paid by every user including the ones who never
  enable mode two. Fetched on first enable from a release asset.
- Verified by digest **and** a signature over the manifest with a key we control. Gatekeeper and
  notarization do not help here: the rootfs is data, not code we sign as an executable, so
  integrity is entirely our own problem.
- Stored under Application Support alongside the VM bundle, and **wired into factory reset**
  (platform contract).
- A rootfs whose digest does not match the running app's expectation **refuses to boot** rather
  than running a stale image. Old images are not silently reused across upgrades.

**Updates.** A CVE in the guest kernel is our patch obligation: rebuild, re-pin, ship in the next
app release, and the digest mismatch forces the refetch. This is the single largest ongoing cost
of D1, it was accepted with eyes open (D9), and it therefore needs a named owner and a
CVE-watch routine at implementation time rather than good intentions in a doc.

---

## Folder-mount scoping

**Devices, one per policy class**, rather than one share with mixed semantics:

| Tag | Share | Mode |
| --- | --- | --- |
| `bs-ro` | `VZMultipleDirectoryShare` of read-granted folders | read-only at the **host** [APPLE] |
| `bs-rw` | `VZMultipleDirectoryShare` of write-granted folders | read-write |
| `bs-scratch` | the run's scratch directory | read-write |
| ~~`bs-rosetta`~~ | **Not created in v1** — reserved in the tag namespace only, because risk 5 makes x86-64-in-guest a non-goal. Listed so the name is not reused; the forbidden-share test treats the legal share set as exactly the three rows above. | — |

Read-only is expressed by `VZSharedDirectory(url:readOnly:)` [APPLE], i.e. enforced **on the
host side of VirtioFS**. That matters: a guest-root compromise can remount whatever it likes
inside the guest and still not write through a host read-only share. Enforcing read-only only
via guest mount options would put the whole guarantee behind the guest kernel.

**What the framework gives us for free**, and what it does not: [APPLE] the framework performs
shared-file I/O as the host effective user, refuses to read or overwrite files that user cannot
access, and ignores guest UID/GID change requests. So a share is bounded above by the host
user's own permissions. It is **not** bounded below by anything — a share of `$HOME` exposes
every credential that user can read. The framework will not save us from a bad share list.

**Hence D4, with evidence.** Cowork's shipped local mode mounted the entire host filesystem
read-write into the VM at `/mnt/.virtiofs-root`, visible only to guest-root [INFERENCE], with
per-session bind mounts narrowing what a session sees. That design makes "guest-root" the
boundary protecting the whole host. In July 2026 a published chain — unprivileged user
namespace → `CAP_NET_ADMIN` → a vulnerable kernel module → a page-cache poisoning CVE →
guest-root — walked straight through it to full host filesystem read/write [INFERENCE], and the
reported mitigation included scoping the share to the folders actually connected [INFERENCE].
The lesson is structural and does not depend on the details being exactly right: **a share that
exists is a share that one kernel bug reaches.** We therefore never create it.

Concretely forbidden, with a test asserting it. **Every clause is evaluated on the `realpath`-
resolved path, never the literal string** — a grant of `~/projects/foo` where `foo` is a symlink
to `/` passes every textual comparison and hands over the machine:

- No `VZSharedDirectory` whose resolved URL is `/`, `$HOME`, or a volume root.
- No share that is an ancestor **or a descendant** of the app's own Application Support
  directory — the directory itself and its whole subtree are off limits, in both directions.
  Ancestor-only was the original phrasing and it was wrong: a share of
  `~/Library/Application Support/<app>` satisfies an ancestor-only test while handing the guest
  the PGlite database, the stored provider API keys, and the VM bundle itself. That last one is
  the sharpest edge — a guest able to rewrite its own rootfs image or the pinned digest voids
  D3's "refuses to boot on digest mismatch" integrity check, which is the mechanism the whole
  update story rests on.
- No share whose resolved path escapes the granted root it was derived from (a grant that
  resolves outside its own workspace root is a policy error, not a wider share).
- No share added "for diagnostics" outside the granted set.

Symlink resolution is a compile-time check and therefore TOCTOU-adjacent: the test asserts the
rule, and the implementation resolves immediately before constructing the share rather than at
grant time.

**Re-pointing on grant change.** `VZVirtioFileSystemDevice.share` is `{ get set }` [APPLE], so
the mount set can change on a running VM without a reboot — the enabler for D2 under changing
grants. Two rules: changes apply **between** runs only (never widen a share with a run in
flight), and whether the guest observes the change without a remount is **unverified** and is an
implementation spike; if a remount is required, that is what `mount.sync` is for.

---

## Egress proxy policy

**The guest has no `VZVirtioNetworkDeviceConfiguration`.** No NAT attachment, no bridged
attachment (which would need the Apple-approved `com.apple.vm.networking` entitlement anyway),
no file-handle attachment. The guest's only network interface is loopback.

Consequences, in order of importance:

1. There is no route out to bypass. The claim is not about proxy configuration quality.
2. DNS does not resolve in the guest. **Name resolution happens host-side**, inside the proxy,
   where the allowlist lives — so the guest never chooses the IP it connects to.
3. Localhost services the user is running on the Mac are unreachable from the guest unless we
   deliberately proxy them, which we do not in v1.

**Guest side.** The guest daemon binds `127.0.0.1:3128` (HTTP `CONNECT`) and `127.0.0.1:1080`
(SOCKS5) and forwards each accepted connection over a fresh vsock stream on port 1025. Runs get
`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` in their environment.

**Both listeners enforce name-only targets.** SOCKS5 defines three address types, and only one
of them is safe here: `ATYP=0x03` (domain name) is proxied, while **`ATYP=0x01` (IPv4) and
`ATYP=0x04` (IPv6) are rejected outright**. An IP-literal target has no domain to match against
`allowedDomains`, so accepting one is a full egress bypass — consequence 2 above ("the guest
never chooses the IP") is only true once this rejection is stated. The 80/443 port restriction
applies to **both** listeners, not just `CONNECT`; SOCKS5 will otherwise happily carry an
arbitrary port and the two listeners end up enforcing different policies. An `ATYP` rejection is
a **deny run-event**, not a silent close — this is precisely the case that would otherwise read
to the model as a hang.

**The guest fence does not `--unshare-net`.** This is a deliberate, slightly counterintuitive
sub-decision: since the VM has no NIC, the entire machine's network surface *is* loopback, and
unsharing the net namespace would only cut the run off from the proxy while adding nothing.
Instead the fence unshares pid/ipc/uts/mount/cgroup, runs as a per-run unprivileged uid, and the
seccomp filter denies raw and packet sockets, denies `AF_VSOCK`, and denies namespace-creation
syscalls (the first link in the escape chain above).

**How bwrap gets its namespaces with unprivileged userns disabled** — the one place two of this
ADR's own rules would otherwise contradict each other. Risk 1 turns unprivileged user namespaces
off kernel-wide (correctly: they are the first link in the cited chain), but non-setuid
bubblewrap obtains pid/ipc/uts/mount/cgroup namespaces *through* an unprivileged user namespace
and simply fails to start without it. The resolution, stated so nobody resolves it the other way
by re-enabling userns:

- **`bwrap` ships setuid-root in the rootfs**, and unprivileged userns stays off kernel-wide.
  This is the trade being made, not an oversight: setuid `bwrap` is a local-privesc surface
  directly reachable by the payload and it has had CVEs. It is defensible here **only because
  D4 holds** — a guest-root compromise reaches the granted shares and nothing else, which is
  exactly the bound that Cowork's host-root share did not have. It is the sole setuid binary in
  the image (see "Contents", where `bwrap` is the one privileged entry).
- **The seccomp filter binds the payload, not the setup path.** It is installed after `bwrap`
  finishes unsharing and immediately before `execve` of the run process. Without that ordering,
  "denies namespace-creation syscalls" would kill the fence that is doing the unsharing. Writing
  the order down is what makes the profile testable, per risk 7.

**Host side.** The proxy enforces `ExecPolicy.allowedDomains` deny-first: exact host match, with
subdomain wildcards written explicitly rather than inferred, on 80/443 only. Every allow and
every **deny** is emitted into the existing run-event taxonomy — a blocked fetch must be visible
to the user and the model, never a silent hang.

Two further rules the name check alone does not give us:

**Reject non-public resolved addresses.** An allowlisted hostname that resolves to a loopback,
link-local, private (RFC1918/ULA), CGNAT, or cloud-metadata address makes host and LAN services
reachable *from the Mac* despite every name check passing — DNS rebinding turns an allowlisted
domain into a pivot onto the user's network. The proxy resolves host-side, **rejects any answer
outside public unicast space**, and connects to the exact address it validated (pin the resolved
address for the connection rather than re-resolving, so the check and the connect cannot
disagree). Anthropic's own hosted sandbox states the same property — the sandbox "can't reach
private, internal, link-local, or cloud-metadata addresses" [VENDOR] — and the local case needs
it more, not less, because the LAN on the other side is the user's own.

**Authorization is per run, not per VM.** Because D2 keeps the VM warm and the lifecycle section
explicitly acknowledges that guest **background processes** survive a run, a process spawned by
run A can still connect to the daemon's loopback listener after run A has exited — and the raw
stream carries nothing to say which run's allowlist should apply. So: the guest daemon attaches
the run's `egressToken` to the first frame of every vsock egress stream, and the host binds that
connection to the policy that minted the token. Three consequences, all deny-side:

- A stream bearing a **retired or unknown token is denied**, and the denial is a run-event on
  the run that owned the token (or a workspace-level event if none is live) — never a hang.
- **No live run ⇒ no live token ⇒ deny.** The "no active policy" default is deny, stated
  explicitly because the `allowedDomains: []` rule describes the *host* acceptor while the
  guest's 3128/1080 listeners are daemon-owned and outlive any single run.
- A run transitioning to `allowedDomains: []` (or simply ending) **revokes its token and kills
  surviving tunnels** via `egress.revoke`; an established connection does not outlive the policy
  that authorized it.

**Known limits, stated rather than papered over.** We do not intercept TLS, so allowlisting is
by requested host name. Domain fronting (SNI/Host mismatch) and CDN-shared IPs remain viable
exfiltration paths for a determined adversary, exactly as `@anthropic-ai/sandbox-runtime`
documents for its own proxy. And the general point from the 2026-07-25 report stands unchanged:
**a read set composed with any reachable egress domain is an exfiltration channel**, and package
registries are reachable by design. The VM does not fix this; the read allowlist (D4) is what
bounds it.

---

## Capability gating and how the mode appears in the UI

**Host capability.** Electron main asks the helper once at startup and caches two *separate*
things — a hardware/OS support verdict and a runtime-installed verdict — because collapsing them
into one boolean makes the UI below unbuildable:

```
vmSupported  ⇔ helper binary present in the bundle
             ∧ helper is signed with com.apple.security.virtualization  [APPLE: required to create a VM]
             ∧ VZVirtualMachine.isSupported                             [APPLE]
             ∧ host macOS ≥ 13.0                                        (the API floor, see below)

vmReady      ⇔ vmSupported ∧ a rootfs with the expected digest is present and signature-verified
```

Only when `vmReady` holds does main pass a `vm` factory into `CodeExecutorHostCapabilities`, so
**the presence of the factory remains the execution gate** exactly as the repo rule requires.

But factory-presence alone cannot drive the picker: "supported, rootfs not yet fetched" and
"this Mac cannot do it" both yield an absent factory, and the middle row of the table below needs
to tell them apart. The fix must be another *capability*, never a `process.platform` check in
shared code — so the bridge also exposes a status descriptor alongside the factory:

```
codeExecution.vmStatus: 'unsupported' | 'needs-runtime' | 'ready'
```

Shared UI reads `vmStatus`; execution reads the factory. The two are derived from the same
probe and cannot drift, and neither one asks what platform it is running on. The web build
exposes neither, rather than stubbing a permanent "no".

**On the OS floor.** `VZVirtualMachine.isSupported` is a hardware/host check, not an
API-availability check, so it is true on macOS 11 hosts where this design's devices do not
exist: `VZVirtioFileSystemDeviceConfiguration` (D4) is **macOS 12.0+** and
`VZLinuxRosettaDirectoryShare` is 13.0+ [APPLE]. The floor is therefore stated explicitly rather
than left implied — **macOS 13.0**, chosen over the strict 12.0 minimum so the whole device set
this ADR references is available on every supported host. Snapshot fast-start additionally wants
14.0 and is already optional (see lifecycle), so it does not raise the floor.

**UI**, with an honest three-state model:

| `vmStatus` | Host state | What the mode picker shows |
| --- | --- | --- |
| `'unsupported'` | Not macOS/Apple silicon, below the OS floor, or `isSupported` false | The `vm` option is **absent**. Not a disabled row with a tooltip pretending it might work. |
| `'needs-runtime'` | Supported, rootfs not yet fetched or failed verification | The option is present and offers to download the runtime, with its size. "Not installed yet" is a different fact from "cannot". A *failed* verification is an error state, not a silent re-offer. |
| `'ready'` | Factory present | Selectable; runs show a "full isolation" badge distinguishable from mode one's "fenced" badge. |

**Persisted mode on an unsupported host** throws `ExecutorKindUnavailableError` from the existing
seam and surfaces as a blocking, actionable error on the workspace. It never quietly becomes
`fence`. The user is told their workspace asked for isolation this machine cannot provide.

**Other platforms get fence-only.** Windows mode two would be Hyper-V — the same two-layer shape
that Anthropic describes for Cowork on Windows [VENDOR] — and is out of scope here. Linux hosts
already have bubblewrap available to mode one; a Linux mode two (KVM) is not planned.

---

## Alternatives rejected

**A. Shell out to Apple's `container` CLI.** Rejected. It requires macOS 26+ and a user-installed
CLI; it is VM-per-container, which fights warm reuse; and it puts the mount and egress model —
the substance of this ADR — behind a text interface we would parse. On survival: v1.0.0 shipped
June 2026 with strong star counts, but as of this writing neither Lima nor Podman has shipped an
Apple-container backend (both have open discussions/issues, not merged drivers). Star count is
not adoption. **Reopen if** a major downstream (Lima or Podman) ships it as a default backend
*and* macOS 26 becomes our floor.

**B. Embed `Containerization.framework` (the Swift library, not the CLI).** The strongest
rejected option, and materially different from A — it would solve the rootfs pipeline outright
via OCI image distribution, and its `vminitd` init gives sub-second boots. Rejected for v1
because: macOS 26+ floor is too high today; the ephemeral-container model fights D2; and the
network/mount surface is container-shaped, giving us less control than raw VZ over exactly the
two things (D4, D5) that justify mode two. **Reopen if** macOS 26 becomes our floor and
measurement shows per-run VMs are cheap enough to drop warm reuse.

**C. Require a user-installed container runtime (Docker / OrbStack / Podman).** This is the
OpenHands and Gemini CLI pattern: OpenHands runs the agent in a Docker container by design;
Gemini CLI's sandbox requires Docker or Podman to be installed and running. **Rejected outright
by D9** — it was considered as a way to avoid owning a rootfs, and that trade was explicitly
declined.

Why it loses, recorded so the reasoning survives rather than being relitigated:

- It fails the no-user-install bar. A multi-gigabyte third-party install is the exact friction
  mode two exists to avoid; "please install Docker Desktop first" is not a local-first product.
- Docker Desktop licensing is a live problem for commercial users, and a licence term we do not
  control sitting in the critical path of a security feature is not a dependency we want.
- The agent gets a copied/mounted world rather than the user's real one.
- On macOS you are paying for a VM regardless — someone else's, configured to someone else's
  defaults, which surrenders precisely the mount and egress control (D4, D5) that justifies mode
  two at all.
- It would weaken the isolation claim from hypervisor to container-on-a-vendor-VM, so "full
  isolation" would stop being an honest label.

Recording what would have been lost is also what makes D9 concrete: on this path the rootfs
pipeline, the vsock control channel, and the "no NIC" guarantee all disappear, replaced by the
runtime's exec streams and a network mode we configure but do not own. The parts of this ADR
that are runtime-independent — the `ExecPolicy` mapping and its lossiness rulings, the host
egress proxy, the guest fence, the capability gating — are the parts worth keeping, and they are
kept by D1 anyway.

**D. Vendor Tart.** Tart is a mature Virtualization.framework wrapper with a guest agent and a
gRPC-over-vsock exec path — an excellent *reference implementation* for D3 and the control
channel. Rejected as a dependency: it is CI-fleet-oriented (OCI registry image distribution,
orchestration), heavier than we need, and its Fair Source licence (subject of a 2025 enforcement
settlement) is a poor fit for embedding in a shipped desktop app. We read it; we do not link it.

**E. A hosted microVM tier** (E2B, Vercel Sandbox, Daytona, Modal, Firecracker on our own
infra). Already rejected in the 2026-07-25 report and not reopened: it sends the user's code and
files to someone else's cloud, against the local-first wedge. At most a future, explicit,
opt-in remote tier — never mode two.

---

## Open risks

1. **Rootfs maintenance burden — the top risk.** We become, in a small way, a distro maintainer:
   kernel pin, CVE tracking, image rebuilds, digest rollout. The escape chain cited above began
   with an unprivileged user namespace and a kernel-module autoload [INFERENCE]; both are our
   boot-args and our seccomp policy to get right. Mitigations: minimal image, unprivileged
   userns off, module autoload off, per-release digest refresh, named owner. **This burden was
   accepted knowingly on 2026-08-01 (D9); the escape hatch of gating on someone else's container
   runtime is closed.** The risk therefore converts from a decision into a standing obligation: a
   rootfs whose kernel pin has gone stale is a shipped vulnerability, and D3's digest-mismatch
   refusal must never be softened into a warning. The CVE watch covers **setuid `bwrap`** as well
   as the kernel — it is the image's one privileged binary and is directly reachable by the
   payload (the trade is argued in the egress section).

2. **Warm-VM memory reclamation is advisory, not enforceable.** [APPLE]
   `VZVirtioTraditionalMemoryBalloonDevice.targetVirtualMachineMemorySize` asks the guest to
   return pages; Apple states that if the guest does not comply, "the physical memory size
   remains unchanged." The value must be a multiple of 1 MB and **cannot exceed the configured
   `memorySize`**, whose initial value it takes — so the ceiling is fixed at boot and ballooning
   only ever claws back downward, at the guest's discretion. Consequence: N warm VMs cost N
   ceilings in the worst case. **Settled by D2**: per-workspace VMs (stronger isolation) rather
   than one VM with per-workspace guest sessions (what Cowork appears to do [INFERENCE] —
   cheaper, but two workspaces then share a kernel), with the memory consequence bounded by the
   one-warm-VM cap and LRU eviction rather than by trusting the balloon. What remains open is
   only the *tuning*: the memory ceiling per VM and the idle timeout, both of which need
   measurement against real workspaces before defaults are fixed.

3. **Signing and entitlement mechanics.** [APPLE] Creating a VM requires
   `com.apple.security.virtualization` (macOS 11.0+, a plain boolean, no Apple approval process
   — unlike `com.apple.vm.networking` for bridged networking, which we avoid by design). The
   open work: the entitlement must be on the **helper** that creates the `VZVirtualMachine`, and
   how it composes with Electron's hardened runtime, helper-binary signing, and notarization in
   our packaging pipeline is a spike, not a known quantity. A signing regression here is a
   silent loss of mode two for every user; the capability probe must therefore be a real runtime
   check, not a build-time assumption.

4. **Save/restore may not apply to our configuration.** [APPLE] `validateSaveRestoreSupport()`
   exists precisely because some configurations are unsavable, and ours carries VirtioFS shares
   and a vsock device. Unverified. Snapshot fast-start is designed as optional for this reason.

5. **Rosetta longevity.** [APPLE] `VZLinuxRosettaDirectoryShare` is macOS 13.0+, with an
   availability check, an `installRosetta` path, and AOT caching options. But Apple stated at
   WWDC 2025 that Rosetta ships as a general-purpose tool through macOS 27, after which a reduced
   subset remains (widely reported as effective removal in macOS 28, fall 2027). Apple has not
   explicitly addressed Rosetta-for-Linux's status under that statement. **Ruling: running x86-64
   binaries in the guest is a non-goal for v1.** Do not build a feature on a countdown.

6. **VirtioFS performance on large repos**, and the UID/`chown` semantic gap [APPLE], will both
   surface as "my build behaves differently in mode two." Needs measurement and honest docs, not
   a compatibility shim.

7. **Guest-fence bugs are policy bugs.** Because `denyRead` and file-granularity live only in the
   guest bind set, the guest fence needs the same test rigor as a permission engine, including
   negative tests that a denied path is actually absent from the mount namespace.

8. **Nested virtualization** is macOS 15.0+ and **M3 and later** [APPLE]. Anything wanting a VM
   (not a container) inside the guest is M3+ only. Non-goal for v1.

---

## Consequences

- A new signed helper (Swift, linking Virtualization.framework) enters the desktop build,
  packaging, and notarization pipeline. Our existing native-addon convention
  (`@brainstrike/secure-fs-native`, node-gyp + node-addon-api) is **not** the right shape here: a
  crash in a VM-owning addon would take down Electron main, and the entitlement wants to sit on a
  separate binary. A helper **process** with a private IPC is the recommendation.
- New device-local persistence (VM bundle, rootfs, snapshots) must be registered with factory
  reset, and explicitly excluded from any future sync set (BST-911).
- `docs/agents/code-execution.md` gains the `vm` backend contract **when it lands**, not now.
- The seam is unchanged. Nothing in this ADR requires editing
  `packages/agent/src/code-execution.ts`.

**Suggested epic split** (one ticket per section, in dependency order):

1. Helper process skeleton: boot a pinned rootfs, entitlement + signing + notarization through
   the packaging pipeline, the `vmSupported` probe (`isSupported` **plus** the macOS 13.0 floor),
   teardown-on-parent-death.
2. Rootfs build pipeline in CI: recipe, digest, signed manifest, fetch-and-verify-on-first-enable,
   setuid-root `bwrap` as the image's only privileged binary, factory-reset wiring.
3. vsock control channel + guest daemon: message shapes above, `egressToken` minting/revocation,
   the built-from-scratch `env` rule, protocol version pinning, health and lifecycle state
   machine, and the never-bind-control-on-loopback invariant.
4. Policy compiler: `ExecInput` → shares + `FenceSpec`, with the realpath-based
   directory-vs-file resolution rule, `PolicyNotRepresentableError`, and the forbidden-share
   tests (including the app-data-directory subtree and the symlink-escape cases).
5. Guest fence: bubblewrap bind set, seccomp profile (namespaces, raw sockets, `AF_VSOCK`)
   installed post-setup/pre-`execve`, per-run uid, `session.reset`.
6. Egress proxy: host-side allowlist + resolver with non-public-address rejection and pinned
   connect address, `ATYP` 0x01/0x04 rejection on the SOCKS5 listener, per-run token binding and
   revocation, run-event emission for allow/deny.
7. Capability plumbing + UI: the `vm` factory, the `vmStatus` descriptor, the three-state mode
   picker, the isolation badge, the unavailable-mode error surface.
8. Optional: snapshot fast-start, gated on `validateSaveRestoreSupport()`.

---

## Resolved on acceptance (2026-08-01)

Four questions were held open in the proposed draft. All four were decided by Sean Dearnaley on
acceptance, and all four went the canonical route. They are recorded here so that reopening one
is visibly a re-decision rather than a fresh question.

| Question | Ruling | Folded into |
| --- | --- | --- |
| Isolation granularity vs memory: per-workspace VM, or one VM with per-workspace guest sessions? | **Per-workspace VM**, cap one warm VM, LRU evict on the idle timer. Two workspaces never share a guest kernel. | D2, risk 2 |
| Do we accept owning the rootfs/kernel pipeline, or gate on a user-installed container runtime? | **We own it.** Docker/OrbStack/Podman gating is rejected as a v1 path: *no other stuff like Docker is acceptable; follow canonical and modern idioms for 2026 — whatever folks like Claude Code, OpenCode, and oh-my-codex do.* | D3, D9, Alternative C, risk 1 |
| Is macOS-only acceptable for the first release? | **Yes** — ship one platform first rather than waiting for parity. | D8 |
| Rootfs distribution: fetch-on-first-enable, or ship in the app bundle? | **Fetch-on-first-enable** with digest + signature verification, as the canonical pattern. | D3, "Rootfs build / update pipeline" |

Two items flagged in the draft remain genuinely open, and they stay open because they are
**implementation spikes, not decisions**:

- Whether a configuration carrying VirtioFS shares and a vsock device passes
  `validateSaveRestoreSupport()` [APPLE]. Snapshot fast-start is designed as optional for exactly
  this reason.
- Whether re-pointing `VZVirtioFileSystemDevice.share` (which is `{ get set }` [APPLE]) is
  observed by the guest without a remount, or whether `mount.sync` must drive one.

---

## What would make us revise this decision

- Apple deprecating or materially restricting Virtualization.framework for Developer ID apps.
- macOS 26 becoming our supported floor **and** Lima/Podman shipping Apple-container backends —
  reopens A and especially B.
- Measurement showing warm-VM memory cost is unacceptable in real multi-workspace use and that
  ballooning cannot recover it — reopens D2's granularity ruling (toward one shared VM with guest
  sessions), not D9.
- A demand that mode two exist on Windows and Linux at parity. The answer is a Hyper-V sibling
  (and, if ever needed, a KVM one) written as its own ADR — **not** a retreat to a user-installed
  container runtime. D9 does not bend for platform coverage; if a platform cannot be served
  honestly, it stays fence-only.
