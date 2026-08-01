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

## Backends

### FenceExecutor (BST-1062, LIVE)

`packages/agent/src/fence/` — exported as the Node-only subpath
`@brainstrike/agent/fence-executor` (never from the root, `client`, or
`browser-safe` entries; srt stays `external` in tsup, the `mcp-client`
precedent). Paired tests: `fence-policy.spec.ts` (unit lane, pure mapping) and
`fence-executor.integration.spec.ts` (integration lane, REAL Seatbelt/bwrap).

- **srt version: `@anthropic-ai/sandbox-runtime` pinned EXACTLY to `0.0.67`**
  in the workspace catalog (`catalogMode: strict` means every package
  references the catalog; the catalog entry itself carries no caret). It is a
  fast-moving beta — re-derive the boundary from its README/`.d.ts` before
  bumping, never from memory.
- **Platforms: darwin + linux only.** `isFenceSupported()` is the probe and
  `createFenceExecutorFactory()` returns `undefined` on anything else, so an
  unsupported host simply has no `fence` capability and `resolveCodeExecutor`
  throws `ExecutorKindUnavailableError`. Windows is srt-alpha (needs a
  provisioned sandbox user + WFP fence) and its process-tree kill is
  unverified here — deliberately NOT offered rather than shipped untested.
- **Interpreters are injected** (`interpreters: { python: { command, args?,
  scriptExtension } }`). This module never guesses a binary path; BST-1061
  owns resolving the bundled CPython. `capabilities().languages` is exactly
  the injected key set, and an un-injected language throws
  `FenceUnsupportedLanguageError`.
- **Always-deny-read** (`ALWAYS_DENY_READ_PATHS`, applied on top of every
  policy): `.ssh`, `.aws`, `.gnupg`, `.config/gcloud`, `.config/gh`, `.kube`,
  `.docker`, `.netrc`, `.npmrc`, `.pypirc` — resolved to ABSOLUTE paths from
  `os.homedir()` here, not handed to srt as `~/...`: a path this sensitive
  must not depend on another package's tilde expansion. They stay literal
  (never globbed) because a literal deny is the one srt re-applies on top of a
  broader `allowRead`. An `allowRead` entry AT or UNDER one of these throws
  `FencePolicyError`; it is never silently dropped. An ANCESTOR entry is fine
  (srt re-emits the nested deny).
- **`scratchDir` is always writable** and listed first in
  `filesystem.allowWrite`; the script srt runs is written there and removed
  after the run.
- **Session lifecycle: initialize ONCE per process, `updateConfig` per
  execution.** `SandboxManager` is a process-global singleton — a second
  `initialize()` is a no-op, and its network proxy reads the module-level
  config at *request* time. So the wrap-time `customConfig` override alone
  would leave the proxy filtering on a stale allow-list; both are applied.
  Because that state is global, executions are SERIALIZED process-wide (a
  module-level queue) and executors are refcounted: `dispose()` calls
  `SandboxManager.reset()` only when the last one goes away.
  `cleanupAfterCommand()` runs after every execution (it clears bwrap mount
  points; inert elsewhere, but one code path).
- **Timeout kills the whole process TREE.** Children are spawned
  `detached: true` (so the child is a process-group leader) and the timeout
  signals the negative pid: SIGTERM, then SIGKILL after 500 ms. `timedOut` is
  set; the exit code is `128 + signum` when no code is available. A proven
  test asserts a grandchild spawned by the sandboxed code does not outlive
  the kill. Live groups are also reaped on the host's `process exit` event —
  `detached` means a run would otherwise outlive the timer that bounds it.
  **Residual risk**: a hard crash of the host process (SIGKILL) cannot run
  that reaper, so a sandboxed run would keep going — still inside its fence,
  but unbounded. Removing that needs an out-of-process supervisor, not a
  change here.
- **Capture cap: 1 MiB per stream** (`FENCE_MAX_STREAM_BYTES`). Beyond it
  bytes are dropped and `truncated` is set, while the pipes keep draining so
  the sandboxed process never blocks. The tool layer still owes its own model
  projection budget (docs/agents/assistant-providers.md).

The integration suite skips only with a message naming exactly what is
missing (platform, srt dependency, or interpreter) — never by weakening an
assertion.

### VM executor (mode two)

Design-only ADR (BST-1069); Virtualization.framework, macOS-first. No
implementation yet — do not design other code against a VM backend existing.

When changing this flow, update this doc and the paired spec in the same
change.
