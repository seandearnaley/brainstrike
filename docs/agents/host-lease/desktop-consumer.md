# Desktop host acquisition evidence

Supports the host-lease contract's desktop ownership and lifetime rules. This
bounded BST-1941 layer adds an Electron utility-process adapter to the existing
shared discovery launcher. It does not wire main startup/reset/shutdown, change
chat persistence, open the state store, or introduce the M3 run protocol.

## Composition

The isolated branch `codex/m2-desktop-host-acquisition` starts at host-lease
foundation `12c187c07b86b298602b75c7e888260489a90a71`, naturally depending on the
state-store scaffold, Windows process identity and invariant commits below it.

`createDesktopHostLease({ root })` is one desktop acquisition lifetime. Its
`acquire()` coalesces callers and returns the shared authenticated attachment.
`close()` retires acquisition synchronously, aborts pending utility startup and
joins Effect Scope finalizers for the attachment and any child it actually
forked. A failed close remains failed on repeated calls. A new reset lifetime
requires a new manager after the old one successfully closes.

The utility entry accepts the shared strictly decoded startup options and
ready/failed messages. Its separate parent channel accepts exactly
`{ method: 'close' }`; this is lifetime control, absent from the shared socket
protocol. Startup cancellation requests close even before host acquisition
finishes. Exit happens after joined host cleanup and listener removal.

The adapter reconstructs only proved root-locked/foreign-lock startup failures
from the authoritative `RootLock`, allowing the launcher's existing acquisition
race rule to attach to the winner. It never applies the PGlite host's kill
ladder to a discovered owner. Failure to observe its own child's exit is a
visible cleanup failure; it does not kill or claim that lease released.

Shared consumer configuration remains the integration coordinator's change:

- Desktop dependencies: `@brainstrike/host-lease` and
  `@brainstrike/state-store`, both `workspace:*`; lock importer links to
  `../../packages/host-lease` and `../../packages/state-store`.
- Main build entry: `'host-lease-entry': 'src/host-lease-entry.ts'`.
- Main TypeScript includes: `src/host-lease-entry.ts` and
  `src/host-lease-manager.ts`; control is reached transitively.
- After app-ready, construct with
  `root: resolveDesktopDatabaseProfileDirectory()` and await acquisition.
  Shutdown and reset await `close()` before profile cleanup. For CLI-first,
  close only detaches; reset must refuse a still-live external root owner.

No tracked dependency, lock, build-entry, main, reset or TypeScript config file
changes occur in this branch. Local proof uses explicit ignored package links;
the coordinator must compose the listed dependencies before a frozen install
and packaged build can qualify the consumer.

## RED/GREEN record, 2026-10-03

The initial missing-adapter test failed collection. The first implementation
then failed four behavioral controls: a queued ready message arrived before
the resource-registration await completed, so acquisition hung. Registering
startup listeners before the first await fixed that race without changing
assertions. Further controls retain cleanup failures at the reset close barrier
and require attachment failure not to skip owned child cleanup.

The real Electron test exposed a second production failure: a closed host
utility kept its parent channel alive, and cooperative close timed out. The
entry now exits explicitly only after its `finally` joins host cleanup. The
cooperative-close control still requires zero exit, a released root lease,
absent `host.json`, process identity gone, and a different replacement token.

The actual Electron parent SIGKILL case cannot promise graceful release: the
runtime may terminate the utility before its parent monitor writes the marker.
That control requires the process identity gone and real stale takeover with a
new PID/token. It does not reinterpret a live unreachable owner as stale.

Harness corrections were separate from production changes:

- esbuild requires Node's typed-array realm; this real-process integration test
  declares the Node environment rather than the desktop unit DOM environment.
- External packages do not resolve from arbitrary temporary Electron main
  locations through `NODE_PATH`. Proof bundles live below the desktop's ignored
  `dist` directory, using the actual CJS external package graph.
- Vitest aliases package source; Node's process entry is explicitly the built
  host-lease `dist/process-entry.js` rather than a nonexistent source `.js`.
- Linux copied dependency links initially produced two physical state-store
  modules, breaking error class identity. The isolated graph was corrected to
  one package instance. No launcher classification assertion changed.
- The existing container's PID1 is `sleep infinity`, which leaves orphaned
  utility zombies unreaped. The suite runs under Debian's canonical tini
  `0.19.0-1+b3` subreaper, extracted below `/desktop-host-proof/tini`. Assertions
  still require actual PID identity gone. Production process identity code
  remains unchanged.

## Local validation

Mac: macOS 27.0.1 arm64, pnpm Node 26.8.2, pnpm 11.15.0, Electron 44.4.5
(actual Electron main and utility processes), Effect 4.0.0-rc.118, Vitest 5.0.2.
Linux: Debian 12 arm64 in `bst1920-linuxarm64-proof`, the same Node, pnpm,
Electron, Effect and Vitest versions, Xvfb and the explicit tini subreaper.

From `apps/desktop` on both operating systems:

```sh
pnpm exec vitest run src/__tests__/main/host-lease-manager.test.ts src/__tests__/main/host-lease-control.test.ts
pnpm exec vitest run --config vitest.integration.config.mts src/__tests__/main/host-lease-electron.integration.test.ts
```

Results: **10 unit tests in two files and five actual Electron integration
tests in one file passed on each OS**, with no skips or quarantines. Integration
covers simultaneous app acquisition (one owner), both CLI/app start orders,
live root refusal with unchanged lock/identity, observed cooperative closure,
and actual Electron parent death followed by stale replacement.

Linux integration command, from the host:

```sh
docker exec -w /desktop-host-proof/apps/desktop bst1920-linuxarm64-proof /desktop-host-proof/tini/usr/bin/tini -s -- xvfb-run -a /workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts src/__tests__/main/host-lease-electron.integration.test.ts
```

The focused proof config extends desktop `tsconfig.test.json`, sets empty
`paths` and `noEmit: true`, and includes `src/host-lease-*.ts`,
`src/__tests__/main/host-lease-*.test.ts` and the Electron fixture. It is temporary
and not committed. `tsc --project tsconfig.host-lease-proof.json --noEmit` and
`effect-tsgo diagnostics --project tsconfig.host-lease-proof.json --strict`
passed on both OSes; Effect checked seven source/test files without diagnostics.

On Mac, `pnpm -w build --filter @brainstrike/desktop` passed **51 tasks** in
22.393 seconds. Existing build warnings remain visible. The actual utility
entry is independently built by the integration harness with the production
CJS/external-package/node24 settings; the existing build's entry table awaits
coordinator composition. `pnpm exec tsc --noEmit --project tsconfig.test.json`
also passed with the full desktop test graph after that build.

Normal commit hooks passed without bypass: nine-file secret scan, seven-file
formatter (no changes), **52 type/build tasks**, full main and renderer types,
**635 selected test files**, E2E types and **641-file strict Effect diagnostics**
with zero errors/warnings/messages. The type/build hook completed in 49.933
seconds. The evidence-only amendment re-runs the applicable normal hooks.

Real Windows named pipes, FILETIME identity, utility lifetime and DACL behavior
remain unqualified. These results are bounded adapter proof, not full M2
regression, production startup/reset wiring, state/chat cutover or packaged
application acceptance. M0 report/inventory parity and real derived-store purge
remain separate gaps from the underlying state-store foundation.

**CI is disabled due to cost; validation must run locally.**
