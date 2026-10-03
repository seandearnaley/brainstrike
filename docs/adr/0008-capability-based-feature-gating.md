# ADR-0008: Features are gated by injected capabilities, never by platform checks

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

One codebase ships a desktop app and a lighter web app, and the CLI-first host
(ADR-0017) adds an Electron-free Node runtime. The contracts already gate on presence:
`resolveCodeExecutor` decides by factory presence, never `isElectron()` or platform
sniffing, and ADR-0003 lists capability gating as a house constraint. The platform
contract records why a platform flag is the wrong question: "Electron renderer with no
capability" and "web with no bridge" are different states, and a store reached from
more than one window role fails visibly when its capability is absent.

## Decision

A feature exists only where the host injects its capability: a bridge, a factory or an
adapter. Shared code never branches on `isElectron()`, `process.platform` or any other
platform sniffing. Web omits a desktop-only capability rather than stubbing it, and an
absent capability is never replaced by a fallback.

## Consequences

- The CLI host receives its platform services the same way, through `HostPlatform`
  adapters (ADR-0017).
- Presence is not proof of quality. Code execution also checks the advertised
  isolation tier and throws `ExecutorTierMismatchError` on a mismatch (ADR-0003).
- Platform-specific behaviour lives inside the adapter that provides the capability,
  not in its callers.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `AGENTS.md:40`, the cross-cutting invariant on capability-based gating.
- `docs/agents/code-execution.md:96-97` (`resolveCodeExecutor` gates on factory
  presence).
