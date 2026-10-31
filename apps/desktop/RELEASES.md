# Desktop release contract

`.github/workflows/release.yml` builds, verifies and publishes the desktop
downloads. It runs on a tag `v<version>` that matches
`apps/desktop/package.json`'s version, or on `workflow_dispatch` as a dry run
(build, smoke test and hash). Only the tag push publishes; a dispatch never
does, even on a tag ref. A dispatch with `unsigned` builds the unsigned macOS
posture even when signing secrets are configured, so a proof run signs and
notarizes nothing. Starting either, and providing its signing and publishing
secrets, is the owner's decision.

## Versions

Versions are SemVer: `0.1.0-beta.1`, `0.1.0-beta.2`, … then `0.1.0`. A
prerelease is a numbered `alpha` or `beta`, the two channels electron-updater
knows; `scripts/generate-release-manifest.mjs` refuses any other tag. A
prerelease version publishes a GitHub prerelease, and the manifest's `channel`
is `alpha`, `beta` or `stable` from the tag.

To cut a release: merge a PR that sets `apps/desktop/package.json`'s
`version`, wait for a scheduled nightly to pass on a commit containing it
(next section), then push `v<version>` at that commit.

## Release notes

The publish job writes the GitHub release body with git-cliff (`cliff.toml`)
from the commits between the previous release tag and this one: every commit
on `main` is a squash-merged PR with a conventional title, so `feat`, `fix` and
`perf` become New, Fixes and Performance, and the other types stay out. PR
numbers and Linear ids are stripped because they point into this private
repository. The first release has a one-line body. The release body is the
notes' only home; edit it on GitHub after publishing if a line needs a human
touch.

## App icon

`apps/desktop/build/icon.icon` is the source of the macOS icon, an Icon
Composer asset: the identity mark (`Assets/01-foreground.svg`) on the
ultramarine fill, with Liquid Glass translucency. Compiling it needs macOS 26
or later as well as Xcode 26's `actool`; on the macOS 15 release runners
`actool` crashes, and there is no Intel macOS 26 runner. So it is compiled once
on a Mac and both outputs are committed: `build/Assets.car`, which macOS 26 and
later show (`CFBundleIconName`, from `mac.extendInfo`), and `build/icon.icns`
for older macOS (`mac.icon`). Packaging copies them and needs no Xcode.

After changing `icon.icon`, rebuild both on macOS 26 or later with Xcode 26 or
later, from `apps/desktop`. The copy is named `Icon.icon` because `--app-icon`
names the icon by its file name:

```sh
OUT=$(mktemp -d) && cp -R build/icon.icon "$OUT/Icon.icon" && mkdir "$OUT/out"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun actool "$OUT/Icon.icon" \
  --compile "$OUT/out" --output-partial-info-plist "$OUT/out/info.plist" --app-icon Icon \
  --include-all-app-icons --enable-on-demand-resources NO --development-region en \
  --target-device mac --minimum-deployment-target 26.0 --platform macosx
cp "$OUT/out/Assets.car" build/Assets.car && cp "$OUT/out/Icon.icns" build/icon.icns
```

Windows and Linux use `icon.ico` and `icons/*.png`, rendered from
`icon-square.svg`.

## In-app updates

A packaged install checks `seandearnaley/brainstrike-releases` once per launch
(`src/app-update.ts`, electron-updater, the `publish` entry in `package.json`).
A newer release downloads in the background and installs when the app quits.
A beta install follows prereleases and a stable install only stable releases,
because electron-updater sets `allowPrerelease` from the running version. With
the GitHub provider electron-builder writes `latest*.yml` for every version, and
GitHub's prerelease flag, not a separate channel file, separates the two.

macOS updates install the `.zip` (Squirrel.Mac), so each macOS leg builds a DMG
and a zip from the same signed, notarized app, and the signing gate checks both.
Each leg's `latest-mac.yml` names only its own arch;
`scripts/release-update-info.mjs merge-mac` joins them, and MacUpdater picks
the arm64 files on Apple silicon and the others on Intel. Unpackaged, unit and
E2E runs never check for updates.

## Release commit (BST-2190)

A release builds only a commit on which every required nightly workflow
passed. `scripts/release-required-workflows.mjs` names that set:
`nightly.yml`, whose one run calls the six required workflows on one commit
and succeeds only when every call did (BST-2233).
`scripts/resolve-release-sha.mjs` judges a commit from the Actions API: for
each required workflow, the latest completed run on `main` at the commit must
have succeeded. The nightly cron and `gh workflow run nightly.yml --ref main`
run the same jobs, so either counts; a release need not wait for the night
(owner decision 2026-10-28). A run in progress, or no run, counts as missing.

The workflow's first job resolves the commit, and every other job checks it
out instead of the triggering ref. A tag push judges the tagged commit, and a
dispatch judges its `sha` input when one is given. If any required workflow is
red or missing, the run refuses and names each one; it never builds another
commit instead. A dispatch without `sha` builds the newest all-green `main`
commit from the last 14 days of runs on `main`, or fails and says how far back
it searched.

## Publication pipeline

1. One authoritative application version: the tag, the packaged application
   metadata, the manifest version and the source commit must agree.
2. Build on each target operating system. Emit only architectures the matrix
   actually built; never derive architecture claims from electron-builder
   package targets.

   **macOS builds each arch natively (BST-2148).** The arm64 DMG builds on
   `macos-15` and the x64 DMG on `macos-15-intel`, the Native Package Matrix's
   darwin targets in `scripts/native-package-targets.mjs`. pnpm installs only
   the host's platform packages and node-gyp compiles the workspace addons for
   the host, so a leg first asserts its runner is its target. Each leg then
   runs its own signing-evidence gate and smoke test, including
   `scripts/verify-macos-addon-archs.mjs`: every Mach-O addon in the app must
   carry the DMG's arch, or name the other darwin arch with its target sibling
   present.

   **Linux builds x64 and arm64 AppImages, each natively (BST-2190).** Each
   leg runs on a Ubicloud runner of its arch (`ubicloud-standard-4`,
   `ubicloud-standard-4-arm`) and asserts its runner is its target. Each leg
   names its AppImage `Brainstrike-<version>-linux-<arch>.AppImage`, overriding
   `linux.artifactName`, whose x64 literal exists because electron-builder's
   `${arch}` names an x64 AppImage `x86_64`. Keep one release leg per Native
   Package Matrix target, and make sure the manifest names every leg's asset.
3. Sign the final macOS DMGs' apps and notarize them; Windows ships unsigned
   until Authenticode (Azure Trusted Signing) lands; Linux publishes a SHA-256
   digest. Once signing credentials are configured, the pipeline fails if
   required signing evidence is absent — a matrix is never half-signed.

   **Signing posture (BST-1627):** macOS builds are signed with the Developer
   ID Application identity and notarized through an App Store Connect API key
   when the `CSC_LINK` secret is present. The `Verify signing evidence` step is
   the fail-on-absent-evidence rule: it fails the macOS job unless the packaged
   app passes `codesign --verify --deep --strict`, carries a hardened-runtime
   signature and its entitlements, has a stapled notarization ticket, and is
   assessed by `spctl` as `source=Notarized Developer ID`. The DMG container
   itself is not signed (electron-builder default; Gatekeeper assesses the
   stapled app inside). Without `CSC_LINK`, or on an `unsigned` dispatch, the
   workflow builds the documented unsigned posture: no signing or notarization
   secret reaches the build, `CSC_IDENTITY_AUTO_DISCOVERY=false` so nothing is
   half-signed, and the gate asserts no Developer ID signature is present. The
   download surface must present the unsigned caveat honestly. See
   `apps/desktop/SECURITY.md` for the signing details.
4. Smoke-test each packaged application on its target OS, then calculate byte
   size and SHA-256 from the final artifact.
5. Upload immutable, versioned assets first, with `SHA256SUMS`. A published
   asset, the manifest included, is never replaced or deleted
   (`scripts/release-asset-plan.mjs`). A rerun keeps each asset whose
   published sha256 equals the run's and uploads only the missing ones. If any
   published asset holds different bytes, as a full rerun's re-signed DMGs do,
   the job fails before uploading anything; publishing those bytes needs a new
   version tag.
6. Verify every public URL, then generate manifest v2
   (`scripts/generate-release-manifest.mjs`) from the uploaded artifact records
   rather than handwritten filenames, and publish it last as the release's
   `release-manifest.json`, together with the `latest*.yml` update metadata.
   `scripts/release-update-info.mjs verify` first checks that every file the
   metadata names is a staged asset with the declared size and sha512. This
   ordering means neither the manifest nor an updater can name an asset that
   is not already reachable.
7. Trigger the download site's Vercel deploy hook (`VERCEL_SITE_DEPLOY_HOOK`).

Publication is all-or-nothing for each manifest revision; malformed or
unreachable data is a visible failure, never a fallback to guessed filenames.

## Manifest trust boundary

Manifest v2 validates structure, HTTPS origins, platform/package/architecture
combinations, exact asset names, byte sizes, source commit IDs and SHA-256
metadata. It does **not** authenticate the manifest cryptographically, and a
consumer cannot treat a declared digest as a verified download. If cryptographic
manifest authentication becomes a requirement, introduce a versioned
detached-signature field, a pinned public key with a rotation policy, and
verification before a consumer may trust it; do not relabel the current schema
as signed.

## Download surface

`brainstrike.ai` is the Vercel project `brainstrike-ai`, built from the
separate repository `seandearnaley/brainstrike.ai`. Its build reads the public
releases feed, takes the newest release that has a `release-manifest.json`,
validates it, and renders one link per asset; until a release exists it shows
"coming soon". A malformed manifest or a network error fails that build rather
than guessing filenames. The release's last step triggers the site's deploy
hook, so the page lists a release once its manifest is published. The site sits
behind Vercel Authentication on every URL until launch.
