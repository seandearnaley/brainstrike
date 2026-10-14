# Shared mounted-directory node projection

The existing pure `workspace-root-nodes.ts` implementation moved from desktop
to the Node public entry `@brainstrike/file-system/workspace-root-nodes`.
Desktop's old module is a thin re-export. Inputs need only root ID/path data and
the existing structural directory-entry shape; they open no root and authorize
no I/O. The mounted registry remains the read/grant authority.

The extraction preserves directory-first collation, root ID/path projection,
optional zero-valued bytes/mtime, file-shaped symlink/reparse entries, the
existing 10,000 inspected-entry cap constant, and the trailing visible
truncation marker. It adds no truncation, traversal, containment or mount policy.

The built public Node artifact test starts without window/self or source aliases
and checks mixed readonly listing entries, retained zero-valued/missing metadata,
symlink shape, descriptor data and visible truncation. RED is the missing public
subpath; GREEN exercises emitted JavaScript. Existing desktop registry and read
denial cases continue to test callers of the thin re-export.

This qualifies only the projection/library seam. It does not qualify SecureRoot
opening/lease transfer, physical read/disposal, utility discovery/watchers,
main PG catalog binding, factory reset or actual app acceptance.
