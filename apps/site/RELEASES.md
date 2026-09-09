# Product site release contract

The product site consumes `/release-manifest.json` from its own origin. The checked-in manifest is intentionally unpublished: it contains no repository URL and no download assets. The source repository is private, so it cannot serve as a public releases hub.

## Trust boundary

Manifest v2 validates structure, HTTPS origins, platform/package/architecture combinations, exact asset names, byte sizes, source commit IDs, and SHA-256 metadata. It does **not** authenticate the manifest cryptographically or hash a downloaded binary in the browser. The UI therefore describes links as manifest-declared and presents the declared SHA-256 value for independent verification.

If cryptographic manifest authentication becomes a requirement, introduce a versioned detached-signature field, a pinned public-key and rotation policy, and Web Crypto verification before a manifest may enter the ready state. Do not relabel the current schema as signed.

## Publication pipeline required for one-click downloads

1. Choose a public binary-only release repository or public object store/CDN and a canonical website origin.
2. Establish one authoritative desktop application version. Assert that the tag, packaged application metadata, manifest version, and source commit agree.
3. Build on each target operating system. Emit only architectures the matrix actually built; never derive architecture claims from electron-builder package targets.
4. Sign the final Windows installers. Sign and notarize the final macOS DMGs. Define the Linux signing/checksum policy. Once signing credentials are configured, fail the pipeline if required signing evidence is absent — never ship a half-signed matrix.

   **Signing posture (updated 2026-09-04, BST-1627):** macOS builds are signed with the Developer ID Application identity and notarized through an App Store Connect API key when the `CSC_LINK` secret is present (the intended state; this document cannot verify repo secrets, so the workflow's own posture output is the authority). The `Verify signing evidence` step in `release.yml` is the fail-on-absent-evidence rule in practice: it fails the macOS job unless the packaged app passes `codesign --verify --deep --strict`, carries the hardened-runtime entitlements, has a stapled notarization ticket, and is assessed by `spctl` as `source=Notarized Developer ID`. The DMG container itself is not signed (electron-builder default; Gatekeeper assesses the stapled app inside). Only if `CSC_LINK` is removed does the workflow fall back to the original staged posture (settled 2026-08-17): deliberately unsigned, with `CSC_IDENTITY_AUTO_DISCOVERY=false` so nothing is half-signed, and the download surface must then present the unsigned caveat honestly. Windows still ships unsigned until Authenticode (Azure Trusted Signing) lands; every asset publishes a SHA-256 digest regardless.
5. Smoke-test each packaged application on its target OS, then calculate byte size and SHA-256 from the final signed artifact.
6. Upload immutable, versioned assets first. Generate manifest v2 from the uploaded artifact records rather than handwritten filenames.
7. Validate the generated manifest with the same schema used by the site, verify every public URL, then publish the manifest last. This ordering prevents the site from naming an asset that is not yet reachable.
8. Serve versioned binaries with immutable caching. Serve the stable manifest with revalidation or a short TTL. The client also revalidates its one-minute cache when the download chooser opens.

Partial platform matrices are valid and surface as “Not published.” Multiple builds for one platform are intentionally routed through the full chooser. Publication must remain all-or-nothing for each manifest revision; malformed or unreachable data is a visible failure, never a fallback to guessed filenames.
