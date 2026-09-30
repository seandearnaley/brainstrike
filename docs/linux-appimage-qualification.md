# Linux x64 AppImage qualification

This is a release qualification procedure, not a new distribution-support claim.
`Native Electron Package` currently packages with `electron-builder --dir`; that
unpacked executable is **not** an AppImage installation or upgrade test. The
release pipeline tracked in BST-1898's linked release ticket remains the owner of
building and publishing release artifacts. This procedure does not publish them.

## Scope and safety

Use a disposable **non-root Linux x64 desktop account/VM** with a display session,
an unlocked supported OS keyring, unprivileged user namespaces, and (for mounted
launches) readable/writable `/dev/fuse` plus the runtime's FUSE dependencies. Do
not point the test at a personal profile, real provider keys, or valuable files.
The harness only generates an unknown-provider synthetic credential. It does not
call a provider. It uses the real production storage/secrets preload bridges, not
Electron E2E mode's in-memory credential store.

Do not add `--no-sandbox`, `--disable-setuid-sandbox`,
`ELECTRON_DISABLE_SANDBOX`, `--password-store=basic`, or change AppArmor/sysctls,
namespace restrictions, or `chrome-sandbox` permissions to obtain a pass. A
blocked prerequisite is a qualification failure to record on the ticket.

The pinned electron-builder 26.17.0 has two relevant behaviors:

- Its default legacy AppImage desktop entry contains `--no-sandbox`.
  `build.appImage.executableArgs: []` explicitly removes that default. The
  embedded desktop metadata must be inspected on the **actual output** too
- Its generated `AppRun` adds `--no-sandbox` when `unshare -Ur true` fails,
  including with its newer toolset. The harness therefore requires that probe
  to succeed **before executing AppRun** and checks the live main process's
  arguments and process-group ownership over `/proc` after connecting to CDP

These checks qualify the launch arguments, not a kernel sandbox attestation.
Changing the builder requires rechecking both launcher behaviors. Do not assume
that changing the toolset alone removes the fallback.

## Build and identify actual artifacts

Keep the last intended release AppImage and the candidate AppImage from their
respective source commits. Use the repository's pinned Node/pnpm, lockfile and
normal build/install hooks. A local candidate build, without publication:

```bash
pnpm install --frozen-lockfile
pnpm --filter @brainstrike/desktop exec install-electron
pnpm build --filter=@brainstrike/desktop
pnpm --filter @brainstrike/desktop exec electron-builder --linux AppImage --x64 --publish never
```

The configured Linux icon input is `apps/desktop/build/icons`. If that input or a
build prerequisite is missing, record the packaging failure. Do not manufacture
replacement branding to turn packaging green. Release CI must use its own
approved inputs. `--dir`, a renamed ELF executable, or two copies of one build do
not supply the two artifacts required below.

Record source commits/build provenance outside the JSON report (which verifies
artifact bytes, not source provenance), artifact versions, exact SHA-256 hashes,
host distro/version/kernel, desktop/session type, keyring implementation, and
whether this is a freshly provisioned host. The report extracts
`X-AppImage-Version`, `Name`, `Exec`, and `Icon` from each image's desktop entry.
Versions can be equal during development; that is artifact replacement coverage,
not evidence of a released-version/database migration.

## Automated bounded lifecycle

From the repository root, with dependencies installed, use absolute paths and a
new report filename. Artifact paths with spaces are supported.

```bash
node scripts/qualify-linux-appimage.mjs \
  --previous /absolute/releases/previous.AppImage \
  --candidate /absolute/releases/candidate.AppImage \
  --mode mounted \
  --output /absolute/qualification/mounted-report.json
```

`mounted` launches each original AppImage directly. It never retries via
extraction. For an explicitly separate extraction-path investigation, use
`--mode extract` and a different output filename. That uses the AppImage
runtime's `--appimage-extract-and-run`; it is never mounted-AppImage proof.
Both modes extract only launcher/desktop metadata before launching. This
metadata inspection itself does not launch the application.

The harness reserves its owner-only report before expensive work, validates
actual x64 type-2 AppImage headers, hashes both files, and refuses identical
bytes or resolved paths. It creates a fresh disposable HOME/XDG/userData profile
next to the report; all four runs reuse that one profile. Agent DevTools is
opted in on loopback only, without enabling E2E/test semantics. The sequence is:

1. Launch previous, wait for the actual main navigation and production bridge,
   verify empty qualification state, then write one application-storage marker
   and one synthetic credential through the production APIs
2. Close gracefully, restart previous, read both values without reseeding
3. Close gracefully, launch candidate, read the same values without reseeding
4. Close gracefully, restart candidate, verify both again
5. After shutdown, verify the encrypted credential record exists and the
   synthetic plaintext marker is absent from its on-disk file

Read the complete report. Exit 0 / `passed-bounded-lifecycle` covers only this
sequence. A failed stage, missing keyring, early process exit, timeout, abort,
failed cleanup, or report-write error is nonzero. No app logs or credential
values are included in the report. The owned process group is stopped before
removing its profile; when process-tree cleanup cannot be confirmed, the profile
is retained for diagnosis rather than deleted beneath a live app. Interrupted
runs may leave an `incomplete` report and must not be treated as passing.

This storage marker is not PGlite/assistant-thread migration coverage. The
harness neither performs an updater transaction nor proves rollback, version
ordering, menu integration, folder picking, or clean-host compatibility.

## Required clean-desktop/manual gates

Keep the ticket/release gate open until all applicable checks have real evidence:

- On the intended clean Linux x64 baseline, copy/download the actual candidate,
  mark it executable, and launch it normally through the mounted AppImage path.
  Record any FUSE, keyring, sandbox or display prerequisites; never disable them
- Use the native folder picker to select a disposable directory containing a
  known text file. Open/read it in the app, close normally, restart, and confirm
  its root/data remain usable. Also cancel the picker and repeat an open
- Inspect the embedded desktop entry and icon. Modern electron-builder
  AppImages do **not** self-install menu entries or MIME associations. Only
  qualify a desktop integration mechanism the release actually documents and
  supports; record "not provided" otherwise. If using an approved external
  integrator/manual entry, verify its real Exec path, icon, menu launch, and
  file/folder handling before and after replacing the AppImage. Do not count
  extraction of a `.desktop` file as successful desktop integration
- Seed representative test-only app data, including a saved thread or indexed
  fixture if the release changes the database. Replace the older release with
  the candidate in the intended stable file location and check that data and
  synthetic credentials survive. Preserve build/source/version provenance;
  same-version builds establish replacement only
- Close and reopen the candidate a second time. Attach the artifact hashes,
  JSON reports, manual observations, screenshots where useful, and limitations
  to the PR/ticket. No checked-in generated proof or new CI planner is needed

Run the harness contracts with:

```bash
node --test scripts/__tests__/qualify-linux-appimage.test.mjs
```

Upstream references:
[electron-builder AppImage behavior](https://www.electron.build/docs/appimage/),
[Electron safeStorage Linux keyring semantics](https://www.electronjs.org/docs/latest/api/safe-storage).
The installed pinned builder source and the generated artifacts take precedence
where rolling documentation describes a newer release.
