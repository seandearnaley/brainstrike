# PRD: Replace `@babel/parser` with native Rust parser in chunking pipeline (hybrid)

**Status**: Draft — under review (Phase 1 spike complete; Phases 2–8 implemented in stacked PRs #988–#994; PRD §13 approval still pending)
**Owner**: Sean Dearnaley
**Created**: 2026-05-15
**Last revised**: 2026-05-16 (v2.1 — Cycle 3.1 stdin/stdout plan replaced with parentPort; TDD rule §5.2 relaxed post-implementation)
**Target package**: `@brainstrike/chunking-worker` + new utility process in `apps/desktop`
**Rollout posture**: Aggressive (see §8)

> **Note on the filename.** This file is named `prd-chunking-wasm-parser-*` because v1 proposed a WASM port. v2 (and the shipped implementation) uses oxc's native NAPI bindings, not WASM — see §2 and Appendix A for the rationale. The "wasm" in the filename is a historical artifact; renaming it now would break inbound PR links so it stays as-is.

---

## Revision history

| Date | Change | Driven by |
|---|---|---|
| 2026-05-15 v1 | Initial draft. Proposed `oxc-parser` (assumed WASM, ~1.2 MB gzipped). | PRD authoring |
| 2026-05-15 v2 | **Library choice changed.** `@oxc-parser/wasm` was deprecated ~12 months ago. SWC's WASM is 5 MB gzipped — too large. New plan: hybrid architecture using `oxc-parser` (native NAPI) in Electron via `utilityProcess`, keep `@babel/parser` in pure-browser contexts (`apps/web`). | Phase 1 spike findings (§Appendix A) |
| 2026-05-16 v2.1 | **Cycle 3.1 protocol changed** from stdin/stdout JSON-RPC to Electron `parentPort` messaging (matches `db-host-entry` codebase pattern; structured-clone IPC for free; no JSON-line protocol parser needed). **TDD rule §5.2 relaxed** post-implementation to accommodate cases where Biome lint rejects stub-state RED commits. | Phase 3 implementation; review comments on #979 |

---

## 1. Goal

Improve JS/TS AST-aware chunking throughput in `@brainstrike/chunking-worker` by routing parser calls to a native Rust parser **in Electron desktop** (where users index large repos), while leaving `apps/web` on the existing Babel parser to avoid bundle-size regression. Built using strict red→green TDD with a regular commit cadence and a feature flag with per-file fallback.

### Quantified success criteria

| Metric | Baseline (Babel everywhere) | Target | Measurement |
|---|---|---|---|
| **Median parse time per file (Electron desktop)** | TBD (Phase 6 captures) | ≥ 5× faster | Benchmark §10 on fixture corpus |
| **p99 parse time per file (Electron desktop)** | TBD | ≥ 3× faster | Benchmark §10 |
| **End-to-end chunking throughput, 10k-file repo (Electron)** | TBD (files/sec) | ≥ 2× faster | Pipeline-level run |
| **Chunk boundary parity vs. Babel** | n/a | 100% on fixture corpus | Differential test §11 |
| **`apps/web` worker bundle size delta** | n/a | **0 bytes** | `tsup` build diff |
| **Existing chunking-worker test suite** | green | green | `pnpm -F @brainstrike/chunking-worker test` |
| **Existing E2E tests (`chunking-host-renderer.test.ts`)** | green | green | Playwright run |

### Non-goals

- Replacing the parser in `apps/web`. Babel stays there. Web-only users keep current behavior.
- Authoring our own Rust crate. We adopt `oxc-parser` (existing, maintained).
- Replacing parsers in any other package (text-splitter, file-tree-worker, etc.).
- Parsing languages other than JS/TS/JSX/TSX in this PRD.
- Changing chunking algorithm or output shape. Chunk boundaries must remain identical.

---

## 2. Background & context

### What changed since v1 of this PRD

Phase 1 spike (~2 hours of `npm view` and a worker build) revealed:

1. **`@oxc-parser/wasm` was deprecated ~12 months ago.** The oxc team consolidated on NAPI (Node.js native bindings) which delivers near-native Rust speed. WASM was abandoned because the NAPI path serves their primary users (Node-side tooling) better.
2. **`@swc/wasm-web` is 15.2 MB unpacked / ~5 MB gzipped.** Adding it to `apps/web`'s chunking-worker would quadruple the worker bundle (from 1.8 MB to 6.7 MB gzipped). Unacceptable.
3. **`@biomejs/wasm-web` is 35.4 MB.** Even worse.
4. **Babel today costs ~103 KB gzipped** in the chunking-worker bundle — small enough that the bundle-size argument *for* swapping it is weak. The compelling argument is CPU time, not bundle bytes.
5. **Existing process architecture supports this swap cleanly.** The chunking-worker in Electron already runs in a dedicated renderer process (`?mode=chunking-host`) managed by [`ChunkingHostManager`](../apps/desktop/src/chunking-host-manager.ts), and the codebase already uses Electron `utilityProcess` for the db-host ([db-host-manager.ts:394](../apps/desktop/src/db-host-manager.ts:394)). We have a precedent to follow.

### What's already WASM/native in this codebase

- **tiktoken** — Rust→WASM, ~575 KB gzipped in chunking-worker
- **xxhash64** — WASM, ~modest size
- **ONNX Runtime** — WASM/WebGPU
- **pglite** — Postgres+pgvector compiled to WASM, in db-host utilityProcess

This PRD adds: **`oxc-parser` (NAPI native)** in a new utility process for chunking. Same pattern as pglite-in-db-host. We extend a known-good architecture.

### What the AST is used for

The chunking worker uses Babel only to identify **function-level boundaries** ([portable-chunking.ts:733](../packages/chunking-worker/src/portable-chunking.ts:733)). It walks the tree generically via `iterateAstChildren` ([portable-chunking.ts:653](../packages/chunking-worker/src/portable-chunking.ts:653)) and reads only `node.type`, `node.start`, `node.end`. Narrow contract → easy adapter.

We do *not* use: transforms, codegen, type info, source maps from the parser, comments, or token streams.

---

## 3. Library decision (revised)

### Final choice: `oxc-parser` (native NAPI) for Electron + `@babel/parser` (existing) for browser

### Why this combination

| | **`oxc-parser` (NAPI)** | **`@babel/parser` (JS)** |
|---|---|---|
| Where it runs | Electron utilityProcess (Node) | Web Worker in `apps/web` (browser) |
| Speed | Near-native Rust (≈ 5–20× Babel) | JS reference baseline |
| Bundle cost in `apps/web` | **0 bytes** (not loaded) | ~103 KB gzipped (current) |
| Bundle cost in Electron | Native binary (~400 KB), not in worker bundle | Stays loaded as fallback |
| AST shape | ESTree-conformant | Babel AST (superset of ESTree) |
| Maintenance | Very active (parser-first project) | Mature, stable |

The hybrid is not architectural compromise — it's **routing each environment to its best-available option**. Electron has Node, so it gets the fast native parser. Browsers don't have Node, so they keep the working JS parser. No environment regresses.

### Why not the alternatives

- **`@swc/wasm-web` everywhere**: +5 MB gzipped to `apps/web`. Disqualified.
- **`hermes-parser` everywhere**: +500 KB gzipped to `apps/web` for marginal speed win in browser. Disqualified — the *actual* perf bottleneck is desktop indexing, not browser indexing.
- **`oxc-parser` (NAPI) everywhere via WASM-shim**: doesn't exist. NAPI requires Node.
- **Build oxc to WASM ourselves**: violates "no Rust authoring" constraint and oxc team explicitly stopped maintaining their own WASM build (signal that it's not a productive direction).

### Risks of `oxc-parser` choice

| Risk | Likelihood | Mitigation |
|---|---|---|
| oxc has a parser bug on real-world TS file | Medium | Per-file fallback to Babel + telemetry (§8) |
| AST shape divergence from Babel breaks function-range collection | Medium | Differential test (§11) catches before merge |
| oxc maintenance slows | Low | Adapter pattern means we can swap parsers without touching consumer |
| NAPI binary doesn't exist for some platform | Low | oxc publishes for darwin-arm64, darwin-x64, win32-x64, linux-x64, linux-arm64 — covers all our supported platforms; fallback to Babel if absent |

---

## 4. Architecture (revised for hybrid)

### Two execution paths, one logical interface

```
┌─────────────────────────────────────┐    ┌─────────────────────────────────────┐
│  apps/web (browser)                 │    │  apps/desktop (Electron)            │
│                                     │    │                                     │
│  ┌─────────────────────────────┐   │    │  ┌─────────────────────────────┐   │
│  │ Web Worker                  │   │    │  │ chunking-host renderer      │   │
│  │  - chunking-worker          │   │    │  │  (BrowserWindow,            │   │
│  │  - portable-chunking.ts     │   │    │  │   ?mode=chunking-host)      │   │
│  │  - parsers/index.ts         │   │    │  │  - chunking-worker          │   │
│  │      └─→ babel-adapter.ts   │   │    │  │  - parsers/index.ts         │   │
│  │            (in-worker)      │   │    │  │      └─→ oxc-adapter.ts     │   │
│  └─────────────────────────────┘   │    │  │            (IPC client)     │   │
└─────────────────────────────────────┘    │  └──────────┬──────────────────┘   │
                                            │             │ IPC                  │
                                            │             ▼                      │
                                            │  ┌─────────────────────────────┐   │
                                            │  │ main process                │   │
                                            │  │  - parser-host-manager.ts   │   │
                                            │  └──────────┬──────────────────┘   │
                                            │             │ utilityProcess.fork  │
                                            │             ▼                      │
                                            │  ┌─────────────────────────────┐   │
                                            │  │ parser utility process      │   │
                                            │  │  (Node.js, no UI)           │   │
                                            │  │  - parser-host-entry.ts     │   │
                                            │  │  - oxc-parser (NAPI)        │   │
                                            │  └─────────────────────────────┘   │
                                            └─────────────────────────────────────┘
```

### The contract every adapter satisfies

```typescript
// packages/chunking-worker/src/parsers/types.ts
interface ParserAdapter {
  /** Parse JS/TS source into a generic AstNode tree (matching the existing portable-chunking AstNode shape). */
  parse(content: string, options: ParseOptions): Promise<AstNode>;

  /** Adapter identity for telemetry and feature-flag routing. */
  readonly id: 'babel' | 'oxc-native';
}

interface ParseOptions {
  language: 'javascript' | 'typescript';
  jsx: boolean;
  errorRecovery: boolean;
}

// AstNode shape from portable-chunking.ts:107 — unchanged
type AstNode = {
  type?: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;
```

### File layout

```
packages/chunking-worker/src/
├── parsers/
│   ├── types.ts                    # ParserAdapter contract above
│   ├── babel-adapter.ts            # extracted from current portable-chunking
│   ├── oxc-ipc-adapter.ts          # IPC client for parser utility process (Electron only)
│   ├── select-adapter.ts           # routing logic — picks adapter per environment + flag
│   └── __tests__/
│       ├── babel-adapter.test.ts
│       ├── oxc-ipc-adapter.test.ts (mocks the IPC channel)
│       ├── select-adapter.test.ts
│       └── differential.test.ts    # both adapters, asserts identical output
└── portable-chunking.ts            # unchanged consumer; uses select-adapter

apps/desktop/src/
├── parser-host-manager.ts          # NEW: lifecycle, IPC bridge, child process management
├── parser-host-entry.ts            # NEW: utilityProcess entry; loads oxc-parser; exposes parse RPC
├── parser-host-shared.ts           # NEW: channel constants, payload types/validators
├── ipc-parser-host.ts              # NEW: registers ipcMain handlers
└── parser-host-manager.test.ts     # NEW: unit tests with mocked utilityProcess
```

### IPC overhead consideration

A naive IPC roundtrip per file parse could *eat* the perf win — IPC serialization isn't free. Two mitigations baked into the design:

1. **Batch parsing**: the existing `chunkBatch` channel already batches files. The parser host accepts batches and returns batch results in one roundtrip. Marginal cost per file approaches zero at batch sizes ≥ 10.
2. **Single long-lived utility process**: the parser host starts once on app launch and stays alive. Avoids fork-per-batch overhead.

If IPC overhead still dominates at small file sizes (Phase 6 will tell us), fallback option: keep small files (< 5 KB) on the in-worker Babel adapter and only route large files to the native parser. This is a Phase 7 optimization, not Phase 2.

---

## 5. TDD execution plan (red → green → refactor, commit-per-cycle)

### TDD discipline rules for this project

1. **Every commit lands in green state.** No half-finished implementations committed.
2. **Tests first.** A failing test exists before the implementation that makes it pass. Where the project's lint configuration permits stub implementations to compile (no `useReadonlyClassProperties`, `noEmptyFunctions`, or `noUnusedPrivateClassMembers` violations against the stub), this is captured as a separate RED commit followed by a GREEN commit. Where lint rejects the stub state, the cycle commits as a single `feat:` whose diff still authors the test file before the implementation file — the test-first discipline is preserved in the diff ordering even when not in the commit history.
3. **Refactor commits are separate.** Don't mix "add behavior" and "clean up" — they review differently.
4. **Commit cadence target**: ≤ 200 lines per commit, ≤ 1 hour of work per commit. Smaller is better.
5. **Use conventional commits**: `test:`, `feat:`, `refactor:`, `fix:`, `docs:`, `chore:`. Each prefix maps to a typical TDD phase.
6. **Before every commit**: run the affected package's tests AND lint. Pre-commit hooks (lefthook is already set up) will enforce this.

> **Rule §5.2 was relaxed post-implementation.** The original rule mandated separate RED and GREEN commits unconditionally. In practice this fought with Biome's "code already this clean is suspicious" rules — `#host: UtilityProcess | null = null` triggers `useReadonlyClassProperties` because the stub never reassigns it, even though GREEN will. After three lint-fight rounds the cycle was consolidated into one commit. The principle held; the mechanical separation didn't. Documented for future projects.

### Phase-by-phase TDD plan

Each phase ends in a PR review and merge. Each cycle within a phase ends in a commit.

#### Phase 0 — Prep (½ day)

| Cycle | Action | Commit message |
|---|---|---|
| 0.1 | Land this revised PRD on main via PR | `docs: chunking-worker rust parser PRD (v2 hybrid)` |
| 0.2 | Create branch `feat/chunking-parser-adapter-foundation` from main | (branch creation, no commit) |

Exit: PRD merged, working branch exists.

#### Phase 1 — Spike (DONE)

Findings captured in §Appendix A. Library choice revised to hybrid in §3.

#### Phase 2 — Foundation: extract Babel adapter behind facade (1–2 days)

Goal: refactor with **zero behavior change**. Existing tests must pass before and after every commit.

| Cycle | RED (test) | GREEN (impl) | REFACTOR | Commit pair |
|---|---|---|---|---|
| 2.1 | Write `parsers/types.ts` with `ParserAdapter` interface; write `parsers/__tests__/babel-adapter.test.ts` calling `parse('const x = 1', { language: 'javascript' })` and asserting AstNode shape. **Test fails: file doesn't exist.** | Create `babel-adapter.ts` with minimal impl wrapping current `loadBabelParserModule`. Test passes. | — | `test: parser adapter contract & first babel test` + `feat: extract babel parser into adapter` |
| 2.2 | Add tests for: TS parsing, JSX parsing, error-recovery on broken syntax, options forwarding. | Flesh out adapter to satisfy each. | — | `test: babel adapter feature coverage` + `feat: babel adapter handles ts/jsx/errors` |
| 2.3 | Add `parsers/__tests__/select-adapter.test.ts`: in browser-like env, returns babel adapter. | Implement `select-adapter.ts` with environment detection (single branch for now). | — | `test: select-adapter returns babel in browser` + `feat: select-adapter implementation` |
| 2.4 | (No new test — existing portable-chunking tests are the test.) | Replace `loadBabelParserModule` call in `portable-chunking.ts` with `selectAdapter().parse()`. Run full test suite. | If green, commit. If red, fix and recommit. | `refactor: route portable-chunking through adapter facade` |

Exit: All existing tests green. `portable-chunking.ts` no longer imports Babel directly. `apps/web` behavior unchanged. **Open PR for review.**

#### Phase 3 — Build the parser utility process (2–3 days)

Goal: a Node-side `handleParseRequest()` function loaded by the parser-host utility process that calls oxc-parser. Has its own tests using the Electron `parentPort` mocking pattern.

| Cycle | RED | GREEN | Commit pair |
|---|---|---|---|
| 3.1 | Write `apps/desktop/src/__tests__/main/parser-host-entry.test.ts`: import `handleParseRequest`, send a parse request object, assert a response object with `ok: true` and an AstNode root. Mirrors the parentPort mocking pattern from `db-host-entry.test.ts` — no real child-process spawn. **Test fails: file doesn't exist.** | Create `parser-host-entry.ts` that exports `handleParseRequest(request)` calling `oxc-parser.parseSync()`. | `test: parser-host-entry contract` + `feat: parser-host utility process entry` |
| 3.2 | Add tests for: TS, JSX, error recovery, malformed payload, oversized input. | Implement each path. | `test: parser-host edge cases` + `feat: parser-host handles ts/jsx/errors/limits` |
| 3.3 | Verify oxc's ESTree output is consumer-compatible WITHOUT normalization. Walk the returned tree with the same generic logic `iterateAstChildren` uses; assert function ranges are discoverable. | If the assumption holds (it did): document and move on. If it doesn't: add `normalizeOxcAst()`. | `test: verify oxc output is chunking-consumer compatible` + (likely no impl commit) |
| 3.4 | Performance smoke test: parse 100 files, assert wall-clock < 500ms (sanity check, not the real benchmark). | Tune if needed. | `test: parser-host perf smoke` + (likely no impl commit) |

**Plan revision** (v2.1, post-implementation): the original Cycle 3.1 plan called for a stdin/stdout JSON-RPC protocol with child-process spawning in the test. After studying the existing `db-host-entry.test.ts`, the codebase's established pattern is to test the entry module's exported functions directly and mock `process.parentPort` for the IPC layer. Strictly simpler than rolling a JSON-line protocol parser. This pivot also means Phase 3 doesn't need a separate "wire to parentPort" cycle; Phase 4 Cycle 4.1 adds the parentPort `message` listener.

Exit: parser utility process's pure function works. Can be tested without Electron. **Open PR for review.**

#### Phase 4 — Wire parser host into Electron (1–2 days)

Goal: `ChunkingHostManager` can call the parser host via main process IPC.

| Cycle | RED | GREEN | Commit pair |
|---|---|---|---|
| 4.1 | Write `parser-host-manager.test.ts` mirroring `db-host-manager` tests: assert lifecycle (start/stop/restart), assert IPC channel constants. | Implement `ParserHostManager` mirroring `DbHostManager` shape. | `test: ParserHostManager lifecycle` + `feat: ParserHostManager` |
| 4.2 | Write `ipc-parser-host.test.ts`: register handlers, send fake IPC request, assert it reaches manager. | Implement `ipc-parser-host.ts`. | `test: parser-host IPC handlers` + `feat: parser-host IPC handlers` |
| 4.3 | Wire into `main.ts`: instantiate manager, register IPC, add to shutdown sequence. Add e2e smoke test in `apps/desktop/e2e/`. | Edit `main.ts`. | `feat: wire parser-host into electron main` (single commit, mostly mechanical) |
| 4.4 | Write `oxc-ipc-adapter.test.ts`: mock the IPC channel; assert adapter sends correctly-shaped requests and parses responses. | Implement `oxc-ipc-adapter.ts` in chunking-worker. | `test: oxc-ipc-adapter contract` + `feat: oxc-ipc-adapter implementation` |

Exit: chunking-host renderer can request a parse from main, which delegates to utility process, which returns a parsed AST. End-to-end pathway exists but is not yet wired into chunking. **Open PR for review.**

#### Phase 5 — Hook adapter into select logic (½ day)

| Cycle | RED | GREEN | Commit pair |
|---|---|---|---|
| 5.1 | Update `select-adapter.test.ts`: in Electron-chunking-host env with feature flag on, returns oxc-ipc adapter. | Update `select-adapter.ts` with environment + flag detection. | `test: select-adapter routing matrix` + `feat: select-adapter routes per environment+flag` |
| 5.2 | Test: per-file fallback — if oxc-ipc adapter throws, falls back to babel adapter for that file, logs telemetry. | Implement fallback wrapper. | `test: per-file fallback to babel on oxc error` + `feat: per-file parser fallback` |

Exit: feature flag controls routing; per-file safety net in place. **Open PR for review.**

#### Phase 6 — Differential testing (1 day)

| Cycle | Action | Commit |
|---|---|---|
| 6.1 | Add fixture corpus under `packages/chunking-worker/src/__tests__/fixtures/diff-corpus/` (≤ 50 files, see §11 for criteria). | `test: differential corpus fixtures` |
| 6.2 | Write `differential.test.ts` running both adapters, asserting identical chunk boundaries. **Some tests will fail** — those are the divergences we need to investigate. | `test: differential parser test harness` |
| 6.3 | For each divergence: investigate, normalize in adapter (if benign) or fix bug. Document allowed deltas in `differential.allowed-deltas.md`. | One commit per divergence resolved: `fix: normalize oxc <node-type> spans to match babel` etc. |
| 6.4 | When 100% pass, wire into CI as separate job. | `chore(ci): add chunking parser differential test job` |

Exit: 100% chunk parity. **Open PR for review.**

#### Phase 7 — Benchmark (½ day)

| Cycle | Action | Commit |
|---|---|---|
| 7.1 | Build `packages/chunking-worker/bench/parse-cost.ts` (real-repo corpus, methodology in §10). | `chore(bench): add parser benchmark harness` |
| 7.2 | Run on baseline (Babel-only) and candidate (oxc-IPC). Capture results to `docs/bench-chunking-parser-2026-05.md`. | `docs: chunking parser benchmark results` |

Exit: numbers prove (or disprove) the goal's success metrics. If we missed the target, escalate before Phase 8.

#### Phase 8 — Aggressive rollout (½ day)

| Cycle | Action | Commit |
|---|---|---|
| 8.1 | Default the feature flag to **on** in `apps/desktop`. Add env-var override `BST_CHUNKING_PARSER=babel` for emergency revert. | `feat: enable oxc parser by default in desktop` |
| 8.2 | Verify per-file fallback telemetry is wired and log-visible. | `feat: parser fallback telemetry` |
| 8.3 | Manual QA: index a 10k-file repo. Confirm no regressions. | (no commit; merge PR) |

Exit: aggressive rollout shipped. **Final merge to main.**

#### Phase 9 — Post-merge cleanup (after 30 days of green telemetry)

If `< 0.1%` of files hit the Babel fallback in Electron over 30 days:

- Remove the per-file fallback wrapper (oxc becomes hard-required in Electron)
- Document the success in this PRD's revision history

Babel stays in `apps/web` permanently (per the hybrid architecture).

---

## 6. Branching strategy

### Branch model

```
main
 └── feat/chunking-parser-adapter-foundation  (Phase 2)
       │ PR merged → main
       └── feat/chunking-parser-host-utility  (Phase 3)
             │ PR merged → main
             └── feat/chunking-parser-host-electron  (Phase 4)
                   │ PR merged → main
                   └── feat/chunking-parser-select-fallback  (Phase 5)
                         │ PR merged → main
                         └── feat/chunking-parser-differential  (Phase 6)
                               │ PR merged → main
                               └── feat/chunking-parser-rollout  (Phases 7+8)
                                     └── PR merged → main
```

### Why a branch per phase

- Each phase has a coherent, reviewable scope.
- A failed/abandoned phase doesn't pollute main.
- Reviewers see ~5–15 commits per PR — enough to understand intent, few enough to read carefully.
- The TDD red-green pairing is preserved in PR history (test commit immediately precedes impl commit).

### Why not one mega-branch

- `feat/chunking-rust-parser` with 30 commits is unreviewable in practice.
- Long-lived branches drift from main and accumulate merge conflicts.
- Phase boundaries are natural rebase points.

### Commit conventions

- `test: <subject>` — adds a failing test (the RED step)
- `feat: <subject>` — adds behavior to make a test pass (the GREEN step)
- `refactor: <subject>` — reshape without behavior change (must keep tests green)
- `fix: <subject>` — bug fix
- `docs: <subject>` — docs only
- `chore: <subject>` — tooling, deps, CI

Co-author tag stays on every commit per project convention.

### Pre-commit verification

`lefthook` is already configured. The relevant hooks for this work:
- Type check on staged files
- Lint (Biome) on staged files
- Test on the affected packages (configured per-package)

We do **not** bypass these hooks. If a hook fails, fix the root cause; don't `--no-verify`.

---

## 7. Build integration

The parser utility process needs `oxc-parser` as a dep of `apps/desktop` (not `chunking-worker`, since chunking-worker stays browser-bundled).

### Changes to `apps/desktop/package.json`

```json
{
  "dependencies": {
    "oxc-parser": "^0.131.0"
  }
}
```

### Why not `chunking-worker/package.json`

The chunking-worker bundles for `platform: 'browser'`. Adding `oxc-parser` (NAPI) there would either:
- Break the build (NAPI can't resolve `.node` files in browser context), or
- Force us to mark it as `external` and rely on runtime path resolution (fragile)

By scoping `oxc-parser` to `apps/desktop`, we keep the worker bundle pure-browser and load the native parser only from main process / utility process where Node is guaranteed.

### tsup config: no changes

`packages/chunking-worker/tsup.config.ts` stays as-is. The new `oxc-ipc-adapter.ts` file is pure TypeScript that talks to Electron via the existing IPC bridge — no new bundling concerns.

---

## 8. Feature flag & rollout

### Decision: aggressive rollout (per project owner)

Once Phase 8 lands, the feature flag defaults to **oxc** in Electron. `apps/web` always uses Babel (no flag exists for web).

### Flag mechanism

- **Env var**: `BST_CHUNKING_PARSER=oxc|babel` (set in main process; passed through to chunking-host via existing channel)
- **Preference**: optional UI toggle in advanced/dev preferences; defer to Phase 8 to decide whether to expose

### Safety nets

1. **Per-file fallback** (Phase 5 cycle 5.2): if oxc throws on a specific file, that file silently falls back to Babel for that parse only. Telemetry counts the event. Pipeline never fails because of a parser bug.
2. **Kill switch**: `BST_CHUNKING_PARSER=babel` reverts to Babel without code changes.
3. **Differential test in CI** (Phase 6): catches divergences before merge.
4. **Per-platform binary check on startup**: if `oxc-parser` fails to load (missing platform binary), fall back to Babel for the entire session and log a startup warning.

### Why aggressive is safe here

- User-visible failure mode is *worse chunks*, not data loss or crashes. Chunks regenerate on re-index.
- The chunking-host process is already isolated; it crashing doesn't take down the app.
- Telemetry gives early warning before user complaints.

### Rollback

1. **Per-file**: automatic (fallback wrapper).
2. **Per-user**: env var or preference.
3. **Per-deploy**: revert the Phase 8 PR. Babel stays as fallback indefinitely.

---

## 9. Where you (the user) write code

Per this project's TDD-with-learning posture, the one place where domain knowledge meaningfully shapes the feature is the **environment + flag routing function** in `parsers/select-adapter.ts`.

### What it decides

When chunking-worker calls `selectAdapter()`, this function returns the right `ParserAdapter` for the current execution context. The decisions encoded:

1. Is this `apps/web` or Electron? (Detect via env-var or a global injected at worker boot.)
2. If Electron, is the feature flag on or off?
3. If on, is the parser-host actually available (loaded, not in error state)?
4. If unavailable, fall back to what?

### Trade-offs you weigh

- **Strict environment detection** vs. **flexible runtime probing**: probing is more robust but slower at first call.
- **Lazy adapter init** vs. **eager init**: eager catches setup bugs early; lazy avoids paying cost in fast-exit scenarios.
- **Synchronous vs. async selection**: sync is simpler, but the IPC adapter needs an async setup; we'd need to either preload it or handle the first call's latency specially.
- **Telemetry granularity**: do we count every selection, or just the fallback events?

### The contract you implement

```typescript
// packages/chunking-worker/src/parsers/select-adapter.ts
//
// TODO(user): implement selectAdapter() per the trade-off analysis below.
//
// Inputs available to you:
//   - getEnvironment(): 'browser' | 'electron-chunking-host'  (already implemented)
//   - getParserFlag(): 'oxc' | 'babel' | 'auto'              (already implemented)
//   - babelAdapter: ParserAdapter                            (always available)
//   - oxcIpcAdapter: ParserAdapter | null                    (null if init failed)
//
// Outputs: ParserAdapter
// Side effects acceptable: telemetry counter increments
//
// Constraints:
//   - Must be synchronous (called in the chunking hot path)
//   - Must never throw — falling back to babel is always valid
//   - Should be cheap (called per-file, not per-batch)
export function selectAdapter(): ParserAdapter {
  // Your 5-10 lines here.
}
```

When we get to Phase 5 cycle 5.1, I'll set up the test fixtures and the `getEnvironment` / `getParserFlag` helpers. You write `selectAdapter()`.

---

## 10. Benchmark protocol

(unchanged from v1 — see prior content; key points preserved below)

- **Corpus**: brainstrike monorepo + VS Code source (deterministic checkout). Don't commit; commit a fetch script.
- **Metrics**: per-file parse time (median + p99), end-to-end chunk time, IPC roundtrip cost (new, hybrid-specific), peak heap.
- **Segmentation**: by file size bucket (< 1 KB, 1–10, 10–100, > 100).
- **Output**: `docs/bench-chunking-parser-2026-05.md`, committed alongside the implementation, with the reproducer script.

### Hybrid-specific metric: IPC cost amortization

Parse a single 1-KB file: measure end-to-end time including IPC. Then parse a batch of 100 same-size files: measure per-file cost. The ratio tells us if IPC overhead dominates at small file sizes — informs whether Phase 7 small-file optimization is needed.

---

## 11. Differential testing

(unchanged from v1 — preserved for reference)

- Compare `babelAdapter.parse(content)` and `oxcIpcAdapter.parse(content)` on every fixture
- Assert chunk-boundary equality after running each AST through `collectTopLevelFunctionRanges`
- Curated corpus (< 50 fixtures) covering: classes, generators, async/decorators, TS enums, conditional types, satisfies, JSX fragments, deeply nested ternaries, minified bundles, files with parse errors
- CI-only job (slower than unit tests); required to merge PRs touching `chunking-worker/parsers/`
- Document expected divergences in `differential.allowed-deltas.md`; never wave them away silently

---

## 12. Risks register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| oxc has a parser bug on real-world TS file | Medium | Medium | Per-file fallback to Babel + telemetry |
| AST shape divergence breaks function-range collection silently | Medium | High | Differential test (§11) |
| IPC overhead per parse exceeds the parse-time savings on small files | Medium | Medium | Batch via existing `chunkBatch` channel; Phase 7 size-based routing if needed |
| oxc upstream maintenance slows | Low | Medium | Adapter pattern allows swap without consumer changes |
| utility process crashes mid-parse | Low | Medium | `parser-host-manager` mirrors `db-host-manager` restart logic |
| Native binary missing for some user's platform | Low | Low | Startup probe; full-session fallback to Babel + warning log |
| Differential corpus misses an edge case that hits in prod | Medium | Low | Per-file fallback absorbs it; we add it to corpus after the fact |
| Long-lived parser utility process leaks memory | Low | Medium | Periodic restart on file count threshold (mirrors db-host pattern) |

---

## 13. Approval

Approval to proceed past Phase 0 requires:

- [ ] Owner sign-off on revised goal (§1)
- [ ] Owner sign-off on hybrid architecture (§3, §4)
- [ ] Owner sign-off on aggressive rollout posture (§8)
- [ ] Owner sign-off on TDD discipline rules (§5)
- [ ] Owner sign-off on branching strategy (§6)

---

## Appendix A — Phase 1 spike findings

### Method

Ran `npm view` against five candidate WASM/native packages in May 2026 and built the chunking-worker to measure current bundle composition.

### Library landscape (as of 2026-05-15)

| Package | Latest version | Unpacked | Status |
|---|---|---|---|
| `@oxc-parser/wasm` | 0.60.0 | 1.5 MB | **DEPRECATED ~12 months ago** |
| `oxc-parser` (NAPI) | 0.131.0 | 1.4 MB | Active; published same day |
| `@swc/wasm-web` | 1.15.33 | 15.2 MB (~5 MB gzipped) | Active |
| `@swc/wasm-typescript` | 1.15.33 | 3.75 MB | Active (transformer, not parser) |
| `@biomejs/wasm-web` | 2.4.15 | 35.4 MB | Active |
| `web-tree-sitter` | 0.26.8 | 4.5 MB + per-grammar files | Active |
| `hermes-parser` | 0.36.1 | 1.6 MB | Active |

### Current chunking-worker bundle composition

Built from this commit on 2026-05-15:

| File | Raw | Gzipped | What it is |
|---|---|---|---|
| `o200k_base-*.js` | 2.27 MB | 1.09 MB | tiktoken BPE vocab |
| `tiktoken_bg-*.js` | 1.37 MB | 561 KB | tiktoken WASM (base64 inlined) |
| `lib-*.js` | 583 KB | **103 KB** | **`@babel/parser@7.29.2` ← target of replacement** |
| chunking + text-splitter | ~75 KB | ~14 KB | core logic |
| Other | ~30 KB | ~10 KB | misc |
| **Total combined** | **4.3 MB** | **1.8 MB** | |

### Conclusion

The original PRD's premise (oxc-WASM at ~1.2 MB) was invalidated by oxc's WASM deprecation. Of the alternatives, `@swc/wasm-web` would inflate the worker bundle by ~3.7× (+5 MB gzipped) — unacceptable for `apps/web`. The hybrid architecture (oxc-NAPI in Electron, Babel everywhere else) sidesteps the bundle-size problem entirely while delivering the perf win where it matters most: large indexing runs in Electron desktop.
