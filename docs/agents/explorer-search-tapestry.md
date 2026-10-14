# Explorer, search and file previews

## Data and authority

Explorer selection, loaded file content and search results are projections of
canonical roots/sources. Use acknowledged root identity and the shared content
owner; paths and cached folder IDs do not grant access. Desktop direct reads use
an explicit mounted-root capability; web reads preserve handle/permission semantics.
Late content results are generation-fenced, per-key failures remain visible, and
Retry targets the failed key instead of restarting every consumer.

Search hits retain exact file/chunk identity, source text, offsets and line ranges.
Open the actual owning file and range; do not reconstruct snippets or count an
unverified fragment as an answer. Tapestry and per-file panes use those same source
ranges. Raw file content remains ephemeral in explorer state; it is not copied
into durable selection snapshots or diagnostics. Markdown previews must not
execute content or load arbitrary external resources.

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

Decision: [ADR-0016](../adr/0016-workspace-trust-and-ignore-chain.md).
Implementation: `packages/file-explorer`, `packages/file-explorer-ui`,
`packages/file-system` and desktop workspace readers.
