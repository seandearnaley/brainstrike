# Agent Code Execution: the CodeExecutor Seam

> Created for BST-1060 (Agent Code Sandboxing — Two-Mode Path). Read before
> touching code execution, sandbox backends, or the run_python tool chain.
> Keep this doc and its paired tests updated with the code.

## The seam (BST-1060, LIVE)

`packages/agent/src/code-execution.ts` (exported as
`@brainstrike/agent/code-execution`) is the single module every execution
backend plugs into. It sits between the tool-dispatch layer (Mastra runtime in
Electron main) and the actual process spawn. Paired tests:
`packages/agent/src/__tests__/code-execution.spec.ts`.

- `CodeExecutor { execute(ExecInput): Promise<ExecResult>; capabilities();
  dispose() }`.
- `ExecPolicy` is a STRICT zod schema (`execPolicySchema`): unknown keys,
  blank entries, and missing `allowWrite`/`allowedDomains` throw. It maps 1:1
  onto sandbox-runtime's `SandboxRuntimeConfig`
  (`allowWrite`/`allowRead`/`denyRead` → `filesystem.*`, `allowedDomains` →
  `network.allowedDomains`). **`allowedDomains: []` means NO network** — srt's
  proxy denies every connection matching no allowed domain; there is no
  separate "network off" flag to drift out of sync.
- `ExecResult { exitCode, stdout, stderr, timedOut, truncated }` —
  stdout/stderr must already be executor-bounded; the tool layer's model
  projection still owes the standard tool output budgets
  (docs/agents/assistant-providers.md).
- `ExecutorKind = 'fence' | 'vm'`. `parseExecutorKind` is the strict boundary
  for persisted/workspace-supplied mode values; anything else throws.

## Two-mode resolution — NO DOWNGRADE (settled, do not relitigate)

`resolveCodeExecutor(requested, host)` picks a backend from
`CodeExecutorHostCapabilities { fence?: factory; vm?: factory }`. Capability
gating is "does the factory exist?" — never `isElectron()`, never platform
sniffing. A mode the host cannot satisfy throws the typed
`ExecutorKindUnavailableError` (`requestedKind`, `availableKinds`,
`code: 'executor_kind_unavailable'`) in BOTH directions: `vm` on a fence-only
host AND `fence` on a bare host. There is deliberately no `vm`→`fence`
fallback — silently weakening the isolation a workspace asked for is exactly
the degradation the two-mode design forbids.

## Permission engine relationship

Approval/permission gating happens ABOVE this seam. The run_python tool is an
execute-risk native tool gated by the existing permission engine
(docs/agents/assistant-runtime.md § PERMISSION ENGINE) — ask/allow/deny and
approval suspension are decided before `execute()` is ever reached. The seam
never re-implements or bypasses that gate, and executor errors never
auto-approve or auto-decline anything.

## The null stub

`createNullCodeExecutor({ platform })` lets tool code integrate against the
seam before any backend lands. It spawns nothing: every `execute()` rejects
with the typed `NoSandboxConfiguredError` (`code: 'no_sandbox_configured'`),
and its capabilities are honest (`maxIsolationTier: 'none'`,
`supportsNetwork: false`, `languages: []`). The tool layer maps the typed
error to a model-visible structured failure; it must never fabricate an
`ExecResult` for code that did not run.

## Backends (tracked, not yet landed)

- **FenceExecutor (BST-1062)**: wraps a bundled pinned CPython
  (python-build-standalone, BST-1061) with `@anthropic-ai/sandbox-runtime`
  (Seatbelt / bubblewrap / Windows restricted token). srt is a beta — pin the
  exact version, no caret.
- **VM executor (mode two)**: design-only ADR (BST-1069);
  Virtualization.framework, macOS-first. No implementation yet — do not
  design other code against a VM backend existing.

When changing this flow, update this doc and the paired spec in the same
change.
