# Repository retrieval quality

### Source judgments

- Freeze queries and source-span judgments before measuring retrieval. Each judgment names an exact repository path, one-based inclusive source span, implementation evidence and relevance rationale; pin its source SHA256 and source revision. Changed sources require an explicit judgment review.
- Treat this fixture as judged answer retrieval. Its positive spans are not exhaustive relevance labels for every chunk; report precision against those known answers and preserve raw candidates for review. Do not derive or tune judgments from ranked output.
- Name and hash the entire candidate corpus separately from the judged sources. Include every judged source in that corpus; a corpus of only positives does not qualify repository-wide retrieval.

Evidence: `retrieval-quality/repository-fixture.md`.
Guard: `packages/agent/src/__tests__/repository-retrieval-quality.spec.ts`.

### Comparison gate

- Run BM25, literal grep, trigram and vector arms explicitly with the same authorized corpus, pinned model revision, dtype, device, dimensions, tokenizer cap, pooling and normalization. Record actual source pools and scores; a missing or failing arm prevents a report.
- Evaluate at ranks 1, 3, 5 and 10 with the existing agent metrics, resolving actual indexer hit spans to judged answer identities. A hit must overlap the judged span and contain its frozen implementation evidence; an unrelated partial fragment on the same line is not an answer. Preserve raw source paths and spans beside metric identities.
- Use 100 candidates per arm and final top 10. The lexical comparator fuses BM25 plus literal grep; the hybrid adds vectors to those same pools. Trigram is a separate measured arm. Use the existing equal-weight reciprocal-rank contribution `1 / (60 + rank)`, with one-based source ranks and one contribution per chunk per arm.
- Retain vectors by default only when hybrid improves mean recall@10 or MRR by at least 0.05 without lowering the other metric. A mocked adapter check or an incomplete run cannot satisfy this gate.
- Record an explicit chunking policy. Production qualification uses canonical desktop host chunks with their parser, producer revision, token settings and character offsets; line-policy diagnostics remain labelled separately. Validate hit content against its exact source offsets and line ranges. Chunker token counts do not guarantee the model tokenizer cap; record uncapped model-token lengths and cap application. Root-scoped native search, real renderer inference and consumer fusion remain separately qualified boundaries.

Evidence: `retrieval-quality/repository-fixture.md`.
Guard: `packages/agent/src/__tests__/repository-retrieval-quality.spec.ts`.
