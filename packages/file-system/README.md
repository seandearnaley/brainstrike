# @brainstrike/file-system

Platform-neutral handles, adapters, traversal and workspace-source helpers. `FileSystemAdapter`, `DirectoryHandle`, `FileHandle` and node shapes are defined in [`@brainstrike/types`](../types/src/file-system.ts).

## Capabilities

- The browser-safe root exports an explicit mock factory; it never selects a mock by default.
- Node owners import native adapters from `/electron` and path validation from `/path-validation`. Renderers use injected capabilities, never Node filesystem code.
- Reads take handles: `readDirectory(directoryHandle, options)`, `readFile(fileHandle)`.
- Optional capabilities (root management, streaming, watching, absolute-path reads) are checked, never inferred from platform or browser version.

## Root and traversal authority

- `readFileByAbsolutePath` needs a durable root ID and fully qualified root/file paths bound to the same live mount; a matching path is not authority. Native descendants stay confined by the secure-root owner.
- `/directory-tree`: shared traversal over a minimal directory-read capability.
  - Cancellation and read errors join admitted reads.
  - Preserve filtering, identity, sorting, streaming and visible truncation.
- `/workspace-root-nodes` projects granted listings into UI nodes; projection grants no read authority.
- Contract: [workspace](../../docs/agents/workspace-context.md).
