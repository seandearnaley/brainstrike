# @brainstrike/utils

Shared formatting, filtering, path, event and context helpers. Root exports and
narrow subpaths are declared in [`package.json`](package.json); implementation
ownership is routed by [`index.ts`](src/index.ts).

`formatFileSize` and `getFolderColor` remain shared display helpers. Read their
actual parameters/results rather than relying on a copied formatting result or
color table. Path helpers format/compare values; they do not authorize filesystem
access. Browser events and error helpers use their existing narrow subpaths when
a consumer needs that boundary.

Keep utilities independent of app/feature runtimes. Preserve explicit failure,
identity and cancellation contracts when composing helpers; a convenience method
must not become another durable writer, hidden retry or platform fallback.

Local consumers use `workspace:*`. Commands and dependencies come from the
manifest; [shared contribution/validation policy](../../AGENTS.md) applies.
