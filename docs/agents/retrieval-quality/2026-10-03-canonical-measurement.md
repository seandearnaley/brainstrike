# Canonical repository retrieval measurement, 2026-10-03

Supports `../retrieval-quality.md` and BST-1922. The measured retention gate **failed**: hybrid gained only 0.01 recall@10 and lowered MRR by 0.02953968. This profile/corpus does not qualify vector retention by default; the coordinator owns the product decision. All 100 queries and all four named search arms completed; no relevance label was tuned from results.

| Mode | Known-answer recall@10 | MRR |
| --- | ---: | ---: |
| bm25 | 0.58 | 0.44030159 |
| grep | 0.03 | 0.01533333 |
| trigram | 0.03 | 0.02333333 |
| vector | 0.52 | 0.34385714 |
| lexical | 0.58 | 0.44006349 |
| hybrid | 0.59 | 0.41052381 |

The frozen v1.0.0 fixture canonical SHA256 is `1b0cecbecd48ae0567ea8dc4dad2520950a51aea2ef08e64180d5ea858c1af97`; its source revision is `ed97957e030dd3345c232650199dbc88929dad24`. The corpus manifest names 3,011 tracked runtime files and exclusions, with 2,990 files outside the 21 positive modules. The actual desktop chunking host produced 37,083 chunks under maxTokens256/maxTokensCap256/overlap32/tokenTrueSizing true, using producer `5e9ed983428fbadac5e3e0915a99741b5335c9e8`. All returned contents matched their exact character offsets; no file/range was skipped. The answer matcher requires source-span overlap and the frozen evidence text within the hit.

The hidden renderer generated all corpus vectors plus 100 query vectors under model `onnx-community/all-MiniLM-L6-v2-ONNX`, revision `aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f`, fp16, 384dimensions, token cap256 including special tokens. Actual producer environment was WebGPU Applemetal-3/shader-f16/nonfallback, mean pooling, L2 normalization and production launch flags. All finite float32 vectors have norm within 0.000001 of 1. Uncapped vendor token lengths recorded 12,477 corpus inputs above 256 (max 606); query max 24. The worker cap was applied explicitly. This is the existing canonical chunker with a different model tokenizer, not a token-equivalence assertion.

The real native IndexPort accepted original `providedChunks` with complete metadata, prepared stable plan IDs, committed actual vectors and reopened its fresh schema 2 WAL database before searching. It ran with repository-pinned Node 26.8.2 and explicit 5s startup/request/close/exit deadlines. Native embedding identity follows ADR0018 exactly: `[modelId,revision,dtype,dimensions,tokenCap]`, hashed by its exported `embeddingProfileHash`; value `60a05b1084b11c2add2e01bb8112960f51e83e68c88ad4151b0dc54eb69e1914`. Device/pooling/normalization remain separately measured environment fields, with no claim of cache equivalence. The canonical native producer was committed as `a03a8fec26f9cac50505df6af92ad38f9150b960`. Every recorded indexer source/emitted-JS hash matches the measurement runtime exactly; `native-runtime-before.json` and `native-runtime-after.json` preserve that verification.

Each arm supplied up to 100 candidates; final output is top 10. Native BM25 uses its OR-term porter/unicode61 expression and native rank order. Grep uses the existing public `createGrepLineMatcher(query,false,false)` over canonical chunk lines, full frozen query, case-insensitive per-line literal match, stable path/chunkIndex order and one candidate per chunk; it does not use native SQL grep. Trigram is independently queried, never substituted for grep. Vector uses the indexer's binary coarse 100/root candidates and exact cosine rescoring. Lexical combines BM25+grep; hybrid adds vectors to the identical pools with equal-weight historical RRF 60.

Durable artifacts: `/Users/seandearnaley/Documents/brainstrike-retrieval-evals/bst-1922-2026-10-03`, including source snapshots, corpus manifest, canonical DTOs, exact model profile, raw input-token/batch metadata, finite 384float32 vectors, plan-ID joins, reopened native info, all 400 raw candidate pools and the full report. `retrieval-report.json` SHA256 is `38a72d1b962ba31fb2575488790c4c44e86473ddd1c8dd98cf3ea408e84cbac2`; `raw-search-pools.jsonl` SHA256 is `87cb140f86c417a476ba940dd1d9d334f991298423980631e393ee3e7f53feb8`. `measurement-integrity.json` records further hashes and reproduction scripts. Scripts preserve the frozen labels and refuse profile/source/metadata drift. Candidate search durations include adapter evidence writes; they do not claim consumer latency. This is a measured retrieval decision, not a matched historical throughput or full real-app M2 acceptance claim. Hosted CI and remote publication remain disabled.

## Evaluation delivery replay

The finalized fixture, adapter and guards come from `8ae0ff1aa45c7f442cba0dd47f4aefce9ff9c86c` plus the answer-evidence matcher correction `fda44fa002fb8e7630f386d46b43c1b0afbf03ec`; this report comes from `a8d7af548469f09789759c139e85d81c1de0e0bb`. Their coherent delta is replayed onto integration parent `2f40af8195f2fee4d56c96770def9c943fbd3549`. The fixture, adapter, tests and measured numbers remain unchanged. All 21 judged source files are unchanged between the fixture revision and this integration parent, so no judgment review or source adaptation is needed.

The measured index runtime remains producer `a03a8fec26f9cac50505df6af92ad38f9150b960`, schema 2. This delivery does not remeasure the current schema 6 runtime or rerun model inference. The package's `eval:retrieval` CLI uses synthetic vectors and cannot reproduce this recorded measurement. The focused guard exercises fixture integrity, source/offset refusal, answer matching, fusion and metric thresholds; its mocked candidate pools do not constitute a new quality measurement.

The failed gate preserves workspace search's text default and explicit vector opt-in. Initial native index mode is null and requires a first saved mode choice; VECTOR additionally requires an explicit saved local execution selection. Disabled vector retrieval preserves existing profiles and vector data. This delivery changes no runtime search defaults or settings.

Delivery validation on 2026-10-04: `pnpm --filter @brainstrike/agent exec vitest run src/__tests__/repository-retrieval-quality.spec.ts` passed all 13 structural cases. `pnpm exec turbo run type-check --filter=@brainstrike/agent --concurrency=2` passed all 17 tasks (15 cached), including agent source/test types. Required scoped `pnpm dlx ultracite fix` passed without fixes. These checks do not recompute the recorded retrieval metrics; normal commit-hook results are reported with the delivery head.

CI is disabled due to cost; validation must run locally.
