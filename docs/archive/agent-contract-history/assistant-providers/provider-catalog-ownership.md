# Provider catalog data ownership — evidence

Supports `docs/agents/assistant-providers.md` § "Provider catalog data ownership". The catalog/schema/registry split, the strict-object boundary, and the key-order enforcement.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1113-1161); append rather than
rewrite.

---

The per-provider and per-model VALUES no longer live in
`provider-registry.ts`. Ownership is split, and editing the wrong half is the
common mistake:

| File | Owns |
| --- | --- |
| `packages/assistant-contract/src/provider-catalog.json` | Every provider and model ROW: `displayName`, `authType`, `envKeys`, `deprecatedEnvKeys`, `docsUrl`, `keyFormatHint`, `keyNotes`, `capabilities`, `runtime`, and each model's `id`/`type`/`label`/`contextWindow`/`vision`/`supportsStreaming`/`defaultDimension`/`tagline`. |
| `packages/assistant-contract/src/provider-catalog-schema.ts` | The runtime validation of those rows (`parseProviderCatalog`), plus the `Parsed*` inferred types the drift test compares against the interfaces. |
| `packages/assistant-contract/src/provider-registry.ts` | The `ProviderDefinition` / `LlmModelDefinition` / `EmbeddingModelDefinition` TYPES and the accessors (`getProviderDefinition`, `findProviderDefinition`, `providerAuthType`, `findLlmModelDefinition`, …). Its `PROVIDER_DEFINITIONS` is now the parsed JSON, not a literal. |

The schema is a REQUIRED boundary, not a convenience:

- `resolveJsonModule` widens JSON literals (`"llm"` becomes `string`), so `tsc`
  no longer checks catalog rows. `parseProviderCatalog` does, once at module
  load, and THROWS with the offending `provider.model.field` path. There is no
  partial-catalog mode (repo rule: NO SILENT FALLBACKS).
- Every object is a Zod `strictObject`. A misspelled optional key used to be an
  excess-property compile error; without `strict` it would now be silently
  dropped. `_note` is the one non-runtime key (it replaces the source comments
  JSON cannot hold) and `parseProviderCatalog` strips it before any consumer
  sees a definition.
- **Adding, removing, or retyping a catalog field means editing the schema AND
  the interface in the SAME change.**
  `packages/assistant-contract/src/__tests__/provider-catalog-schema.test.ts`
  asserts mutual assignability between `CatalogShape<z.infer<…>>` and each
  interface, so one-sided drift is a type-check failure rather than a runtime
  surprise. A field added only to the interface never validates; a field added
  only to the schema is invisible to consumers.

**Catalog object keys are alphabetical at every depth, and that is enforced.**
`biome.json` re-includes this one path from the blanket `!**/*.json`, so the
file is formatted — but Biome's `useSortedKeys` assist does not reach JSON
object keys, so `findCatalogKeyOrderFailures` in
`scripts/model-catalog-migration-contract.mjs` enforces the order instead
(`pnpm lint:model-catalog-migrations`, already a CI lint). A wrong order FAILS
naming the entry; nothing is reordered for you, because a silent reorder of a
data file is an invisible change to the rows a reviewer is reading. ROW order
is deliberately unchecked: providers and models are curated (`gpt-5.6-sol`
before `gpt-5.6-terra`, `claude-opus-5` before `claude-sonnet-5`) and no
comparator derives that.

Scripts read the JSON directly rather than through the package —
`scripts/model-catalog-migration-contract.mjs`,
`scripts/gen-model-catalog-migration.mjs`, and
`scripts/__tests__/provider-env-keys-mirror-contract.test.mjs`. That is the
point of the move; do not reintroduce an AST walk over a TypeScript literal
(the BST-1143 "keep `PROVIDER_DEFINITIONS` a static array literal" rule is
retired). The DB `models` mirroring rules stay in
`docs/agents/database.md` (model catalog section).
