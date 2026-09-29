# Resolve-before-asking, and the platform guesses it replaces — evidence

Supports `docs/agents/code-execution.md` § "Backends MUST resolve before
asking". Read this before folding case on darwin, before comparing an
unresolved path, or before building a Windows backend. The contract holds the
rules; this file is the record of why.

`realpath` BOTH operands before calling `isPathCoveredBy`. An unresolved
operand is a security bug, not a style choice, because resolution is what
closes two concrete dodges that no textual comparison can:

- **A symlink into a denied store.** `allowRead: ['/opt/innocent']` compares
  as unrelated to `~/.ssh` — and then srt follows the link. Only the resolved
  path reveals it.
- **A case variant on a case-insensitive volume.** `~/.SSH` is textually
  unequal to `~/.ssh`, but APFS hands back the same directory.

**Do NOT "fix" the case problem by folding case on darwin.** Case sensitivity
is a filesystem property, not a platform one — APFS is case-insensitive by
default but can be formatted case-sensitive — so `platform === 'darwin'` is a
guess. It is also a guess in the DANGEROUS direction: folding makes containment
MORE permissive, producing a false PERMIT at validation that then fails
opaquely once srt applies the real policy. Not folding can only produce a false
reject: confusing, never unsafe. `realpath` is correct on both volume types
with no platform sniffing.

Corollaries:

- **A path with no canonical form is a typed error, never a guess.** A
  nonexistent `scratchDir`/`allowWrite`/`allowRead` entry raises the backend's
  typed policy error rather than being assumed.
- **Deny rules canonicalize BEST-EFFORT.** A host that legitimately lacks
  `~/.gnupg` is normal, not an error, and an absent path has nothing to
  re-open; keep the literal so the rule still reaches the sandbox.
- **macOS canonicalizes `/var/folders/…` → `/private/var/folders/…`** (`/var`
  is a symlink to `/private/var`), so anything derived from `os.tmpdir()` —
  which is where scratch dirs come from — changes spelling on resolution.
  Expect the resolved path, not the one you passed, in the config handed to
  the sandbox.
- **Windows has more aliases than symlinks, and `isPathCoveredBy`'s case-fold
  is the same guess this section rejects on darwin** (BST-1068; latent today —
  no Windows backend exists, so nothing Windows-shaped reaches the predicate
  from a real host). Whoever builds one owns this:
  - NTFS aliases a path far more ways than APFS does: **8.3 short names**
    (`C:\PROGRA~1` ≡ `C:\Program Files`), trailing dots/spaces, alternate data
    streams, the `\\?\` extended-length prefix (which bypasses Win32
    normalization outright — srt ships `stripExtendedPathPrefix` for it), and
    reserved device names. **MEASURED on Windows 11 x64 / Node 24.14.0
    (BST-1068 §7.3a): `fs.realpath` canonicalized NEITHER — it returned the 8.3
    short spelling unchanged and an uppercased path unchanged.** That is the JS
    resolver copying non-symlink components verbatim; only `realpath.native`
    reaches libuv, which is why `fence-policy` defaults to it (BST-1074).
    Whether `.native` expands 8.3 short names on NTFS is a *different* Win32
    behaviour and is **still unproven** — do not assume it from its darwin case
    behaviour. Until measured, a Windows backend must canonicalize explicitly
    (`GetFinalPathNameByHandleW`/`GetLongPathNameW`, or file-identity
    comparison) and verify it before comparing coverage.
  - `isPathCoveredBy` folds case on the **volume prefix only** (1 segment for a
    drive letter, 2 for UNC — host *and* share are both case-insensitive at the
    SMB level). It previously folded every segment while its justification
    covered only the drive letter, which is the same platform-shaped guess this
    section rejects for darwin: NTFS supports **per-directory** case sensitivity
    (`fsutil file setCaseSensitiveInfo`, which WSL sets on directories it
    creates), so a false PERMIT was reachable. Narrowed in BST-1074 — and note
    the dependency: the narrowing is only safe **because** resolution is
    supposed to deliver canonical on-disk spelling for the path body, which is
    exactly the guarantee the bullet above shows is not yet established on
    Windows. The two must move together.
  - **A mapped network drive is not a path the sandbox can resolve at all.**
    srt fails such a launch with a typed `mapped_drive_cwd` error (exit 16)
    because per-user drive mappings do not exist under the sandbox account's
    logon. On a separate-account fence, drive letters are caller-scoped state,
    not machine-global facts.

The FenceExecutor (`packages/agent/src/fence/fence-policy.ts`) is the reference
implementation, including the injected resolver that keeps this unit-testable.
**If a third backend appears, move this duty into the seam as a helper** —
deliberately not extracted at one consumer, where the shape would be a guess
derived from a single call site.

Windows path forms are accepted by the schema, but no Windows backend exists
yet — the fence's Windows story is BST-1068.
