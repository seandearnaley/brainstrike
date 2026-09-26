# Worker envelope Schema evidence

Supports `effect-boundary.md` § "Schema at boundaries" (BST-1834).

The shared envelope and request-base validators serve chunking, embedding, and LLM host protocols. The previous root module checked six envelope types, three non-empty identifiers, and a non-array object payload in a fixed order. It returned the original candidate and payload objects; an array with valid own fields was accepted as a root. Host tests pin contextual `Error` messages. A full `Schema.Struct` decode in pinned Effect rc.117 rejects array roots and copies/strips accepted objects, so it cannot replace this boundary without a behavior change.

The validators now use cached Schema field predicates from typed `Schema.Struct` definitions. The non-empty-string check calls JavaScript `trim()` inside `Schema.makeFilter`, preserving whitespace behavior and original values. The root and payload shape checks remain explicit for legacy array-root and arbitrary non-array-object acceptance. The validator subpath is imported by three host-shared modules; the broad worker-runtime root does not load Schema. Preload reaches those modules only through erased type imports. The package root is used by visible renderer and worker clients, so the subpath keeps Schema out of that broad root graph.

The compatibility tests pin error class and exact sentence order, all six type literals, dynamic request kinds, whitespace, array roots, extra keys, arbitrary object payloads, and reference identity. The two-way compile-time schema/interface check also compares key sets so adding an optional field on only one side fails type checking. The paired contract test checks exports and direct imports; the existing desktop preload import-graph test supplies the transitive check.

This `Schema.is` boundary intentionally throws its existing contextual plain `Error` sentences from code; predicate calls do not surface decoded Schema issues, so field `message` annotations would be unused. Decoder boundaries still annotate their field messages and use `makeThrowingDecoder`, with the documented Python domain-error adapter.

## Verification (2026-09-26)

Baseline: `b5776b8cc69ea29567b02f4bb5ec157ed2552a9d`, after the transactional embedding admission PR. The implementation changes validation ownership and adds schema/interface drift detection; it does not claim the previous guards accepted invalid messages.

- Worker-runtime: 60 tests passed, including existing root-module tests and the new compatibility table. TypeScript and strict Effect diagnostics passed.
- Desktop: 75 existing tests passed across the three host-shared protocols, their IPC handlers, both preload guards and main build configuration. Source-alias and tsconfig registry guards: 28 passed.
- Effect and contract-budget guards: 25 passed. The Effect contract retains its 105-line pin.
- Removing the `status` literal failed the acceptance table; adding an optional interface-only field failed compilation; reversing request/runtime ID checks failed error precedence. Adding an Effect value re-export to the package root failed the dedicated import guard. All mutations were restored before final validation. The initial missing-subpath failure was scaffolding evidence only.
- Both app builds passed their cross-chunk cycle checks, and the main build passed the actual preload bundle guard. A CommonJS consumer resolved the compiled package subpath and preserved candidate identity.

## Bundle and runtime cost

Clean baseline and candidate builds use the same checkout and toolchain. JavaScript totals sum individual `.js`, `.mjs`, and `.cjs` assets; gzip is Node zlib level 9 per file. Startup is the HTML entry/module-preload static import closure, not a browser timing measurement.

| Surface | Baseline raw / gzip bytes | Candidate raw / gzip bytes | Delta raw / gzip bytes |
| --- | --- | --- | --- |
| Desktop renderer, all 401 chunks | 22,538,974 / 5,219,158 | 22,571,703 / 5,222,072 | +32,729 / +2,914 |
| Desktop renderer startup, 81 chunks | 10,137,425 / 2,185,049 | 10,208,733 / 2,200,014 | +71,308 / +14,965 |
| Web renderer, all 416 chunks | 17,760,368 / 4,937,972 | 17,760,368 / 4,937,972 | 0 / 0 |
| Web startup, 3 chunks | 16,268 / 6,461 | 16,268 / 6,461 | 0 / 0 |
| Desktop main bundle | 2,714,307 / 579,402 | 2,714,569 / 579,454 | +262 / +52 |

Both preload bundles and the other five main-process entry outputs are unchanged. Main externalizes packages, so its small bundle delta does not measure the separately loaded Schema package. Desktop visible and hidden hosts share one static renderer entry: the 14,965-byte gzip startup increase applies to that shared graph. The larger startup delta than total delta reflects shared chunks moving into the static closure. The worker-runtime root itself remains Effect-free; this does not imply the desktop entry avoids Schema.

The measured desktop startup increase is 0.685% of its baseline gzip closure. That cost is accepted for one Schema-owned set of field predicates and compile-time schema/interface drift checks shared by three host protocols, while keeping the package root and preload graph clear. Effect is allowed in renderers; the separate roughly 74 KB brand-decoding cost in the contract is a reason to keep renderer-minted IDs as type-only brands, not a blanket renderer ban.

A synthetic Node 26.10.0 probe warmed each validator with 10,000 calls, then measured three samples of 100,000 valid calls while asserting original candidate/payload identity. Envelope baseline samples were 3.874 / 3.222 / 3.172 ms; candidate samples were 15.063 / 12.849 / 12.905 ms. Request baseline samples were 1.725 / 1.292 / 1.333 ms; candidate samples were 3.486 / 2.957 / 3.013 ms. Schema adds validation overhead. These are diagnostic loops, not end-to-end IPC latency, cold application startup, or a throughput improvement claim.
