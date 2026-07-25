## Catalog refreshes must preserve model enablement

**Learning:** Shipped catalog migrations can pass migration parity checks while still replacing a user's `models.is_enabled` choice through `is_enabled = EXCLUDED.is_enabled`. Historical migration checksums make those violations unsafe to edit in place.

**Action:** Keep catalog upserts on `is_enabled = models.is_enabled`. The Axiom guard rejects new overwrite assignments and count-pins the two shipped migration files until BST-667 lands a reviewed, forward-only remediation.

## Mastra stream union changes must be explicit

**Learning:** A local stream-part cast let newly introduced Mastra chunk types bypass Brainstrike's UI/persistence adapter and disappear without a diagnostic.

**Action:** Keep the static `ChunkType` inventory typed as explicit `mapped`/`ignored` decisions, reject a widened `string` union, and retain AST-anchored coded warnings at all three dispatch defaults. Unhandled dynamic-family members warn once per type per stream.
