# BST-616 — confined read-only programmatic orchestration spike

## Goal

Decide whether bounded programmatic orchestration materially improves three
read-only retrieval workloads without reducing correctness, evidence coverage,
permission enforcement, or failure visibility. This spike ships no production
runtime mode.

## Grounding

- Use the current OpenAI Programmatic Tool Calling contract and model guidance,
  not remembered API shapes.
- Verify the exact installed Mastra 1.51.0 and AI SDK 4.0.8 surfaces before
  claiming provider-native compatibility.
- Compare the local design against OpenCode Code Mode at local HEAD
  `888c4cb50476aaecaad48e6a448759da3040ed2e`, including its permission-filtered
  catalog, per-call authorization, confinement, cancellation, and resource
  limits.
- Preserve Brainstrike's local-first, fail-loud, capability-gated contracts.

## Red/green method

1. Add a failing compatibility canary for the provider-native request and
   response fields required by Programmatic Tool Calling.
2. Prove whether the installed OpenAI adapter can express the hosted tool,
   `allowed_callers`, `output_schema`, nested `caller`, `program`, and
   `program_output` items without unsafe casts or discarded state.
3. Establish direct-calling baselines for multi-file extraction, repeated
   symbol/reference inspection, and deterministic multi-source reduction.
4. If the adapter seam is incomplete, do not integrate or cast around it. A
   disposable CDT research harness may still exercise the documented raw API
   with synthetic data to measure the capability ceiling, provided no raw
   transport enters production code.
5. Evaluate a disposable confined local interpreter using the same fixtures.
   It receives only the post-permission read-only allowlist, validates every
   input and output, enforces call/concurrency/time/output limits, preserves
   provenance, and returns structured failures. It must have no filesystem,
   process, network, module, or write capability of its own.
6. Compare correctness, evidence coverage, input/total tokens, latency, cost,
   model turns, tool calls, retries, recovery behavior, and safety outcomes.
7. Record the decision and exact eligible tool list in
   `docs/agents/assistant-providers.md`; create one small implementation ticket
   only if quality is non-inferior and the task-level benefit is material.

## Stop conditions

- Do not add a production route, fallback, feature flag, persistence format, or
  approval bypass.
- Stop a candidate after a foundational compatibility, correctness, provenance,
  or permission-boundary failure; do not spend across redundant permutations.
- Keep adaptive semantic search, writes, shell/session control, approvals,
  citations, and native-artifact validation on direct tool calls.

## Verification

- Focused compatibility and deterministic evaluation tests pass.
- Documentation names measured and unmeasured scenarios separately.
- Full root `pnpm lint && pnpm type-check && pnpm build && pnpm test` passes in
  one run before publication.
