# Desktop release contract

`.github/workflows/release.yml` builds, verifies and publishes the desktop
downloads. It runs only on a stable tag `v<major>.<minor>.<patch>` that matches
`apps/desktop/package.json`'s version, or on `workflow_dispatch` as a dry run
(build, smoke test and hash). Only the tag push publishes; a dispatch never
does, even on a tag ref. A dispatch with `unsigned` builds the unsigned macOS
posture even when signing secrets are configured, so a proof run signs and
notarizes nothing. Starting either, and providing its signing and publishing
secrets, is the owner's decision.

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
   present. `scripts/__tests__/release-workflow-contract.test.mjs` pins this
   shape.
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
   `release-manifest.json`. This ordering means the manifest can never name an
   asset that is not already reachable.

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

The product site that was to serve the download chooser (#2186) was closed
without merging. The owner accepted (19 Oct 2026) the release's
`release-manifest.json` asset as the published download surface. A download
chooser that lands later reads that asset and validates it with its own
production schema before rendering links.

## Open: x64 macOS and onnxruntime-node (BST-2148)

`onnxruntime-node` 1.30.0, which `@huggingface/transformers` 4.3.1 pins, ships
no `darwin/x64` binding (1.23.0 shipped one; 1.24.1 and 1.30.0 do not). A
native x64 install still packages only its `darwin/arm64` binding, so the addon
gate fails the x64 leg on it until the owner decides how x64 macOS treats that
package.
