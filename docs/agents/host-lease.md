# Host lease

Read this before changing `packages/host-lease`. This package owns shared local
host discovery, authenticated attachment, launcher seams and host lifetime.

### Single owner

- Acquire the state-store `RootLock` before listening or publishing discovery.
  Use its canonical root and PID/start identity; do not introduce another lock.
- Refuse foreign-host leases, synced roots and unverifiable process identities.
  A live owner with an unavailable endpoint remains the owner; name its PID in
  the error, preserve the cause and never terminate or replace that owner.
- Treat a gone PID or changed start identity as stale. Windows start identity
  comes from the state-store's canonical process creation FILETIME source.
- Keep state-store, desktop and CLI consumer wiring outside this foundation.
  A future host/store composition must retain one authoritative root lease.

Evidence: `host-lease/foundation.md`.
Guard: `packages/host-lease/__tests__/refusal.integration.test.ts` and
`process.integration.test.ts`.

### Private discovery

- Publish `host.json` by flushing an exclusive private temporary file and
  atomically renaming it. Include exactly PID, start, endpoint, 32-byte random
  token, protocol version and host version. Strictly decode records and frames.
- Require a current-user directory with mode 0700 and a regular non-symlink
  record with mode 0600 on POSIX. Flush the directory after rename there.
- On Windows, set and verify a protected DACL granting only the current owner
  full control. Reject ACL setup or verification failures; POSIX mode bits do
  not establish Windows privacy. Flush the file before rename; Node cannot
  perform the POSIX directory flush on Windows.
- Remove only a record whose token still matches the closing owner. Join all
  cleanup, including rollback after an error following publication.

Evidence: `host-lease/foundation.md`.
Guard: `runtime.integration.test.ts`, `record.test.ts` and
`windows-acl.test.ts` in `packages/host-lease/__tests__/`.

### Attachment and launch

- Use local Unix sockets or Windows named pipes. Require exactly one successful
  `initialize(token, protocolVersion, hostVersion)` before one attachment;
  compare the decoded 32-byte token with `timingSafeEqual`.
- Expose only initialize/attach in this layer. Do not add agent-run methods or
  platform capability methods here.
- Attach to the same root owner regardless of CLI/app start order. Resolve
  only a proved `RootLockedError` startup race by attaching to its winning lease.
- Bound launch and attachment with cancellation. Injected spawn adapters must
  honor their `AbortSignal`; Electron utilityProcess adapters use this seam
  without importing Electron into this package.
- Keep socket, timer, IPC channel, listener and root lease finalizers owned by
  Effect scopes. Preserve cleanup failures and expose peer closure to clients.

Evidence: `host-lease/foundation.md`.
Guard: `launcher.integration.test.ts`, `start-orders.integration.test.ts`,
`handshake.integration.test.ts` and `resource-owner.test.ts`.

### Lifetime

- Close an app host when its parent PID/start identity disappears or changes,
  including when CLI clients remain attached.
- Close an ordinary CLI host after the last client leaves and active in-process
  run leases reach zero. Explicit persistent start remains alive without clients.
- Close nonpersistent hosts that receive no attachment within startup grace.
  Release all owned resources before reporting termination.

Evidence: `host-lease/foundation.md`.
Guard: `runtime.integration.test.ts`, `process.integration.test.ts` and
`start-orders.integration.test.ts`.

### Desktop acquisition

- Pass the main-owned resolved profile directory to the desktop lease manager;
  acquire after app-ready. Keep Electron imports inside the desktop adapter.
- Own only utility handles this manager forks. Close existing host attachments
  without signalling their owner; refuse a live unavailable owner.
- Register exit and startup listeners before awaiting resource registration.
  Scope-own attachment cleanup and cooperative child close; join observed exit.
  Preserve failed cleanup on repeated close and forbid new acquisition afterward.
- Accept only strict parent-channel close control. Exit the utility after joined
  host cleanup; its Electron parent channel otherwise keeps the process alive.
- Before destructive reset, join every owned profile writer and acquire
  `acquireProfileResetLease(root)`. A live external CLI owner refuses acquisition;
  detaching its client does not release ownership.
- Keep that accessible guard through profile contents, userData and storage purge.
  Preserve the existing profile `lock` namespace and its ancestor paths; never
  recursively delete the active profile or remove its lock namespace afterward.
  Clearing removes other entries but does not release. Release only after the
  whole destructive phase succeeds; errors retain ownership for retry/policy.
  Release while clearing and clear after release both refuse.
- Retain the released generation as coordination residue, containing ownership
  metadata rather than application data. The next legitimate acquisition prunes
  older generations. No new persistent namespace is introduced.

Evidence: `host-lease/desktop-consumer.md`.
Guard: `apps/desktop/src/__tests__/main/host-lease-manager.test.ts`,
`host-lease-control.test.ts` and `host-lease-electron.integration.test.ts`.

The desktop acquisition adapter's production utility entry is
`dist/host-lease-entry.js`, emitted through the canonical main build table and
checked by its runtime-entry contract. Desktop directly depends on host-lease
and state-store; the entry and manager participate in the main TypeScript
program. Consumer startup/reset wiring and packaged lifetime acceptance remain
separate until the composed application demonstrates them.
