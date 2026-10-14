# Assistant provider probe lifetimes

Supports `docs/agents/effect-boundary.md` § "Shared helpers" and
`docs/agents/assistant-providers.md` § "Credential-verification probes".

## Decision (2026-09-25, BST-1830)

The credential-verification and selected OpenRouter model-metadata probes use
one Effect deadline over fetch and body reading. Both continue to expose their
Promise APIs and call `runAtPromiseBoundary` once per request. The fetch signal
is interrupted at the deadline; a transport that ignores abort cannot keep the
single-flight entry pending. A signal check after each await stops late fetches
before body reading and late bodies before parsing or cache publication. Late
Promise settlements remain observed.

Credential verification keeps its existing HTTP verdicts, status-only failure
details, success/failure TTLs, and completion-time cache timestamp. Metadata
keeps its exact-model validation and `live`/`fresh-cache`/`stale-cache`
provenance. An expired snapshot is returned only with a warning after refresh
failure, while a first failure remains visible. Neither probe retries. The
pre-existing credential and model cache keys are unchanged.

## Qualification

The clean base is `57f256a07`. Before the change, the canonical desktop build
produced `main.js` at 2,702,411 raw bytes and 575,799 bytes with `gzip -9`.
Four RED regressions hung past a 5 ms deadline when fetch or body reading
ignored abort. The corresponding GREEN tests prove the deadline settles,
aborts the fetch signal, clears single-flight, preserves completion-time TTL,
retains stale metadata with its original timestamp, and fences late body data.
The focused suites pass 55 tests across two files; the Effect and contract-budget
guards pass 21 checks. The canonical candidate desktop build passes 50 tasks
and produces `main.js` at 2,704,577 raw bytes and 576,122 bytes with `gzip -9`
(+2,166 raw / +323 gzip). Desktop type-check and Effect diagnostics pass with
zero errors or warnings. Ultracite check passes; its 16 warnings are outside
this change.

An isolated in-memory OpenRouter metadata benchmark ran 550 calls for each
implementation, discarding 50 warmups. The baseline median/p95 was
0.003209/0.007000 ms; the Effect candidate was 0.009542/0.017792 ms.
The roughly 0.006 ms median increase measures only the request boundary,
without network or JSON parsing. The assistant-server endpoint integration
suite also passed 32 tests, covering the HTTP-facing response mapping.
