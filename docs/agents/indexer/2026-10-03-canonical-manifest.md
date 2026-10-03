# Canonical manifest verification — 2026-10-03

The scanner's eligible file inventory must qualify native completeness without inferring it from totals. `IndexerPort.verifyManifest({rootId,files:[{fileId,relativePath,contentHash}]})` compares exact canonical identities in one query-only SQLite snapshot and returns the persisted store/embedding identity plus `complete`, `missing`, `changed`, `unexpected` and `rootId`. Mismatch lists carry actual unexpected rows and expected missing/changed rows. Other authorized roots cannot influence this comparison.

The real Node26/native process test first failed because the port did not implement verification. The passing control demonstrates initially missing files, wrong identity with equal counts, different source hash, different path, exact match, foreign-root exclusion, unauthorized-root refusal, duplicate/excess/path validation, reopen preservation, and an empty manifest matching only after actual deletion. This is local native verification, not a full source scan, product cutover or platform matrix claim. No schema change, inference, hosted CI or new quarantine is introduced.

The producer still must supply the canonical complete manifest and invalidate readiness on changed, partial, truncated, error or aborted scans. The operation deliberately does not infer or persist full-scan readiness by itself.
