# M3 host acceptance evidence — 6 October 2026

This is the integrator's evidence ledger for BST-1977, not an acceptance declaration or a replacement for the living contracts/ADRs. One milestone candidate remains stacked directly on M2 #3542. Main/M2 remain frozen; legacy deletion, signing, release, hosted CI and automated reviews remain outside this work.

CI is disabled due to cost; validation must run locally.

## Acceptance matrix

| Required outcome | Current evidence | Remaining acceptance gap |
| --- | --- | --- |
| Electron-free Node owns the root/run/log | Real Node host, root lease, SQLite worker writer; 12 host integration checks | Ordinary CLI spawning and desktop utility-process launch of the same configured host |
| One authenticated protocol | Socket, vendor stdio framing, Node/Electron MessagePort; wrong token refused | Standalone stdio host process qualification and ordinary desktop attachment |
| CLI and GUI share committed truth | Actual CLI subprocess and Electron panel perform approval/file write/native keyword search; close/reopen renderer replays the same log | Panel is exercised in an owned proof window; ordinary new-thread route must bypass the HTTP assistant path |
| One permission authority | Approve/deny; explicit deny beats YOLO/session grant; parallel calls answered by two clients; generation identity checked | Canonical native/MCP executor composition and full existing policy/configuration parity |
| Stop and cleanup join physical work | Native child exits before Stop acknowledgement; Electron/indexer exit, root released, host record removed, SQLite reopened | Product host lifecycle/MCP authority close reports and ordinary client loss/stop paths |
| Restart continues from committed context | Public SDK user-approval pause, complete SDK step messages, fresh model continues same run; accepted response and native effect deduplicate | Separate-process crash matrix, provider reasoning/media replay, product restart route; Windows packet awaits authorized transfer |
| Large outputs/context are durable | Real repository document tool output uses StateStore content-addressed spooling at the existing 12 KiB boundary; replay and subsequent model context survive reopen | Large canonical MCP Apps/media/provider outputs and full product reset/export proof |
| Existing model-step limit/accounting | Final approved effect executes without another model request at the supplied step limit; SDK per-step usage/model metadata committed | Existing pricing, model/context settings, OM observer accounting and credential selection parity |
| Existing MCP authority is preserved | Reviewed borrowed adapter integrated; 22 focused checks; no new client/registry/gate | Supply canonical executable schema/generation bindings; real Tasks/Apps rich results, cancellation, authority physical cleanup |
| Native CLI retrieval | Actual separate native SQLite indexer process performs BM25 in the composed proof | Canonical CLI BM25/trigram/grep adapters; existing scope/read-authority vs completeness semantics |
| Semantic/hybrid parity | Working M2 path preserved; no fake vectors, model restrictions or provider fallback added | New host consumes authoritative saved profile/query plan and off-lane embedding capability; demonstrate real assistant results |
| Public Mastra memory only | Repository-pinned memory 1.32.1/core peer 1.71.0 installed for the library adapter; no Mastra Agent/server introduced | OM/working memory/recall, host-owned storage projection, cancellation/join and accounting |
| Provider/credentials/context/setting parity | Pinned AI SDK 7.0.126 scripted provider-v4 runtime payloads and committed history | Real-account provider replay needs approved bounded spend; canonical secrets/settings/native content adapters remain required |
| M3 child-aware contracts | Run identity is explicit in every effect/decision; optional parent-run metadata exists | Complete agreed ownership/interaction schema now; full child migration remains M4 |
| Full regression and loaded performance | Focused checks below pass; no new retry/timeout/scheduler/budget | Full regression is not green; known M2 startup/scan/loop-stall and baseline fixture/authority/Electron assertion failures remain separate |

## Current local checks

Use qualified Node 26.8.2 and `pnpm_config_verify_deps_before_run=error`.

- `pnpm --filter @brainstrike/agent-host test:integration`: 12 passed; final run 3.04 s total, 2.401 s tests.
- `pnpm --filter @brainstrike/agent-host test`: 26 passed (22 MCP adapter plus 4 recorded-log projection checks); 0.638 s.
- `pnpm --filter @brainstrike/agent-host build` and `type-check`: passed.
- `pnpm --filter @brainstrike/desktop exec vitest run --config vitest.integration.config.mts src/__tests__/agent-host-view.integration.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism`: passed; context packet 3.66 s total, 2.622 s test.
- Normal commit hooks run the repository secret scan, scoped Ultracite, build/type graph and commit message checks. They do not constitute full regression.
- `pnpm check`, `pnpm check --full`, full E2E/coverage and real-account provider replay have not been claimed for this candidate.

## Preserved proof receipts

- Initial composed checkpoint `7f912714530a65299e1b917b80e1e622102995a7`: `/tmp/brainstrike-m3-composed-proof/` (31 rows, native WAL writer, three model calls, joined cleanup).
- Context/continuation packet: `/tmp/brainstrike-m3-context-composed-proof/` (37 committed rows, three model calls, separate native WAL writer; receipt, committed log, screenshot and joined cleanup), with `/tmp/brainstrike-m3-context-composed-final.log`.
- Initial 15-second failure remains in `/tmp/brainstrike-m3-composed-test.log`; vendor diagnosis is `/tmp/brainstrike-m3-composed-diagnostic.log`. The fixture incorrectly bound positional arguments at Electron startup (`app.setPath`: path must be absolute). Named owned-root/HTML/preload/thread environment inputs fixed the fixture. The test deadline was not increased.
- MCP source packet `b447af742db576a1df40c9c2b1e475b4972536b0` was verified on its parent-authorized remote branch and integrated. Borrowed executor settlement is not physical MCP authority cleanup proof.
- Windows' separate four-test receipt is delegated evidence, currently unmerged. Its restricted-token ACL failure remains separate from the successful ordinary-user run; a denied publication route is not bypassed.

Full M3 acceptance requires every gap above to be resolved or explicitly decided by the owner. This ledger adds no new gate or exception to the repository rules.
