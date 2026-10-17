# Effect 4 adoption qualification — 17 October 2026

This is historical evidence for the nine-wave Linear project, not a new gate list.
Source basis after E08: `092a2c390b7580b3e7feed49a00a252d551ddc9f`. Effect 4.0.5 and
@effect/tsgo 0.53.1 stayed pinned. CI remained disabled; every receipt below is local.

## Wave receipts

| Wave / ticket | Delivery | Demonstrated acceptance |
| --- | --- | --- |
| E01 / BST-2044 | [#3758](https://github.com/seandearnaley/brainstrike/pull/3758), head `7dcc7b01a` | Search/artifact parity and provider projections: 88 contract, 74 agent, 17 supersession, 46 desktop and 17 provider cases; actual multibyte grep → artifact paging → reload, 20.0s |
| E02 / BST-2045 | [#3761](https://github.com/seandearnaley/brainstrike/pull/3761), head `022a973ee` | Workspace/skill inputs and actual SDK registration: 95 contract, 179 agent, 35 host, 17 provider cases; actual read/write, malformed refusal, question/plan resume, edit denial and reload |
| E03 / BST-2046 | [#3762](https://github.com/seandearnaley/brainstrike/pull/3762), head `775eee487` | Host grammar and composed receivers: 716 host unit, 41 host integration, two app flows; attach/auth/refusal/run/stop/reopen/replay. Full build 63/63 (53.42s), type 128/128 (51.842s) |
| E04 / BST-2047 | [#3763](https://github.com/seandearnaley/brainstrike/pull/3763), head `b4934db80`; clean verifier correction [#3766](https://github.com/seandearnaley/brainstrike/pull/3766), head `1ace1f3e` | MCP task schemas/callable Standard Schema: 942 task cases including 902 parity, 42 agent integration, 13 desktop integration, actual pending-input cancel plus completed positive control. Six selected protocol-lab cases, expected RED then GREEN/verification, cleanup/no blockers; clean derived-output run 2.61s. Limited profile, not full upstream official conformance |
| E05 / BST-2048 | [#3767](https://github.com/seandearnaley/brainstrike/pull/3767), head `596b2f787` | Frozen 46 owner/consumer files and actual closure; 618 shared + 312 wire parity; contract suite 1,781; real OS-fenced Python/PGlite reopen 12; desktop host/command/process integration; four actual app flows in 18.5s. Full build 63/63 (40.98s), type 128/128 (26.04s) |
| E06 / BST-2049 | [#3759](https://github.com/seandearnaley/brainstrike/pull/3759), head `1f5d5000c` | Typed failures versus synchronous defects, retained cleanup causes; 79 lifecycle, 24 Effect helper and 42 token-cache cases with virtual-clock deadlines/retry; actual TEXT configure → pause/resume → shutdown |
| E07 / BST-2050 | [#3768](https://github.com/seandearnaley/brainstrike/pull/3768), head `1611ea6e8` | Existing Logs timeline, all four Effect exits, parent propagation, cleanup join and privacy: 94 selected desktop and 53 kit cases; actual pause/trace search/details 1/1 in 9.4s. Observed 26 records with completion parent preserved. Final full build 63/63 and type 128/128 |
| E08 / BST-2051 | [#3769](https://github.com/seandearnaley/brainstrike/pull/3769), head `84f04da19` | Wrong-kind fault RED/repair; 25 focused query and 65 current desktop manager/runtime/scope cases. Unmodified native runner: 13/3 files in 10.49s plus Electron utility proof; actual exit joined, writer reacquired, fresh reader, deadline identity retained. Full build 63/63 (38.287s), type 128/128 (13.985s) |
| E09 / BST-2052 | [ADR-0024](../adr/0024-effect-adoption-service-and-rpc-boundaries.md) and [ownership census](../agents/effect-schema-migration.md) | Current source census, stable/unstable API inspection, explicit service/RPC recommendations and receipt reconciliation; documentation/inventory checks, prior unchanged-source qualification reused |

Normal hooks and strict Effect diagnostics ran. The last runtime wave's full build and
type check passed with zero errors/warnings; informational diagnostics remain visible.
The 18 Effect boundary guards and the actual preload value-graph guard passed in the
relevant waves. E07 requalified the changed shared runner and actual physical pause;
E08's 65 cases rechecked current main's manager/runtime/binding-convergence inputs.

## Corrections and scope

E03's URL conversion initially lost the HTTP/HTTPS restriction. E04 restored it with
negative scheme cases; unsafe integer validation was already provided by Schema.Int.
E04's standalone verifier initially omitted its transitive contract build; #3766
reproduced and repaired that clean-checkout failure. A stale generated contract output
also reproduced the owner's four main-build type errors; refreshing that derived
output/cache restored actual main build, types and isolated dev startup without a
tracked source change.

E05 pinned inherited child checks, enum-object inference, optional/undefined behavior,
protocol diagnostic location and port identity. Its old admission snapshot failed
identically before E05: only six equivalent JSON Schema forms changed; refreshing those
fragments retained exact comparison. The app-shell compound selector invocation passed
3,147 unit tests but exited 1 on an empty compiled selector; the separate actual compiled
lane then passed 2/2. These were reported as separate outcomes, not a full compound pass.

E07's matched 100-operation parent/child/checkpoint fixture exported five events per
operation: native tracer 1.845ms, diagnostic tracer 1.427ms. The negative 0.419ms delta
is warm-up/noise, not a speedup or SLA. The actual empty-collection pause span took
2.666ms. Its exported metadata omits raw error text, settings, paths, prompts and
credentials; bounded independent-failure counts and truncation remain visible.

E08 retained the simpler query owner under the ticket's explicit no-refactor option.
Scope/Deferred did not remove correlation or retryable physical-termination state.
The fixed request validates before releasing correlation. Native utility evidence used
four processes: canonicalGrep, freshHost, writerLock and retainedDeadlineIdentity true;
Stop joined actual exit in 4.518ms, and the parent remained responsive.

## Limits and next work

Qualification is macOS arm64: shell Node26.10.0, pnpm-managed Node26.8.2, Electron44.8.0
with Node24.22.0; E08 SQLite3.53.4. Disposable profiles/indexes and fake credentials were
used. The Python integration exercised an explicit installed system interpreter; the
existing missing bundled archive warning does not qualify a packaged Python runtime.
Windows/Linux, packaged artifacts and live paid-provider behavior were not qualified.
No full repository test/coverage or full upstream MCP conformance claim is made.

The final census has 25 production Zod import files: nine vendor format patterns,
five SDK adapters/types, six offline qualification tools, two protocol reference modules
and three web modules. Two additional JS server files are test fixtures. There are 26
pure IPC contract modules with no Zod import that remain runtime-free parsers. The E05
ledger's date-pattern category incorrectly included mcp-host SDK types and the Tasks SDK
composition; E09 corrects those categories without changing the total or production code.

Service/RPC/global-runtime replacement remains a future explicit decision. The existing
maintenance Layer and native executor constructor stay; the host/MCP/durable/preload
owners stay. ADR-0023's separate producer representation work is not implemented by this
schema adoption. Continue from the named owning contract and authorized outcome; current
protocol version 11 has 81 methods and 81 results, rather than relying on the dated HTML
report's import totals.
