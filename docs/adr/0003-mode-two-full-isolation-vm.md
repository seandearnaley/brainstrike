# ADR-0003: Mode two ("full isolation") — embed Virtualization.framework directly

- **Status:** Accepted (2026-08-01, decided by Sean Dearnaley). Design only; no `vm` backend
  exists in code yet.
- **Ticket:** BST-1069
- **Builds on:** the `CodeExecutor` seam (BST-1060) in `packages/agent/src/code-execution.ts`,
  contract in `docs/agents/code-execution.md`. This ADR designs the `vm` backend and changes
  nothing about the seam.
- **Evidence labels:**
  - **[APPLE]** verified against Apple's Virtualization docs on 2026-08-01.
  - **[VENDOR]** Anthropic's published Cowork architecture overview.
  - **[INFERENCE]** third-party teardowns; never load-bearing for a security claim.

## Context

The seam has two modes that must not blur.

- **`fence`** (mode one, BST-1062): bundled CPython inside an `@anthropic-ai/sandbox-runtime`
  OS fence (Seatbelt / bubblewrap). Shares the host kernel; any profile bypass is total.
- **`vm`** (mode two): a boundary whose failure mode is a hypervisor CVE.
  - `resolveCodeExecutor` throws rather than downgrading `vm` → `fence`.
- House constraints:
  - Local-first: no hosted microVM tier (E2B, Vercel, Daytona, Modal).
  - No user-visible install step (no Docker/OrbStack/Podman).
  - Capability-based gating; no `process.platform` checks in shared code.
  - No silent fallbacks.
  - VM bundles, rootfs and snapshots are device-local: never synced (BST-911), always covered by
    factory reset.

## Decision

- **D1. Embed Virtualization.framework** in a small signed helper process owned by Electron
  main. No third-party CLI, no user-installed runtime.
- **D2. One warm VM per workspace root.**
  - Booted lazily on first `execute()`, reused across runs, torn down on idle / workspace close /
    app quit.
  - Workspaces never share a guest kernel.
  - Default cap of one warm VM, LRU eviction. Raising the cap is a measured decision.
- **D3. A pinned, minimal ARM64 Linux rootfs we build and own.**
  - Content-addressed; fetched and verified (digest + signed manifest) on first enable, not
    shipped in the bundle.
  - Direct kernel boot (`VZLinuxBootLoader`), not EFI.
  - A digest mismatch refuses to boot.
- **D4. VirtioFS exposes granted folders only.** Never `/`, `$HOME`, a volume root, or any
  ancestor or descendant of the app's data directory.
- **D5. No guest network device.** Egress goes through a deny-first host proxy over vsock.
- **D6. A second fence inside the guest:** bubblewrap + seccomp + per-run unprivileged uid. It
  carries policy fidelity, not just defence in depth.
- **D7. `vm` is a host capability.** The factory exists only when the helper is present and
  entitled, `VZVirtualMachine.isSupported` is true, and a verified rootfs is on disk. Otherwise
  the seam's `ExecutorKindUnavailableError` fires.
- **D8. macOS on Apple silicon only for v1.** Other platforms are fence-only; Windows/Hyper-V
  would be a separate ADR.
- **D9. No dependency on a user-installed container runtime, ever.** Not deferred, not a descope
  valve.

## Why direct-embed

- The deciding factor is control of mounts and egress (D4, D5), not performance. Every
  CLI/container option makes those choices for us.
- Options compared:
  - **Direct-embed VZ:** no install; we own rootfs/kernel/daemon; full control; warm reuse
    native; macOS 13+ floor.
  - **Apple `container` CLI:** user install, macOS 26+, VM-per-container, text interface.
  - **`Containerization.framework`:** no install but macOS 26+, ephemeral-container model,
    container-shaped networking.
  - **Docker/OrbStack/Podman:** heavy install, possible licence cost, vendor-owned mounts and
    networking. Its only advantage is cross-platform.

## Seam integration

- The backend is a `CodeExecutorFactory` passed as `CodeExecutorHostCapabilities.vm`.
- `capabilities()`: `languages: ['python', 'javascript', 'bash']`, `maxIsolationTier: 'vm'`,
  `platform: 'darwin'`, `supportsNetwork: true`.
  - `supportsNetwork` describes the backend. `allowedDomains: []` still means no egress.
- `ExecInput` → VM mapping (`scratchDir` and `timeoutMs` are `ExecInput` fields, not
  `ExecPolicy`):
  - `allowWrite` → `bs-rw` share. A file entry widens to its parent at VirtioFS; the guest fence
    narrows it back.
  - `allowRead` → read-only `bs-ro` share; same file-entry widening.
  - `denyRead` → not expressible in VirtioFS; enforced only by the guest fence's bind set.
  - `allowedDomains` → host proxy allowlist; `[]` registers no acceptor.
  - `scratchDir` → `bs-scratch`, owned by the run uid.
  - `timeoutMs` → enforced by the guest daemon and, authoritatively, by the host RPC deadline.
- Compiler rules:
  - `realpath` every entry and branch on directory vs file. A nonexistent path throws.
  - `undefined` and `[]` stay distinct for `allowRead` / `denyRead`.
  - Anything unrepresentable throws `PolicyNotRepresentableError`; never round up to a wider
    share.
  - The guest fence is load-bearing for file granularity and `denyRead`; it cannot be dropped.
- Shared-file ownership [APPLE]: I/O runs as the host user and guest `chown` is ignored. Tool
  docs must say so.

## Host ↔ guest control channel

- Transport: `VZVirtioSocketDevice` (vsock). Only the helper owning the VM can reach the guest.
  - Port `1024` host → guest: control RPC.
  - Port `1025` guest → host: one stream per proxied TCP connection; first frame carries the
    run's egress token.
- The guest seccomp filter denies `socket(AF_VSOCK, …)` to run processes.
- The guest daemon never binds control RPC on loopback.
- Protocol: newline-delimited JSON, correlated by `id`, streamed by `runId`.
  - `hello` / `ready`, `exec.start` / `started` / `output` / `exit` / `kill`, `egress.revoke`,
    `mount.sync`, `health.ping` / `pong`, `session.reset`.
  - `protocolVersion` is pinned to the rootfs digest; a mismatch stops the VM.
- Run `env` is built from scratch (`PATH`, `HOME`, proxy vars, run additions). Never inherit
  `process.env`, which holds provider keys.
- Lifecycle: `cold → booting → ready ⇄ busy → stopping → stopped`, with `poisoned` on failure.
  - Runs are serialized per VM.
  - Snapshot fast-start (macOS 14+) is optional and gated on `validateSaveRestoreSupport()`.
  - A missed pong, protocol mismatch or daemon exit poisons the VM. It never silently recovers;
    a fresh boot happens only between runs and is surfaced in the event stream.
  - The helper stops the VM if Electron main dies. This needs a test.

## Rootfs pipeline

- Contents: static guest daemon, setuid-root `bwrap` (the only privileged binary),
  linux-aarch64 CPython matching mode one's pin, Node, minimal tools. No sshd, package manager or
  systemd.
- Built in CI from a checked-in recipe; one pinned digest per app release.
- Stored under Application Support and wired into factory reset.
- A guest kernel or `bwrap` CVE is our patch obligation and needs a named owner and CVE watch.

## Folder-mount scoping

- Shares: `bs-ro` (read-only at the host [APPLE]), `bs-rw`, `bs-scratch`. `bs-rosetta` is
  reserved and not created.
- Host-side read-only means guest root cannot write through it.
- Why D4: Cowork's local mode reportedly shared the whole host filesystem behind guest root, and
  a July 2026 escape chain reached it [INFERENCE]. A share that exists is a share one kernel bug
  reaches.
- Forbidden shares (tested, evaluated on the resolved path):
  - `/`, `$HOME`, volume roots.
  - Any ancestor or descendant of the app's data directory (databases, stored keys, the VM bundle
    and rootfs).
  - Any share resolving outside the granted root it came from.
  - Diagnostic shares outside the granted set.
- Resolve immediately before building a share to narrow the TOCTOU window.
- Share sets can change on a running VM [APPLE], but only between runs. Whether the guest needs a
  remount is an open spike (`mount.sync` covers it).

## Egress proxy

- The guest has no `VZVirtioNetworkDeviceConfiguration`; loopback is its only interface.
  - DNS resolves host-side, inside the proxy.
  - Mac localhost services are unreachable.
- Guest daemon listens on `127.0.0.1:3128` (HTTP CONNECT) and `127.0.0.1:1080` (SOCKS5) and
  forwards over vsock.
  - Name-only targets: SOCKS5 IPv4/IPv6 address types are rejected as deny events.
  - Ports 80/443 only, on both listeners.
- The guest fence does not unshare the network namespace (it would cut off the proxy). It
  unshares pid/ipc/uts/mount/cgroup and seccomp denies raw/packet sockets, `AF_VSOCK` and
  namespace creation.
- Unprivileged user namespaces stay off kernel-wide, so `bwrap` ships setuid-root.
  - Defensible only because D4 bounds what guest root can reach.
  - Seccomp is installed after `bwrap` setup, immediately before `execve`.
- Host side:
  - Deny-first exact host match, explicit wildcards, 80/443.
  - Every allow and deny is a run event; a blocked fetch never looks like a hang.
  - Reject resolved addresses outside public unicast (loopback, private, link-local, CGNAT,
    metadata) and connect to the pinned validated address.
  - Authorization is per run: unknown or retired tokens are denied; no live run means deny;
    ending a run or dropping to `allowedDomains: []` revokes its token and kills tunnels.
- Known limits: no TLS interception, so domain fronting and shared CDN IPs remain exfiltration
  paths. The read allowlist bounds what can leak.

## Capability gating and UI

- `vmSupported` = helper present ∧ signed with `com.apple.security.virtualization` ∧
  `VZVirtualMachine.isSupported` ∧ macOS ≥ 13.0.
  - 13.0 is chosen so every referenced device exists (VirtioFS is 12.0+).
- `vmReady` = `vmSupported` ∧ verified rootfs present. Only then does main pass a `vm` factory.
- The bridge also exposes `codeExecution.vmStatus: 'unsupported' | 'needs-runtime' | 'ready'` so
  the UI can tell "can't" from "not installed".
  - `unsupported`: option absent.
  - `needs-runtime`: offer the download with its size; a failed verification is an error state.
  - `ready`: selectable, with a "full isolation" badge distinct from "fenced".
- A persisted `vm` workspace on an unsupported host surfaces `ExecutorKindUnavailableError` as a
  blocking error; it never becomes `fence`.

## Alternatives rejected

- **A. Apple `container` CLI.** macOS 26+, user install, VM-per-container. Reopen if Lima or
  Podman ship it as a default backend and macOS 26 is our floor.
- **B. `Containerization.framework`.** Strongest alternative (OCI distribution, fast boots) but
  macOS 26+, ephemeral model, less mount/network control. Reopen under the same floor change if
  per-run VMs prove cheap.
- **C. User-installed Docker/OrbStack/Podman.** Rejected by D9: install friction, licensing,
  vendor-owned mounts and networking, and a weaker isolation claim.
- **D. Vendor Tart.** Good reference, but CI-fleet oriented and Fair Source licensed.
- **E. Hosted microVMs.** Sends user code off-device.

## Open risks

1. Rootfs/kernel maintenance is a standing obligation; a stale pin is a shipped vulnerability.
2. Memory ballooning is advisory [APPLE]; memory is bounded by the one-VM cap. Per-VM memory and
   idle timeout need measurement.
3. Entitlement, hardened runtime and notarization for the helper are unproven; the capability
   probe must be a runtime check.
4. Save/restore may not support VirtioFS + vsock configurations.
5. Rosetta for Linux has an uncertain future; x86-64 in the guest is a non-goal.
6. VirtioFS performance and the `chown` gap need measurement and honest docs.
7. Guest-fence bugs are policy bugs; test it like a permission engine, including negative tests.
8. Nested virtualization (macOS 15+, M3+) is a non-goal.

## Consequences

- A new signed Swift helper process enters build, packaging and notarization. A native addon is
  the wrong shape: a crash would take down Electron main.
- New device-local persistence must join factory reset and stay out of any sync set.
- `docs/agents/code-execution.md` gains the `vm` contract when it lands.
- Suggested epic order:
  1. Helper skeleton, signing, `vmSupported` probe, teardown on parent death.
  2. Rootfs CI pipeline, signed manifest, fetch-and-verify, factory reset.
  3. vsock channel and guest daemon.
  4. Policy compiler and forbidden-share tests.
  5. Guest fence.
  6. Egress proxy.
  7. Capability plumbing and UI.
  8. Optional snapshot fast-start.

## Resolved on acceptance

- Per-workspace VM, one warm VM cap, LRU eviction (D2).
- We own the rootfs/kernel pipeline; container-runtime gating rejected (D3, D9).
- macOS-only first release is acceptable (D8).
- Fetch rootfs on first enable with digest + signature verification (D3).
- Still open as implementation spikes: save/restore support for our configuration, and whether
  share re-pointing needs a guest remount.

## Revisit if

- Apple restricts Virtualization.framework for Developer ID apps.
- macOS 26 becomes the floor and Lima/Podman ship Apple-container backends (reopens A, B).
- Warm-VM memory proves unacceptable (reopens D2 granularity, not D9).
- Windows/Linux parity is demanded: answer with a Hyper-V/KVM sibling ADR, never a container
  runtime.
