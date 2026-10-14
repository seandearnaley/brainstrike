# Post-edit LSP diagnostics — evidence

Supports `docs/agents/assistant-runtime.md` § "POST-EDIT LSP DIAGNOSTICS".
Read before changing `lsp-diagnostics.ts`, the bundled TypeScript server wiring, `lspInspect`, query-failure reporting, or pool lifecycle. Report R2 Phase A, BST-1614.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2613-2763), extracted verbatim.

After a successful workspace edit, a language server runs over the edited file
and its diagnostics (errors/warnings) are attached to the tool result, so the
agent learns about a broken edit immediately instead of only when a later
build/test fails. Desktop-only (needs child processes + fs; web omits it —
capability-gated, no `isElectron()`).

- **Bespoke, not the core primitive.** Core 1.51 ships an LSP primitive but
  only inside its (non-adopted) Workspace/sandbox model and behind unexported
  deep paths, so `apps/desktop/src/assistant-server/lsp-diagnostics.ts` lifts
  the WIRE PROTOCOL (standard `vscode-jsonrpc` + `vscode-languageserver-
  protocol`, both bundled desktop deps), not the class.
- **Bundled flagship server.** Phase A ships TypeScript/JavaScript only, via a
  BUNDLED `typescript-language-server` + the JavaScript TypeScript 6
  compatibility API (desktop `dependencies`, so it works out-of-box).
  TypeScript 7's native compiler owns the workspace `tsc` binary, while the
  official `@typescript/typescript6` package re-exports the JS API from its
  `@typescript/old` dependency. The LSP resolver therefore follows that
  package-scoped forwarding dependency to the real `tsserver.js`; it must not
  assume the server is adjacent to the compatibility wrapper's
  `lib/typescript.js`. Reliability recipe (all three required, verified):
  spawn the server's `cli.mjs` through `process.execPath` +
  `ELECTRON_RUN_AS_NODE=1` (packaged apps have no standalone `node`); pin
  `initializationOptions.tsserver.path` to the bundled real TypeScript 6
  `tsserver.js` (deterministic — OUR TS version); and advertise the
  `textDocument.publishDiagnostics` client capability (without it the server
  stays silent). Diagnostics land as two pushes (`[]` then the real set), so a
  settle-window is mandatory — an empty publish is polled a little longer
  before the "clean" verdict is trusted. This intentionally means agent-facing
  diagnostics come from TypeScript 6 while build/type-check gates run native
  TypeScript 7. The full compiler parity sweep covers every non-emitting project
  command, and the real-subprocess LSP integration additionally checks the
  embeddings WebGPU surface that relies on the current DOM library declarations;
  do not remove that cross-major control while the LSP stays on TypeScript 6.
  The desktop manifest must list the compatibility implementation
  (`@typescript/old`) as a production dependency and unpack it explicitly:
  Electron Builder packages the `@typescript/typescript6` wrapper but does not
  retain that wrapper's private dependency by inference. The build-config
  contract has a mutation control for both the dependency and unpack rule.
  The root also owns that exact alias so `.vscode/settings.json` can point
  `typescript.tsdk` at `node_modules/@typescript/old/lib`; the compiler-wiring
  guard requires both the path and its `tsserver.js`, preventing VS Code from
  silently falling back to its bundled compiler.
  Python/Go/Rust discovery + the config surface are the remaining Phase B work.
- **`lspInspect` tool (Phase B).** A read-risk native tool for semantic
  navigation: `{path, line (1-based), match}`. Prefer a markerless single
  JavaScript/TypeScript identifier as `match`; the cursor is its first character
  when it occurs exactly once on the target line. If the identifier repeats on
  that line, use a unique line fragment with exactly one `<<<` cursor marker
  before the intended occurrence. The tool reads the file through the checked
  reader and anchors the identifier or marker-stripped fragment against the REAL
  line text. A markerless identifier missing from the requested line returns up
  to five actual candidate line numbers for an explicit retry; it never jumps
  lines itself. Missing and ambiguous matches refuse, while marked fragments
  resolve the column as fragment-start + marker-offset, so a partial or stale
  quote can never silently inspect the wrong position (same
  validate-before-position convention as `stringReplace`). Returns up to four
  groups — hover (inferred type/docs), the inspected line's diagnostics,
  definition locations (with a one-line preview + workspace-relative path,
  URIs converted via `fileURLToPath` so Windows drive letters survive), and
  implementations. Reuses the same pooled connection + per-file diagnose lock;
  each hover/definition/implementation query is independently bounded
  (`QUERY_TIMEOUT_MS`) and never throws. A malformed
  marker / out-of-range line / unmatched or ambiguous `match` is an actionable
  input error thrown for the model to correct. Registered across the full multi-registry checklist (read-risk,
  no approval).
- **An unanswered inspect query is never an empty one (BST-1614).** A bounded
  query that TIMED OUT or THREW must not degrade to the same value the server's
  own "nothing here" answer produces. `queryHover`/`queryLocations` therefore
  return a `QueryOutcome` — `{ok:true, value}` or `{ok:false, reason}` — and
  `withTimeout`'s fallback is the `QUERY_TIMED_OUT` sentinel symbol, never
  `null`. Every leg that did not answer lands in `LspInspectionResult.queryFailures`
  as `{query, reason:'timeout'|'error', message}`, where `query` is named for the RESULT FIELD it fills (`hover` / `diagnostics` /
  `definition` / `implementation`) and `message` says what is UNKNOWN and what
  not to conclude ("do not conclude it has no definition or is dead code").
  `detail` text from a rejected request is bounded and collapsed to one line by
  `boundQueryFailureDetail` AT THE PRODUCER: `queryFailures` is a RETURNED
  value, and a consumer other than the projection gets these strings raw.
  Four invariants, all test-pinned:
  (1) a partial failure NEVER flips `available` to false — a hover that worked
  is still returned alongside the failures; (2) the failures are logged with
  `logger.warn`, visible at the DEFAULT `INFO` level, so a human chasing a
  wrong "no definition" claim finds the cause without enabling debug logging;
  (3) `| unanswered=<queries>` goes in the projection HEADER, which is the only
  unconditional line and is self-bounding, so the "absent group is not
  verified-empty" signal never depends on a line that fits; (4) the
  `query_unanswered:` detail lines sit in a PRIORITY-ORDERED prelude above the
  droppable result lines — ahead of `hover`, because they prevent a wrong
  conclusion while hover is only informational — but the prelude is itself
  fit-aware. `domainModelResultCharBudget` is per-run (`resolveScaledToolResult
  Budget` clamps the domain allowance to 500..3000 tokens, so a small context
  window floors it at 2000 chars) and a maximal header + three failure lines +
  clipped hover measures 4338 chars, so forcing them in would make the closing
  `assertProjectionFits` THROW — failing the tool call outright exactly when
  the language server is already misbehaving. Do not make any prelude line
  unconditional. Do not reintroduce a bare `catch { return []; }` on either
  query, and do not give `withTimeout` a fallback that a real answer could
  equal.
- **Diagnostics settlement is RETURNED, never inferred from the map
  (BST-1614).** `waitForDiagnostics` resolves to a `DiagnosticsWait` —
  `{settled:true, diagnostics}` only for a non-empty publish or an empty one
  that survived the FULL `DIAGNOSTIC_SETTLE_MS` window, `{settled:false}`
  otherwise — and both `diagnose`/`getEditDiagnostics` and `inspect` read that
  value. The old `hasPublishedFor` map probe is gone, and re-adding one is a
  regression: the diagnostics map is mutable and shared, so (a) a preliminary
  empty publish landing near the 6s deadline leaves an entry behind while the
  settle window never completes, and (b) a publish arriving during the up-to-4s
  semantic queries repopulates it after `inspect` already captured the line
  diagnostics. Either way a post-hoc `has()` reports a never-settled leg as
  ANSWERED, resurrecting the false "this line is clean" verdict inside the very
  leg added to prevent it. Both paths are pinned in
  `lsp-inspect-query-failures.test.ts`.
  Pinned by
  `apps/desktop/src/__tests__/assistant-server/lsp-inspect-query-failures.test.ts`
  (fake JSON-RPC wire: per-query timeout, throw, and the mixed case) plus the
  projection cases in
  `workspace-inspection-model-projections.test.ts`.
- **Pool + lifecycle.** One pooled server child process per workspace `rootId`
  (module-level Map, mirroring `execute-command-tool`'s `liveChildProcesses`).
  All acquisition goes through `acquireLspServer`, which registers the pool
  entry (a `Promise<LspServerConnection>`) in the same synchronous frame as
  the miss check — the diagnose locks are per-FILE, so concurrent
  first-touches of different files under one root race creation, and a bare
  get → create → set would spawn two children and orphan one. Do not inline
  `pool.get`/`pool.set` at call sites.
  Every server MUST be torn down: `disposeLspServers()` is wired into BOTH the
  factory-reset `runtimes[]` and graceful shutdown in `main.ts` (alongside the
  shell/terminal reapers); `evictLspServersForRoot(rootId)` fires from the
  `fs:removeRoot` IPC handler. Disposal awaits the child process's actual exit,
  not merely `child.kill()` accepting the signal, so each caller awaiting that
  connection's disposal observes honest settlement. Pool closure against new
  acquisitions during global/root teardown is separate follow-up territory.
  The no-orphan proof is the heart of `lsp-diagnostics.integration.test.ts`.
- **No silent fallbacks.** An unresolvable server, an unsupported language, or
  a diagnostics timeout all resolve to an honest result the caller attaches —
  never a throw that would fail the already-applied edit. Unsupported languages
  (markdown/json) OMIT the `lsp` field entirely (no note spam); a supported
  language whose server is unavailable/timed out attaches `{available:false,
  message}`. Diagnostics are self-bounded (≤15, message ≤300 chars, errors
  first) because `lsp.diagnostics` is NESTED and not a trimmable collection key
  — the transport budget guard cannot rescue an oversized blob.
- **Scope note.** Wired into `write` + `stringReplace` (content-editing tools,
  where diagnostics catch a just-introduced error); `rename` is deliberately
  excluded (content unchanged → diagnostics would report pre-existing state as
  noise, plus a bonus read).

Diagnostics run OUTSIDE the per-file write lock (a language-server round-trip
must not extend the write's critical section). Proofs:
`lsp-diagnostics.integration.test.ts` (real subprocess: diagnostics,
pooling, no-orphan dispose, honest degrade) + the `post-edit LSP diagnostics`
cases in `assistant-tools-multiroot-and-gating.integration.test.ts`. When changing this flow, update
this section and those tests.
