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
- **Every policy path is shape-checked, then RESOLVED, and anything ambiguous
  is refused.** A GLOB in `allowRead` is rejected — srt would expand it into
  paths the containment guard never compared, so `allowRead: ['~/.config/*']`
  would silently re-open `~/.config/gcloud`. A RELATIVE path is rejected (srt
  resolves it against the Node process cwd, not `scratchDir`), as is a `..`
  segment and a `~` (never expanded — see the seam's rule).
- **Containment compares `realpath` output, and NEVER folds case.** Case
  sensitivity is a filesystem property, not a platform one: APFS is
  case-insensitive by default but can be formatted case-sensitive, so
  `platform === 'darwin'` does not imply it. `realpath` returns the canonical
  on-disk spelling, so a case-insensitive volume resolves `~/.SSH` to `~/.ssh`
  naturally while a case-sensitive volume correctly keeps them distinct —
  correct on both, no platform guessing. It also catches a symlink pointing
  into a denied store, which no textual comparison can. The failure directions
  are why: folding case makes containment MORE permissive, i.e. a false PERMIT
  at validation that then fails opaquely when srt applies the real policy;
  not folding can only produce a false reject, which is confusing but never
  unsafe.
- **`scratchDir`, `allowWrite` and `allowRead` entries MUST exist.** A path
  that does not exist has no canonical form, so it raises `FencePolicyError`
  rather than being guessed at. Deny rules are the deliberate exception —
  they canonicalize best-effort, because a host without `~/.gnupg` is normal,
  not an error, and there is nothing there to re-open.
- The resolver is injected (`FencePathResolver`, defaulting to
  `fs.promises.realpath`) so the mapping stays in the cacheable unit lane;
  the real-filesystem behaviour is proven in the integration lane.
- **The sandboxed process environment is an ALLOW-LIST, never a pass-through**
  (`INHERITED_ENV_VARS`: `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `PATH`,
  `TMPDIR`, `TZ`). Denying `~/.aws` on disk is pointless if
  `AWS_SECRET_ACCESS_KEY` — or this app's provider API keys — ride in on the
  environment, and that channel is not covered by any filesystem rule.
  Anything an interpreter needs beyond the list is named explicitly on
  `FenceInterpreter.env`. Keys srt CHANGED in the env it returns are carried
  over, so a future srt that starts returning proxy vars in `env` keeps
  working without reopening the host environment. Proven by an integration
  test that plants secret-shaped vars in the parent and asserts their absence.
- **`scratchDir` is always writable** and listed first in
  `filesystem.allowWrite`; the script srt runs is written there with
  `mode: 0o600` (this module does not own `scratchDir`, and a shared one would
  otherwise leave a window where another local user could read or replace the
  script) and removed after the run.
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
- **The deadline starts when `execute()` is entered, not at spawn.** Because
  executions are serialized, a spawn-scoped timer would silently mean
  "queue wait + `timeoutMs`" and a caller behind two other runs could not tell
  a queue from a hung fence. If the whole budget elapses while queued, nothing
  is spawned and `FenceQueueTimeoutError` is thrown — never a fabricated
  `ExecResult` for code that did not run.
- **Timeout kills the whole process TREE, and no path settles before the group
  is down.** Children are spawned `detached: true` (so the child is a
  process-group leader) and the timeout signals the negative pid: SIGTERM,
  then SIGKILL after 500 ms. `timedOut` is set; the exit code is
  `128 + signum` when no code is available. Settling on `'close'` alone would
  be a bug: a descendant that detaches its stdio closes our pipes while still
  running, so an early settle would clear the pending SIGKILL and return with
  that process alive — free to still be running when `updateConfig()` installs
  the NEXT execution's allow-list. So `'close'` only settles once the root's
  exit status is known, and the settle path itself SIGKILLs the group. Two
  proven tests cover this: a grandchild does not outlive a timeout kill, and a
  detached-stdio descendant does not outlive a normal completion. Live groups
  are also reaped on the host's `process exit` event —
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
missing (platform, srt dependency, interpreter, or unsandboxed reachability of
the probe URL) — never by weakening an assertion. The reachability guard
matters in both directions: without it the allow-list test fails RED on a host
with restricted egress, AND its sibling network-deny test would pass
VACUOUSLY, asserting a leak guard it never actually exercised.

### VM executor (mode two)

Design-only ADR (BST-1069); Virtualization.framework, macOS-first. No
implementation yet — do not design other code against a VM backend existing.

When changing this flow, update this doc and the paired spec in the same
change.
