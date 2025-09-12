# Vector Dimensions & Embedding Sets

BrainStrike stores vector metadata in the `embedding_sets` table to avoid dimension mismatches and enable safe switching between models.

Key points:

- Per‑set metadata: Each embedding set records `model_key`, `model_id`, `dimensions`, and `distance` (cosine, l2, or ip).
- Scoped operations: Chunk writes and search queries are scoped by `embedding_set_id`. This prevents mixing vectors with different dimensionality.
- Runtime validation: When generating embeddings, the pipeline validates the output length against the active set’s `dimensions` and raises if mismatched.
- Schema defaults: Although a DB column may be created as `VECTOR(768)` for a common baseline, mismatches are guarded. Use a set created for the selected model to ensure compatibility.
- Migration safety: Vector index migrations are defensive. If `VECTOR_INDEX_TYPE=ivfflat` is set, an IVFFlat index is created (with `IVFFLAT_LISTS`). Otherwise, HNSW is used with tunable `HNSW_M`/`HNSW_EF_CONSTRUCTION`, falling back to safe defaults.

Practical guidance:

- Switching models: Select or create an embedding set that matches the model’s dimensions before indexing/searching.
- Preventing errors: If you encounter dimension mismatch errors, verify the active set and the model configuration. Re‑index if needed.
- Tuning: Use `HNSW_EF_SEARCH` or `IVFFLAT_PROBES` to trade recall for speed at query time.

Related:

- README “Vector Search Tuning” section
- `packages/embeddings/src/worker/embedding-worker.ts` for set creation and validation
- `packages/db/src/repositories/file-chunk-repository.ts` for set‑scoped SQL search

