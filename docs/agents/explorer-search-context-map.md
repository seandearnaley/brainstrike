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

A thread's direct subagents are lanes of its Context tab (BST-2021). The host
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
file readers; refusal is not empty content. Mutation permissions remain their
separate contract—hard read ignores are not a claimed write sandbox.

Bounded traversal reports truncation and unverifiable coverage honestly. An
excluded-path probe must itself honor hard ignores. Canonical indexing receives
unchanged parser/chunker output; [indexer](indexer.md) owns publication and
coverage, not the preview UI.

## Live refresh

Use the existing watcher capability and event channel. Desktop keeps one Parcel
subscription per owner/resolved root with independently disposable logical IDs;
unsupported engines fail rather than falling back. Missing web observation is
visibly unwatched. Do not add polling to disguise it.

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
