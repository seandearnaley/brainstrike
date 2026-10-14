# Platform, logging and reset

## IPC and packaging

Sensitive invokes authorize both the server-owned window role and sender frame
against the single configured renderer target before parsing arguments. Preload
possession is not authority; unknown roles/frames fail closed. Hidden roles receive
only their manifest capabilities. Shared IPC contracts and preload value imports
remain pure; Node/runtime validation belongs on the main side. Bundles expose only
the declared capability graph, not arbitrary bridges.

Native modules, utility entries, Python/CLI helpers and runtime assets are
resolved from the actual packaged layout. Missing or incompatible assets refuse;
a development path or system installation is not a packaged fallback.

## Reset and physical lifetime

Clear Database deletes canonical content, root grants and derived indexes while
retaining configuration/credentials. Factory Reset also clears configuration,
secrets and persistent UI state. Both use the existing admission/retirement owner:
join renderer saves and retire persisted chat/tab references before host deletion
and replacement. New durable state participates in reset. Live in-memory stores
must also return to defaults; deleting storage alone is insufficient.

Before destructive profile work, fence new admission, join writers, readers,
inference, subscriptions and pending acquisition, then hold the profile reset
lease through the entire purge. Preserve its live lock namespace and Chromium
Session container until their own cleanup APIs finish. Failed cleanup remains an
incomplete reset with retained ownership, not a successful restart. Windows
Factory Reset remains explicitly unavailable; do not imply platform acceptance.

User-confirmed reset is the destructive recovery boundary. Corruption never
silently deletes, replaces, repairs or reloads canonical data. Preserve typed
integrity failures and diagnostic access; read-only containment is not health.

## Logging and background owners

Use the shared logger and bounded structured diagnostics. Redact secrets and
sensitive content while preserving correlated causes, aggregate failures and
safe actionable errors. Telemetry is an observation, never authority or a second
persistent fact. Adding a diagnostic store adds a reset obligation.

Long-lived watchers, command sessions, hidden hosts and background tasks own
explicit lifetimes. Fence admission synchronously, join late and active resources,
attempt independent cleanup and report every failure. A timeout, cancellation
notice, closed transport or deleted row does not prove physical work stopped.
Stale callbacks cannot affect replacement generations. Debug sessions use
isolated disposable profiles and own their whole spawned process tree.

Decision: [ADR-0015](../adr/0015-desktop-platform-ipc-reset-diagnostics.md).
Implementation: desktop platform/IPC/reset owners and `packages/app-state`.
