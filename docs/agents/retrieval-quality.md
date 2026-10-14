# Retrieval quality

## Judgments before ranking

Freeze queries and source-span judgments before measuring retrieval. Each judgment
names its path, source revision/hash, inclusive span, implementation evidence and
relevance rationale. A changed source needs judgment review. Do not derive or tune
labels from ranked output.

Judged positives are known answer spans, not exhaustive relevance labels for every
chunk. Preserve raw candidates and explain that limit when reporting precision.
Hash the entire candidate corpus separately; include every judged source, but a
corpus made only of positives does not qualify repository-wide retrieval.

## Comparable arms

Measure BM25, literal grep, trigram and vectors explicitly against the same
authorized corpus and actual model/profile/chunk policy. A missing or failed arm
makes the comparison incomplete. Preserve each source pool, score and rank; lexical
fusion and hybrid use the same lexical candidates, with trigram reported separately.

Resolve hits to exact canonical content, offsets and judged spans. A fragment on
the same line is not an answer unless it contains the frozen implementation
evidence. Production uses canonical host/parser chunks; line-policy diagnostics
remain labeled separately. Record actual model-token lengths and cap application,
not just chunker token counts.

Keep the existing fusion, rank/candidate limits and measured quality thresholds
in their executable owner. Vector promotion requires the actual comparative gain
without degrading its paired metric; a mock or an incomplete report cannot prove it.
Native scope authorization, renderer inference and consumer fusion are separate
boundaries from a package comparison and must be represented honestly.

Implementation: the repository quality fixture/adapters in `packages/agent` and
the canonical native retrieval pipeline. Related: [indexer](indexer.md).
