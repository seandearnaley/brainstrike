# M3 host acceptance evidence — 6 October 2026

This is the integrator's evidence ledger for BST-1977, not an acceptance declaration or a replacement for the living contracts/ADRs. One milestone candidate remains stacked directly on M2 #3542. Main/M2 remain frozen; legacy deletion, signing, release, hosted CI and automated reviews remain outside this work.

CI is disabled due to cost; validation must run locally.

## Acceptance matrix

| Required outcome | Current evidence | Remaining acceptance gap |
| --- | --- | --- |
| Electron-free Node owns the root/run/log | Separate Node 26.8.2 process, configured CLI spawning, root lease and SQLite worker writer; 17 host integration checks | Canonical provider/profile platform selection and desktop utility-process launch of the same host |
| One authenticated protocol | Actual separate-process stdio and socket clients share the same authenticated dispatcher; Node/Electron MessagePort and wrong-token checks pass | Ordinary desktop attachment and launch composition |
| CLI and GUI share committed truth | Actual CLI subprocess and Electron panel perform approval/file write/native keyword search; close/reopen renderer replays the same log | Panel is exercised in an owned proof window; ordinary new-thread route must bypass the HTTP assistant path |
| One permission authority | Approve/deny; explicit deny beats YOLO/session grant; parallel calls answered by two clients; generation identity checked | Canonical native/MCP executor composition and full existing policy/configuration parity |
| Stop and cleanup join physical work | Actual CLI Stop joins a separate native child; client SIGKILL/reconnect preserves the host; failed starter joins and releases its store; losing root contender constructs no second platform; Electron/indexer exit, root released, host record removed, SQLite reopened | Desktop product lifecycle/MCP authority close reports and the remaining fault matrix |
| Restart continues from committed context | Public SDK approval pause and complete SDK step messages; actual CLI starts a fresh host at the committed decision and executes the native effect once | Abrupt-process crash matrix, provider reasoning/media replay, ordinary GUI restart route; Windows packet awaits authorized transfer |
| Large outputs/context are durable | Real repository document tool output uses StateStore content-addressed spooling at the existing 12 KiB boundary; replay and subsequent model context survive reopen | Large canonical MCP Apps/media/provider outputs and full product reset/export proof |
| Existing model-step limit/accounting | Final approved effect executes without another model request at the supplied step limit; SDK per-step usage/model metadata committed | Existing pricing, model/context settings, OM observer accounting and credential selection parity |
| Existing MCP authority is preserved | Borrowed adapter integrated; 22 focused checks; independent immutable-source review found no reproducible issue in its two-file scope (source-only evidence); no new client/registry/gate | Supply canonical executable schema/generation bindings; real Tasks/Apps rich results, cancellation, authority physical cleanup |
| Native CLI retrieval | Actual separate native SQLite indexer process performs BM25 in the composed proof | Canonical CLI BM25/trigram/grep adapters; existing scope/read-authority vs completeness semantics |
| Semantic/hybrid parity | Working M2 path preserved; no fake vectors, model restrictions or provider fallback added | New host consumes authoritative saved profile/query plan and off-lane embedding capability; demonstrate real assistant results |
| Public Mastra memory only | Repository-pinned memory 1.32.1/core peer 1.71.0 installed; no Mastra Agent/server introduced. Worker found no caller cancellation handle on public turn orchestration; `settled()` alone does not fence admission or join async accounting writes | Parent owns architectural resolution. OM/working memory/semantic recall, host-owned storage projection, cancellation/join and accounting remain required |
| Provider/credentials/context/setting parity | Pinned AI SDK 7.0.126 scripted provider-v4 runtime payloads and committed history | Real-account provider replay needs approved bounded spend; canonical secrets/settings/native content adapters remain required |
| M3 child-aware contracts | Run identity is explicit in every effect/decision; optional parent-run metadata exists | Complete agreed ownership/interaction schema now; full child migration remains M4 |
| Full regression and loaded performance | Focused checks below pass; no new retry/timeout/scheduler/budget | Full regression is not green; known M2 startup/scan/loop-stall and baseline fixture/authority/Electron assertion failures remain separate |

## Current local checks

Use qualified Node 26.8.2 and `pnpm_config_verify_deps_before_run=error`.

- `pnpm --filter @brainstrike/agent-host test:integration`: 17 passed; final root-before-platform run 7.85 s total (five process checks 4.638 s, twelve core checks 2.467 s).
- `pnpm --filter @brainstrike/host-lease exec vitest run --config vitest.integration.config.mts __tests__/process.integration.test.ts __tests__/start-orders.integration.test.ts`: 6 existing real-process lifetime/contention checks passed; 8.59 s total.
- `pnpm --filter @brainstrike/agent-host test`: 26 passed (22 MCP adapter plus 4 recorded-log projection checks); 0.638 s.
- `pnpm --filter @brainstrike/agent-host build` and `type-check`: passed.
- `pnpm --filter @brainstrike/desktop exec vitest run --config vitest.integration.config.mts src/__tests__/agent-host-view.integration.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism`: passed; launch packet 3.38 s total, 2.596 s test. Set `BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH` to the already-qualified read-only executable; the worktree does not contain its own binary.
- Normal commit hooks run the repository secret scan, scoped Ultracite, build/type graph and commit message checks. They do not constitute full regression.
- `pnpm check`, `pnpm check --full`, full E2E/coverage and real-account provider replay have not been claimed for this candidate.

## Preserved proof receipts

- Initial composed checkpoint `7f912714530a65299e1b917b80e1e622102995a7`: `/tmp/brainstrike-m3-composed-proof/` (31 rows, native WAL writer, three model calls, joined cleanup).
- Context/continuation packet: `/tmp/brainstrike-m3-context-composed-proof/` (37 committed rows, three model calls, separate native WAL writer; receipt, committed log, screenshot and joined cleanup), with `/tmp/brainstrike-m3-context-composed-final.log`.
- Standalone process packet: `/tmp/brainstrike-m3-process-proof/`. Native Stop receipt: host PID 76432, test PID 76430, native child PID 76536, six distinct CLI PIDs, Node 26.8.2 and no Electron runtime. Restart receipt: three distinct host PIDs, one native effect and 28 committed rows. All owned hosts/children joined and their roots released. The configured module is an explicit trusted composition seam; the fixture does not establish canonical provider/profile/tool parity.
- Final root-before-platform receipts: `/tmp/brainstrike-m3-process-root-first-proof/`; final Electron receipt/screenshot/cleanup: `/tmp/brainstrike-m3-process-electron-proof/` (37 rows). `/tmp/brainstrike-m3-process-electron.log` preserves the failed recheck that omitted the qualified Electron executable; `/tmp/brainstrike-m3-process-electron-qualified.log` records the corrected invocation. No dependency reinstall, deadline increase or product fallback was used.
- Initial 15-second failure remains in `/tmp/brainstrike-m3-composed-test.log`; vendor diagnosis is `/tmp/brainstrike-m3-composed-diagnostic.log`. The fixture incorrectly bound positional arguments at Electron startup (`app.setPath`: path must be absolute). Named owned-root/HTML/preload/thread environment inputs fixed the fixture. The test deadline was not increased.
- MCP source packet `b447af742db576a1df40c9c2b1e475b4972536b0` was verified on its parent-authorized remote branch and integrated. Borrowed executor settlement is not physical MCP authority cleanup proof.
- Windows evidence remains delegated and unmerged. At exact `161393b`, the twelve core cases and three unchanged ownership cases passed; the reconciled restart case then passed separately. This was not one fresh four-case run at the final overlay. Its nineteen recorded owned identities exited. The restricted-token ACL failure remains separate from ordinary-user execution. Source transfer is under the parent's publication-approval hold; no bypass is used. Later launch/spawner changes still need exact-source Windows requalification.

Full M3 acceptance requires every gap above to be resolved or explicitly decided by the owner. This ledger adds no new gate or exception to the repository rules.
