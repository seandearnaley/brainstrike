# Embedding queue factory registration — evidence

Supports `docs/agents/local-inference.md` § "Embedding queue factory
registration". Read before adding an implicit bootstrap to `getBrowserQueue()`
or changing how a panel scopes its own factory. The restore-on-unmount rule is
the "semantic search breaks after visiting the Database tab" regression.

## Original text

Embedding queue factory registration (visible renderer):
- `TransformersBackend.initialize` (local-model semantic search, prompt-library
  embedding, …) requires a queue factory registered in
  `@brainstrike/embeddings/runtime-config` — there is deliberately NO implicit
  bootstrap in `getBrowserQueue()` (it throws "Embedding queue factory is not
  registered"). The owning platform must register explicitly at startup:
  - Web: `registerWebEmbeddingRuntimeConfig()` (apps/web/src/create-embedding-queue.ts),
    called from the web root layout's mount effect.
  - Desktop: `registerDesktopEmbeddingRuntimeConfig()`
    (apps/desktop/src/renderer/create-embedding-queue.ts), called from the
    desktop root layout's mount effect.
  Both register the streaming worker URL plus a LAZY factory — the workerpool is
  only constructed on first use.
- `DatabaseDemoPanel` scopes its own queue factory over the app-level one while
  mounted and RESTORES the previous factory on unmount (never resets to null
  over an app-level registration — that was the "semantic search breaks after
  visiting the Database tab" regression). Proof: database-demo-panel.test.tsx +
  create-embedding-queue.test.ts (web + desktop) + root-layout-content.test.tsx.
