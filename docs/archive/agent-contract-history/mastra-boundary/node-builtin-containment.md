# R2 Node-builtin containment — evidence

Supports `docs/agents/mastra-boundary.md` § "R2 NODE-BUILTIN CONTAINMENT
(CRITICAL) — NEW". Read this before touching either browser bundle's vite
externals. Corrected 2026-09-21: the single named chunk below
(`chunk-77JDY5O7.js`) does not exist at the installed 1.64.0 — the dist is
content-hashed per module group and the builtin imports are now spread across
several shared chunks (`agent-DsRUDsS_.js`, `workspace-smVhYwIC.js`,
`provider-registry-*.js`, `filesystem-versioned-*.js`, `tools-*.js`). Re-traced
by following the static import graph from `@mastra/core/agent`, `/mastra` and
`/workspace`: all three still reach `fs`, `fs/promises`, `child_process`, `os`,
`path`, `path/posix`, `module`, `url`, `stream`, `stream/web`, `string_decoder`
and `crypto`, so the ruling stands unchanged. The web external is now
`apps/web/vite.config.mts:95`; cite the file, not the line.


**`@mastra/core` may only be imported where Node builtins exist. It must stay
externalized in every browser bundle.**

`chunk-77JDY5O7.js` — imported by `@mastra/core/agent`, `@mastra/core/mastra`, **and**
`@mastra/core/workspace` — statically imports `fs`, `fs/promises`, `child_process`,
`os`, `path`, `path/posix`, `module`, `url`, `stream`, `stream/web`,
`string_decoder`, and `crypto`. There is no browser-safe entry point.

The guard that already enforces this is `apps/web/vite.config.mts:85`:

```ts
external: ['electron', '@mastra/core', /^@mastra\//]
```

This was previously implicit. It is now a contract: **breaking it is silent at
build time and fails only at runtime in the browser**, which is why it gets a test
rather than a comment.

This constraint — not auth, not CORS — is the real limit on how much Mastra can
absorb. It is also why R3 and R4 resolve the way they do, and it composes with the
existing renderer-only inference invariant in `docs/agents/local-inference.md`:
Mastra sits on the Node side, local inference sits on the renderer side, and
neither crosses.

