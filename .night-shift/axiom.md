## Catalog refreshes must preserve model enablement

**Learning:** Shipped catalog migrations can pass migration parity checks while still replacing a user's `models.is_enabled` choice through `is_enabled = EXCLUDED.is_enabled`. Historical migration checksums make those violations unsafe to edit in place.

**Action:** Keep catalog upserts on `is_enabled = models.is_enabled`. The Axiom guard rejects new overwrite assignments and count-pins the two shipped migration files until BST-667 lands a reviewed, forward-only remediation.
