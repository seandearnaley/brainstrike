# Shared host lease foundation

Supports the single-owner, private discovery, attachment and lifetime rules in
`../host-lease.md`.

## Scope and authority — 2026-10-02

The live BST-1941 description and comments were read using UUID
`29e78031-34d8-472d-88cf-fb383b424687`; the UUID comment result was empty.
The coordinator's latest BST-1920 plan places this host lease in M2 Wave 2.
Historical spike plans do not override those live contracts. This package is
naturally layered on the completed unwired state-store/root-lock stack at
`fc50968885854f56c53474096f2342f4acffbf8a`.

`launchHost(root, { lifetime, spawn })` attaches or starts one owner.
`createNodeHostSpawner()` supplies the plain Node implementation. The injected
spawn seam receives strictly decoded start options and an AbortSignal, so an
Electron utilityProcess adapter can supply its own process transport. `startHost`
and the startup-message decoder are exported for that adapter. The package
imports no Electron. Protocol v1 exposes only initialize/attach. The local
`retainRun()` lease tests future lifetime ownership without adding an M3 wire
protocol. Desktop/CLI consumers and production chat are not wired by this change.

The root lock is authoritative; discovery metadata is replaceable only after
the root lease is stale. A PID that is alive but has a different creation identity
is stale. An unverifiable process lookup fails rather than guessing. A foreign
host's lock bytes remain unchanged. No launcher path kills an existing owner.

## RED/GREEN record

- Strict record decoding initially failed shape/token negative controls.
- Resource finalizer tests initially lacked joined cleanup and cause preservation.
- Real Node child tests initially lacked the process launcher and lifetime entry.
- The post-rename fault test exposed a published record left behind on failed
  startup. Registering record cleanup before publication fixes the leak while
  retaining the original failure. The final fault injection fails acknowledgement
  after the real rename, making the control platform independent.
- Windows ACL controls initially accepted inherited, foreign and broad grants
  and did not pass the literal path to the runner. Strict decoding and verification
  now reject these states; OS command failures keep their original cause.

Tests cover both real process start orders, eight concurrent real starters,
same PID/token attachment, real SIGKILL stale takeover, app-parent death with a
CLI client still attached, ordinary CLI idle exit, explicit persistent lifetime,
active-run retention, peer closure, authentication and version rejection, malformed
or oversized frames, synced-root refusal and refusal of live unreachable owners.

An early real-process teardown removed the test root before its persistent child
finished cleanup. The harness now records PID/start identities and waits for each
owned child before removing roots. This was a harness ordering failure, not an
assertion change or suppressed production failure.

## Windows privacy

Node documents that Windows chmod changes only write permission and cannot set
owner/group access distinctions. POSIX modes therefore cannot satisfy the private
discovery contract there. [Node fs.chmod](https://nodejs.org/api/fs.html#fschmodpath-mode-callback).

The static PowerShell command uses current Windows identity, an owner check,
protected DACL, and one current-user FullControl rule. Directory rules inherit
to children; the flushed temporary record receives its own protected file DACL
before any token bytes are written. Every result is strictly decoded and checked.
Paths travel only through environment variables and `-LiteralPath`, never command
source. There is no alternate privacy implementation if this fails.
[Microsoft access rule protection](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.objectsecurity.setaccessruleprotection?view=netframework-4.8.1),
[file access rule constructor](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemaccessrule.-ctor?view=netframework-4.8.1),
[Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-7.6).

The Windows DACL command, named-pipe behavior and FILETIME process identity have
not run on a real Windows host in this task. Decoder mocks are not OS proof.

## Local validation

Mac arm64: macOS 27.0.1 (26A434), Node 26.8.2 through pnpm, pnpm 11.15.0,
Effect 4.0.0-rc.118 and Vitest 5.0.2. The following checks pass:

```sh
pnpm --filter @brainstrike/host-lease build
pnpm --filter @brainstrike/host-lease type-check
pnpm --filter @brainstrike/host-lease test
pnpm --filter @brainstrike/host-lease test:integration
pnpm dlx ultracite@7.9.2 fix packages/host-lease docs/agents/host-lease.md docs/archive/agent-contract-history/host-lease/foundation.md
```

TypeScript source/tests and strict Effect diagnostics: 22 files, zero errors or
warnings. Unit: 6 tests in 3 files. Integration: 19 tests in 6 files, no skips.
Linux arm64 Debian 12: Node 26.8.2, the same Effect/Vitest versions. Source build,
test type-check, strict Effect diagnostics, 6 unit and 19 integration tests pass,
with no skips. Exact commands inside the isolated container source tree:

```sh
cd /host-lease-proof
/workspace/node_modules/.bin/tsc -b packages/host-lease
cd packages/host-lease
/workspace/node_modules/.bin/tsc --noEmit --project tsconfig.test.json
/workspace/packages/effect-kit/node_modules/.bin/effect-tsgo diagnostics --project tsconfig.test.json --strict
/workspace/node_modules/.bin/vitest run --exclude "**/*.integration.test.*"
/workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts
```

Hosted CI remains disabled; no hosted run or review was requested. Expected
root-locked messages from the seven losing real-process starters are visible in
integration output; every client then authenticates to the single winning owner.

Linux uses an isolated `/host-lease-proof` source tree in the existing
`bst1920-linuxarm64-proof` container and reuses its dependency runtime read-only.
An initial Linux build failed because the isolated tree lacked the
`@types/better-sqlite3` link; adding that dependency link fixed setup. No source
assertion, timeout or behavior was relaxed.

Missing historical M0 inventory/reports remain a gap; these tests establish
current contract behavior and do not claim exact historical suite parity.
The coordinator separately owns consumer wiring, the real derived-store purge
integration and the architecture integration stack.
