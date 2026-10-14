# Mounted-root capabilities and SecureRoot — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "Desktop reads are mounted-root capabilities".
Read before changing WorkspaceRootRegistry authorization, SecureRoot construction, synthetic-root classification, or listing truncation.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '327,386p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

### Desktop reads are mounted-root capabilities

Electron Explorer and Workspace Index reads are authorized by the single
main-process `WorkspaceRootRegistry`; renderer handles are stamped projections,
not authority. A handle read must carry its durable `rootId`. The legacy
absolute-path read is accepted only when contained by a currently mounted root
(longest containing root wins); there is no raw-adapter fallback.

Each mounted real root owns one lazy-loaded native `SecureRoot` whose
constructor is the sole resolver: it opens the root directly (following
symlinks only at that root-establishment step, because the path comes from
the trusted folder picker or persisted store, never repository content) and
derives `canonicalPath` from the opened handle — the pinned capability is its
own identity authority, not a pre-open realpath. Target realpaths are checked
with `allowMissing:false` for containment only; the native operation receives
the original lexical relative path so even an in-root symlink is not
rewritten to its target. Enumeration and bounded reads open each descendant
component relative to the pinned handle with strict no-follow semantics.
Parent, leaf, chained-link, reparse-point, and mounted-root replacement races
therefore cannot escape. Native async work does not serialize per root: each
enumeration opens its own fresh POSIX `.` descriptor (Windows: a fresh
handle-relative reopen), so concurrent calls — within one root or across
different roots — cannot share or corrupt a cursor and no lock is held across
blocking I/O. `close()` never blocks: it revokes the capability for new
operations while operations already in flight drain against the pinned
handle.

Synthetic roots are selected only by the registration-time
`isSyntheticFileSystemPath` seam, whose production default is
`isMockFileSystemIpcPath`. Unit harnesses may opt real-looking fixture paths into
the synthetic adapter explicitly; ambient `VITEST` state is never consulted by
this trust-boundary choice. The decision is frozen by normalized presentation
path and then bound to the opened root's canonical identity; a conflicting alias
fails closed. The one classification consistently selects the synthetic
`createSecureRoot`, canonical-root resolver, and lexical read-path resolver, so a
root cannot mix synthetic and native authorization mechanics. Unit tests that
exercise native composition inject the registry's secure-root/read-path seam as
one required pair.
Legacy mock/fixture read shortcuts consult that same frozen root classification;
an explicitly native mock-prefixed root therefore stays on its mounted secure
capability. If canonical binding rejects a newly opened native capability, the
registration path closes it before propagating the conflict.

Symlink/reparse entries remain explicit file-shaped Explorer rows so indexing
attempts produce the existing visible inaccessible-file result; native reads
never follow them. Listings are bounded at 10,000 inspected entries: the
registry never throws on truncation — it appends a trailing `'truncated'`
pseudo-node (`` `Showing first ${inspected} entries` ``) to the listing it
already returns, no IPC/adapter signature change. The Explorer renders this
node as a visible, non-selectable, non-expandable tail row (mirroring the
existing `'loadMore'` pseudo-node) rather than silently dropping the partial
result or hard-failing the directory. The pseudo-node is excluded from the
tri-state checkbox rollup (`isPseudoFileNodeType`), so a truncated
directory's parent checkbox evaluates only the listed real entries — a
directory whose entire partial listing is selected reads fully `checked`,
not indeterminate, even though the listing itself is incomplete. File bytes
are bounded before crossing into JavaScript. Paired coverage:
`workspace-root-registry{,.integration}.test.ts`,
`file-system-ipc.test.ts`, and
`packages/secure-fs-native/test/secure-root.test.cjs`.

> CORRECTED 2026-09-21: the cap is `MAX_DIRECTORY_ENTRIES = 10_000` in
> `apps/desktop/src/ipc-domains/workspace-root-nodes.ts`, and the message is
> locale-formatted — `Showing first ${inspected.toLocaleString('en-US')}
> entries`, so at the cap it reads "10,000".