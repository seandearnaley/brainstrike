# Retrieval quality

Implementation: the repository quality fixture and adapters in `packages/agent`, and the canonical native retrieval pipeline. Related: [indexer](indexer.md).

## Judgments before ranking

- Freeze queries and source-span judgments before measuring retrieval; never derive or tune labels from ranked output.
  - Each judgment names its path, source revision/hash, inclusive span, implementation evidence and relevance rationale.
  - A changed source needs judgment review.
- Judged positives are known answer spans, not exhaustive relevance labels. Keep raw candidates and state that limit when reporting precision.
- Hash the whole candidate corpus separately and include every judged source. A corpus of positives alone doesn't qualify repository-wide retrieval.

## Comparable arms

- Measure BM25, literal grep, trigram and vectors against the same authorized corpus and the actual model, profile and chunk policy.
  - A missing or failed arm makes the comparison incomplete.
  - Keep each source pool, score and rank. Lexical fusion and hybrid use the same lexical candidates; report trigram separately.
- Resolve hits to exact canonical content, offsets and judged spans.
  - A fragment on the same line is not an answer unless it contains the frozen implementation evidence.
  - Production uses canonical host/parser chunks; label line-policy diagnostics separately.
  - Record actual model-token lengths and cap application, not just chunker token counts.
- Fusion, rank/candidate limits and quality thresholds stay in their executable owner.
  - Promoting vectors needs a measured comparative gain without degrading the paired metric; a mock or incomplete report can't show it.
  - Native scope authorization, renderer inference and consumer fusion are separate boundaries from a package comparison; report them as such.
