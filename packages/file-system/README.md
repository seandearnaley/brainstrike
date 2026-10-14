# @brainstrike/file-system

Platform-neutral handles, adapters, traversal and workspace-source helpers.
The actual `FileSystemAdapter`, `DirectoryHandle`, `FileHandle` and node shapes
are defined in [`@brainstrike/types`](../types/src/file-system.ts).

## Choose the capability

The browser-safe root exports `WebFileSystemAdapter` and explicit mock/factory
helpers. `createFileSystemAdapter(platform)` takes an explicit platform, supports
web and refuses Electron through that entry; it never selects a mock by default.
Browser access starts through the adapter's directory/root picker and retained
permission/handle path, not an `initialize()` method.

Node owners import native adapters from `@brainstrike/file-system/electron` and
path validation from `/path-validation`. Renderers consume injected authorized
capabilities instead of importing Node filesystem code. An Electron platform
label does not grant Node access or filesystem authority.

Reads take adapter handles: `readDirectory(directoryHandle, options)` and
`readFile(fileHandle)`. Optional capabilities include root management, streaming,
watching and explicit absolute-path reads. Check the actual capability; browser
support/permission is not inferred from a browser-version table.

## Root and traversal authority

`readFileByAbsolutePath` requires a durable root ID and fully qualified mounted
root/file paths bound to the same live mount. A matching path or generic
`readFileByPath` method is insufficient authority. Native descendants remain
confined by the existing secure root/validation owner.

`/directory-tree` exposes shared traversal through a minimal directory-read
capability. Cancellation and read-error rejection join admitted reads. Preserve
filtering, handle/path identity, sorting, streaming and visible truncation;
indexing callers require strict child-read errors and complete listings.

`/workspace-root-nodes` projects granted descriptors/listings into UI nodes;
projection data grants no read authority. `/workspace-scan` and its related
subpaths contain the existing scanner/coordinator contracts. Preserve watcher
health and reconciliation generations rather than treating a partial inventory
as complete source membership. Disconnect and deletion have different lifecycle
and data-retention semantics.

## Development

[`package.json`](package.json) owns entrypoints and scripts. Local consumers use
`workspace:*`; select the package's existing build/check scripts for the affected
boundary. See [workspace](../../docs/agents/workspace-context.md) and
[indexing](../../docs/agents/indexer.md) contracts.
Follow
[validation guidance](../../docs/agents/ci-quality.md).
