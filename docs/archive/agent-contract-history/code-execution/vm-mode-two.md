# Mode two: the settled VM design — evidence

Supports `docs/agents/code-execution.md` § "VM executor". Read this together
with `docs/adr/0003-mode-two-full-isolation-vm.md` before designing against a
VM backend. The contract holds the rules; this file is the record of the shape
that was accepted.

Design settled in ADR-0003 (BST-1069) —
`docs/adr/0003-mode-two-full-isolation-vm.md`, **Accepted 2026-08-01**. Embeds
Virtualization.framework directly in a signed helper process, macOS/Apple
silicon first; one warm VM per workspace (cap 1, LRU evict), a rootfs we own
and fetch-verify on first enable, granted-folder VirtioFS shares only (never
`/` or `$HOME`), no guest NIC at all (egress via a host-side deny-first proxy
over vsock), plus a bubblewrap+seccomp fence inside the guest that is
load-bearing for policy fidelity, not just defense in depth. Gating mode two on
a user-installed Docker/OrbStack/Podman is **rejected** (ADR-0003 D9) — do not
propose it as a shortcut. Still no implementation: do not design other code
against a VM backend existing.

When changing this flow, update this doc and the paired spec in the same
change.
