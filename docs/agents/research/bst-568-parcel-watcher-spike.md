# BST-568 slice 1 — @parcel/watcher spike: packaging matrix + benchmark

Status: settled findings for slices 2–4. Linear: BST-568. Date: 2026-07-19.

## Dependency decision

- `@parcel/watcher@^2.5.6` added to `@brainstrike/file-system` via the pnpm catalog.
- **Install build script disallowed** (`allowBuilds: '@parcel/watcher': false` in
  `pnpm-workspace.yaml`). The script is a node-gyp-build *source-compile fallback*
  for platforms without a prebuild. Repo rule is no silent fallbacks: a missing
  prebuild must fail the packaging-matrix check loudly, not quietly compile a
  local binary that masks the hole (same failure class as the #1749 arch-blind
  turbo-cache incident). Prebuilds are NAPI, so no per-Electron-ABI rebuild is
  needed and the turbo `cache:false` native-addon guard (own-gyp builds only)
  does not apply.

## Packaging matrix

Prebuilds ship as optional dependencies OF `@parcel/watcher` (resolvable only
from its own package location under pnpm strict layout — see
`scripts/validate-parcel-binding.mjs`):

| Target | Prebuild package | Backend | Status |
| --- | --- | --- | --- |
| darwin-arm64 | `@parcel/watcher-darwin-arm64` | `fs-events` | **validated live** (this spike) |
| darwin-x64 | `@parcel/watcher-darwin-x64` | `fs-events` | prebuild published; validate in CI x64 lane |
| linux-x64 glibc | `@parcel/watcher-linux-x64-glibc` | `inotify` | prebuild published; validate in CI |
| linux-arm64 glibc | `@parcel/watcher-linux-arm64-glibc` | `inotify` | prebuild published; validate in CI (ARM lanes exist per Series C) |
| linux musl | `@parcel/watcher-linux-*-musl` | `inotify` | published; not a supported Brainstrike target today |
| win32-x64 | `@parcel/watcher-win32-x64` | `windows` | prebuild published; validate via user's Windows tester + CI |

Validation command (CI + packaged-app usable, JSON out, exit 1 on failure):
`pnpm --filter @brainstrike/file-system validate:parcel-binding`

Sample (this machine): `{"arch":"arm64","backend":"fs-events","firstEventMs":11.8,"ok":true,"platform":"darwin","prebuildPackage":"@parcel/watcher-darwin-arm64","subscribeMs":0.7}`

## Benchmark (30k dirs, 60k files, darwin-arm64 M-series)

`node scripts/watcher-benchmark.mjs --dirs 30000 --files-per-dir 2 [--engine fs-watch]`

| Engine | Subscribe | RSS delta | First event | Burst throughput | Backend errors |
| --- | --- | --- | --- | --- | --- |
| parcel `fs-events` | 2.0 ms | +0.7 MB | 13 ms | ~15.3k events/s | none |
| node recursive `fs.watch` (current macOS engine) | 1.7 ms | +0.5 MB | 11.1 ms | ~12.8k events/s | n/a |

Reading: on macOS both engines sit on FSEvents, so cost parity is expected —
the migration's macOS win is uniformity + health protocol, not raw speed. The
resource win targets Linux/Windows, where chokidar holds one JS watcher per
directory (the EMFILE storm of PR #1761's incident).

## Findings that shape slice 2

1. **FSEvents drop is real, not theoretical.** Subscribing immediately after a
   ~90k-entry write burst produced `Events were dropped by the FSEvents client.
   File system must be re-scanned.` delivered as an error to the subscribe
   callback. The adapter MUST map backend callback errors to the root-level
   invalidation event (`{kind:'directory', path: root, type:'modified'}`) —
   this is the ticket's "backend events that cannot identify a path" case.
2. **Callback errors arrive on the event callback, not as rejections.** The
   subscription stays alive after such an error; the adapter decides whether to
   degrade (invalidate root, keep watching) or fail. Slice 2 policy: invalidate
   root + keep subscription (degraded), surfaced via slice 3 health states.
3. **Linux inotify limits still apply.** inotify consumes one watch descriptor
   per directory regardless of library; `fs.inotify.max_user_watches` exhaustion
   surfaces as ENOSPC. parcel doesn't remove the limit — it makes the failure a
   single explicit error instead of a per-directory JS error storm. Health
   protocol (slice 3) must classify ENOSPC as terminal+retryable-after-config.
4. **Prebuild resolution must go through `@parcel/watcher`'s own location**
   (pnpm strict layout) — relevant for the packaged-app check in slice 4.

## Packaged Electron plan (slice 4)

- electron-builder: add `**/node_modules/@parcel/watcher*/**/*.node` (and the
  platform prebuild package dirs) to `asarUnpack` alongside the existing
  secure-fs-native/node-pty entries; `npmRebuild: true` is harmless for NAPI.
- Packaged smoke must run the equivalent of `validate:parcel-binding` inside
  the app (main process) — loading the binding from the asar-unpacked path is
  the thing a dev-mode test cannot prove.
