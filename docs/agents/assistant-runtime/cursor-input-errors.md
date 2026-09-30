# Correctable workspace pagination input errors

Supports `docs/agents/assistant-runtime.md` § "Per-tool guard".

## 2026-09-29 — BST-1892 kickoff

- Recorded before production edits at 2026-09-30T00:18:46Z.
- Base: `origin/main` / `3189ae3998396712e71c4bbea91ee6cc79c1454b`.
- Branch: `codex/bst-1892-cursor-input-errors`; independent change, no stack.
- The thread audit's section 2 observed rejected changed-range continuations
  losing their safe retry instruction through the ordinary-error redaction guard.
- Acceptance: the registered read tool plus execution guard returns
  `tool_input_invalid` for a changed range with cursor-only retry advice, and a
  corrected continuation succeeds with the same handle. Wrong thread/resource,
  expired/released handles and stale files remain rejected; filesystem faults
  retain redacted `tool_failed` output and no stale read observation is recorded.
- Scope: type only application-owned range, file-identity and handle-input
  refusals as `ToolInputError`. Registry configuration/capacity/generation,
  impossible source positions, file I/O and projection invariants remain faults.
- Planned local checks: real-filesystem read suite, cursor registry suite,
  execution guard suite, contract budget guard, formatting and desktop type checks.
  Required delivery checks: Static, Unit, Build, Web E2E, Desktop E2E.
- PR search for BST-1892 found no matching fix (GitHub's numeric search also
  returned unrelated historical PR #1892).

## Implementation and regression evidence

The safe errors are the changed-range replay refusal, root/file identity refusal,
and malformed, unknown/released, expired and wrong resource/thread handle input.
They contain application-authored static copy only: no handle, path, provider
message or stored identity is interpolated. The source-position invariant still
throws an ordinary `Error`, as do registry capacity/configuration/generation and
file I/O failures. No cursor is consumed by a rejected range or scope.

Guard: `apps/desktop/src/__tests__/assistant-server/assistant-tools-read.integration.test.ts`
(registered tool plus real execution guard),
`read-workspace-file-cursor-registry.test.ts` and
`packages/agent/src/__tests__/guard-tool-execution.spec.ts`.

- RED: seven new real-filesystem guarded cases failed with generic `tool_failed`;
  the filesystem redaction control passed.
- GREEN: the same eight targeted cases passed after the narrow error typing.
- Full local verification: read integration suite (107), cursor registry suite
  (8), execution guard suite (24), contract budget/backreferences (8), frozen
  install, desktop dependency build, Ultracite fix/check, desktop main type
  program and desktop test program (616 files). No vendor code or guard changed.
