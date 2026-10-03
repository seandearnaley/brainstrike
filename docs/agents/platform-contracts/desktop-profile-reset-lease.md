# Desktop profile reset lease adapter

Supports the factory reset rules in `platform-contracts.md` and the PGlite close
rules in `database.md`.

## 2026-10-03 guarded destructive phase

The reset helper previously removed the entire active profile and later staged
its entire userData ancestor. That removed RootLock's coordination namespace,
allowing a launcher to start during a purge that could delete its fresh files.
The first real packaged-layout RED observed the namespace missing; even release
then failed because ownership was gone. A second RED showed the lease preparation
API absent. The original run retained 33 passing cases and these two failures.

`prepareDatabaseProfileReset({ retireProfileOwner })` closes and joins legacy PG,
then joins the caller's owned native host, then acquires the existing profile
RootLock. Main legacy admission closes before PG shutdown; utility-local reset
retains its existing bounded quiescence loop. Once quiescent, all legacy admission
remains closed across the async clear and subsequent purge until release.
Failed retirement preserves the original callback/cause and closed admission;
a retry cannot omit that owner callback. The added retirement RED on a prior
Linux source copy incorrectly acquired a guard while ignoring the callback.

The returned accessible `ProfileResetLease` wraps backup, authoritative clear and
empty pgdata recreation. A borrowed `resetLocalDatabase(guard)` never releases.
The standalone developer reset acquires that same owner, releasing only after
its profile clear succeeds. Failed backup/deletion leaves the guard accessible
through preparation for retry. Backups omit coordination ownership metadata and
retain the existing engine-upgrade exclusion/retention rules.

Factory reset acquires inside the existing scheduler barrier/subscription/idle
sequence. It retains the borrowed guard through profile clear, userData staging
and persistent Electron storage clearing, releases before renderer replacement,
and reuses the same guard after a critical error. UserData purge preserves only
logs, the exact lock namespace and the ancestor directories needed to reach it;
all unprotected siblings inside those ancestors are still staged/deleted. Paths
are compared to RootLock's canonical namespace, including macOS /var aliases.

All-runtimes attempt ordering, original failure causes, MCP admission/reload
behavior, NDJSON reporting and pending-trash reporting retain their existing
contracts. Pending-trash and NDJSON failures remain reported, nonfatal limitations;
this change does not claim those bytes are necessarily removed. New critical
profile/native deletion or storage failures reject and retain the owned guard.

CI is disabled due to cost; validation must run locally.

## Focused qualification

The isolated branch starts from integration `b04f90f5d1eb14432506e904c3ed73938a643172`
and guard source `6642e654d2f40a518397bb59ddb7c7210fa35016`.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec turbo run build --filter=@brainstrike/host-lease... --concurrency=2
pnpm exec turbo run build --filter=@brainstrike/desktop^... --concurrency=2
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/main/desktop-factory-reset-packaged-layout.test.ts src/__tests__/main/db-main.close.test.ts src/__tests__/main/db-main.remote-reset.test.ts src/__tests__/main/db-main.lifecycle.test.ts src/__tests__/main/db-main.coverage.test.ts src/__tests__/main/db-host-manager-init-stop-reset.test.ts src/__tests__/main/desktop-factory-reset.test.ts src/__tests__/desktop-reset-platform.test.ts src/__tests__/desktop-reset-profile-lease.test.ts src/__tests__/main/desktop-factory-reset-storage-ledgers.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
pnpm --filter @brainstrike/desktop exec vitest run --config vitest.integration.config.mts src/__tests__/main/desktop-reset-lease-electron.integration.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
pnpm --filter @brainstrike/desktop exec tsc --noEmit --project tsconfig.main.json
pnpm --filter @brainstrike/desktop run type-check:test
pnpm --filter @brainstrike/desktop exec effect-tsgo diagnostics --project tsconfig.test.json --strict
```

Mac arm64 passed 113 focused cases in 10 files and 3 actual Electron integration
cases in one file. Test types selected 638 files; strict Effect checked 644 files
with zero diagnostics. Existing bounded close/reopen, sticky close failure,
init-stop recovery, storage ledgers, scheduler/MCP/reload and both reported
pending-deletion policies remain covered.

Linux arm64 uses a separate `/desktop-reset-adapter-proof` copy in the existing
Debian bookworm container with Node 26.8.2 and Electron 44.4.5. Its source/dependency
links are isolated; installed dependencies/builds are reused, not a fresh Linux
installation claim. Unit proof initially passed 112 cases before the retirement
case was added; the updated retirement/legacy-close pair passed all 40 cases.
Actual Electron ran under the existing canonical Debian tini subreaper and Xvfb:

```sh
docker exec -w /desktop-reset-adapter-proof/apps/desktop bst1920-linuxarm64-proof /host-desktop-delivery-proof/tini/usr/bin/tini -s -- xvfb-run -a /workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts src/__tests__/main/desktop-reset-lease-electron.integration.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

All three actual Electron cases passed on Mac and Linux: real PG statements and
clean legacy utility exit before owned native-host retirement; profile/native
filename fixtures removed while the lock and ancestors survive userData purge;
Electron-storage failure retains the same owner for successful retry; and an
actual live persistent CLI owner refuses reset before profile/userData deletion,
retaining its exact discovery record and payload. Native filename fixtures are
bytes, not a production indexer corpus or a state-chat migration proof.

## Linux exit and OS reaping evidence

The first Linux real Electron run failed 2 cases, with the external CLI refusal
case passing: the proof required immediate PID/start disappearance. A diagnostic
run captured PG PID 29700, parent Electron PID 29593, `/proc/29700/stat` state
`Z` with PPID 29593, and exactly zero entries in `/proc/29700/fd`. Canonical
DbHostProcess close had already joined its registered actual utility exit event.

The corrected test observes every real PG utility exit directly at fork without
substituting the child or lifecycle. It requires that event, then either the
original PID/start is gone, or Linux shows exactly `Z`, the expected parent and
zero FDs. Concurrent reaping is accepted only after independent disappearance
of that original identity; unreadable or live processes fail. This distinguishes
an exited writer from delayed removal of its kernel process entry. No sleeps,
polling-to-pass, production RootLock identity change or stale takeover exception
was introduced. The original failed immediate-procentry-removal claim remains
recorded in `/tmp/brainstrike-reset-adapter-linux-electron.log` and the concrete
snapshot in `/tmp/brainstrike-reset-adapter-linux-pg-exit-observation.log`.

This adapter does not edit main.ts. Main must inject owned-host retirement and
forward the borrowed guard; passing a bare reset callback would release too
early and fails closed before userData purge. Full main/query/indexer startup,
complete application reset/reload acceptance, actual Windows execution, original
M0 inventory parity and power-loss acceptance remain outside this focused proof.
No hosted CI, M3 loop/protocol, or chat/state-store cutover was introduced.
