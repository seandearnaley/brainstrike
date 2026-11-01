# Explorer, search and the thread context map

## Data and authority

Explorer selection, loaded file content and search results are projections of
canonical roots/sources. Use acknowledged root identity and the shared content
owner; paths and cached folder IDs do not grant access. Desktop direct reads use
an explicit mounted-root capability; web reads preserve handle/permission semantics.
Late content results are generation-fenced, per-key failures remain visible, and
Retry targets the failed key instead of restarting every consumer.

Search hits retain exact file/chunk identity, source text, offsets and line ranges.
Open the actual owning file and range; do not reconstruct snippets or count an
unverified fragment as an answer. File tabs use those same source ranges. Raw file
content remains ephemeral in explorer state; it is not copied into durable
selection snapshots or diagnostics. Markdown previews must not
execute content or load arbitrary external resources.

## Thread context map

The Context tab and the explorer's This thread column show what the active
thread's model received. Both read one client fold of the thread's committed log:
the host's committed request breakdown says what was in the window, and each
tool's committed result says which lines. Clients never re-derive rewrite,
compaction or branch rules. A result the fold can't read shows as unmapped, and an
unmeasured request as "not measured", never as zero. It is desktop-only: web has
no committed run log.

A thread's direct subagents are lanes of its Context tab. The host
lists the children; a child's lane appears from the parent turn whose run started
it, on the displayed branch. Each lane reads the child's own committed log through
the host and folds it with the same fold and branch rules as the child's own view,
so a lane shows the child's map and scrubber, never the parent's. Lanes are read
only while the tab shows them, and a lane that can't be read says so. A
grandchild is a lane of its parent's Context tab.

"Changed since read" compares through the shared content owner. A file that
wasn't checked reads "not checked", and a failed check says so; neither reads as
unchanged.

Checked files are a bulk selection, not model context. "Attach to thread" appends
`@file` mentions to the composer, so the user sees what goes to the model and the
admission reader applies its caps. Export copies whole selected files.

## Ignore and traversal policy

Use one shared ignore matcher. Git/global/search ignore layers are bypassable
only by the explicit includeIgnored option. `.llmignore` and `.brainstrikeignore`
are hard read boundaries and cannot be undone by deeper git negation or that
option. Apply them to directory components and the leaf on walks, grep and shared
file readers; refusal is not empty content. The same boundary binds mutations:
write, edit and delete refuse an agent-ignored or credential target, and rename
refuses either end (out would make the file readable, in could clobber or hide
one). Approval for mutations remains a separate contract on top.

Beneath every layer, the shared matcher holds a credential floor
(`isWorkspaceSecretFile`): `.env` and `.env.*` (not `.env.example`, `.env.sample`
or `.env.template`), `*.pem`, `*.key` and `id_rsa*` are never walked, grepped, read
or indexed. No negation in any ignore file and no includeIgnored lifts it, and it
reads as hard. Direct reads refuse it by name as a credential file (ADR-0016
amendment).

Bounded traversal reports truncation and unverifiable coverage honestly. An
excluded-path probe must itself honor hard ignores. Canonical indexing receives
unchanged parser/chunker output; [indexer](indexer.md) owns publication and
coverage, not the preview UI.

## Reads

On desktop the agent host serves the Explorer's reads (ADR-0029 stage 4):
`workspace/files/list`, `workspace/files/read` and `workspace/files/exists`, gated to
the desktop's private client. Each read is confined to a root the host's catalog
records as live, through a `SecureRoot` opened for that read and closed after it. A
`rootId` anchors a read to its root; otherwise the deepest live root containing the
path serves it; `rootPath` binds it to exactly that root. Realpath containment
authorizes the target and native I/O keeps the lexical path, so in-root symlinks are
never followed. A missing or oversized file answers `NOT_FOUND` or `TOO_LARGE`. E2E
reads real disposable folders; there is no synthetic tree.

## Live refresh

Use the existing watcher capability and event channel. On desktop the agent host
owns the Explorer's watches (ADR-0029 stage 4): a window calls
`workspace/files/watch` on its host connection with the exact path of a live root,
and batches and health arrive on that connection's `workspace/files/event` stream.
The host keeps one `fs.watch` per canonical root for every window that watches it,
with independently disposable watch IDs; a connection's watches end when it closes,
and a watch whose host ended reports a retryable failure. Unsupported engines fail
rather than falling back. Missing web observation is visibly unwatched. Do not add
polling to disguise it.

Watch events invalidate shared state through one pipeline. Filter exclusions
root-relatively, preserve explicitly opened roots and revalidate active generation
before applying changes. An overflow or degraded watch requires full-root
reconciliation before complete coverage can be claimed; partial change evidence
cannot stand in for a full scan. Disposers join their actual subscriptions and
cannot remove a replacement owner's watch.

Decisions: [ADR-0016](../adr/0016-workspace-trust-and-ignore-chain.md),
[ADR-0021](../adr/0021-thread-context-map-and-explicit-attachment.md).
Implementation: `packages/file-explorer`, `packages/file-explorer-ui`,
`packages/file-system` and desktop workspace readers.
