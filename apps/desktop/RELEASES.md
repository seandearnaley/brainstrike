# Desktop release contract

`.github/workflows/release.yml` builds, verifies and publishes the desktop
downloads. It runs only on a stable tag `v<major>.<minor>.<patch>` that matches
`apps/desktop/package.json`'s version, or on `workflow_dispatch` as a dry run
(build, smoke test and hash; nothing is published). Starting either, and
providing its signing and publishing secrets, is the owner's decision.

## Publication pipeline

1. One authoritative application version: the tag, the packaged application
   metadata, the manifest version and the source commit must agree.
2. Build on each target operating system. Emit only architectures the matrix
   actually built; never derive architecture claims from electron-builder
   package targets.
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
   stapled app inside). Without `CSC_LINK` the workflow builds the documented
   unsigned posture, with `CSC_IDENTITY_AUTO_DISCOVERY=false` so nothing is
   half-signed, and the download surface must present the unsigned caveat
   honestly. See `apps/desktop/SECURITY.md` for the signing details.
4. Smoke-test each packaged application on its target OS, then calculate byte
   size and SHA-256 from the final artifact.
5. Upload immutable, versioned assets first, with `SHA256SUMS`.
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

## Pending

The product site that was to serve the download chooser (#2186) was closed
without merging, so no site consumes the manifest yet. When a download surface
lands, it reads the published `release-manifest.json` (or a manifest PR step is
reinstated) and validates it with its own production schema before rendering
links.

BST-2148: the x64 macOS DMG built on the arm64 runner ships arm64-only native
addons. The smoke step's `scripts/verify-macos-addon-archs.mjs` fails the job
on it, so x64 cannot ship until the owner picks an Intel runner leg, a
cross-arch install and rebuild, or an arm64-only macOS release.
