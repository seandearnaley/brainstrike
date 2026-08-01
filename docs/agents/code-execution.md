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

**Everything two backends could disagree about is decided here, once.** That is
the whole point of the module: a rule left to each backend (what `timeoutMs: 0`
means, whether an unwritable `scratchDir` is an error, what happens when a
policy exceeds an executor's capabilities) becomes drift between `fence` and
`vm`, and drift is how silent degradation gets in.

- `CodeExecutor { execute(ExecInput): Promise<ExecResult>; capabilities();
  dispose() }`.
- `ExecutorKind = 'fence' | 'vm'`, derived from the exported `EXECUTOR_KINDS`
  tuple — that tuple is the single source of truth. `parseExecutorKind` is the
  strict boundary for persisted/workspace-supplied values; it renders rejected
  values without `JSON.stringify` so a BigInt or circular object cannot make
  the boundary throw a serialization `TypeError` instead of its contracted
  error.

## Validation is the whole request, not just the policy

`execInputSchema` validates every field, strictly (unknown keys rejected):

| Field | Rule |
| --- | --- |
| `code` | bounded by `MAX_EXEC_CODE_LENGTH` |
| `language` | one of `python` / `javascript` / `bash` |
| `timeoutMs` | positive finite integer, ≤ `MAX_EXEC_TIMEOUT_MS` |
| `maxOutputBytes` | positive finite integer, ≤ `MAX_EXEC_OUTPUT_BYTES` |
| `scratchDir` | absolute path, AND covered by `policy.allowWrite` |
| `signal` | a real `AbortSignal` — **required** |
| `policy` | `execPolicySchema` (below) |

Two of these are deliberate, load-bearing choices:

- **`signal` is required, not optional.** The desktop runtime aborts its
  registered execution controller when the user presses Stop
  (docs/agents/assistant-runtime.md), and native tools already receive that
  signal. Without it at this seam, a cancelled assistant run leaves a spawned
  process running and producing side effects until `timeoutMs` expires.
  Backends MUST terminate the process tree when it fires. An `AbortSignal` is
  trivially constructible, so requiring it costs a caller nothing and
  guarantees the propagation path exists.
- **`maxOutputBytes` is required**, so the capture bound is a property of the
  request rather than a per-backend constant. Otherwise the same script could
  return truncated output under one backend and complete output under another,
  with no way for the caller to know why.

`scratchDir ⊆ allowWrite` is enforced (`isPathCoveredBy`, segment-wise) because
the alternative is an interpreter that cannot write its own scratch dir,
failing as an opaque runtime error instead of a clear validation error.

`isPathCoveredBy` is exported and is the ONLY containment predicate backends
should use, including on runtime-computed paths. Its rules:

- **An unresolved `..` in either operand returns false.** It never claims
  coverage it cannot prove — a segment-prefix compare would report
  `/tmp/scratch/../../etc/passwd` as covered by `/tmp/scratch`. Resolve paths
  (`realpath`) before asking.
- **Separators follow the path's own shape.** A backslash is a separator only
  in a Windows-shaped path; on POSIX it is a legal filename character, so
  `/tmp/scratch\run` is a sibling directory named `scratch\run`, not a
  descendant of `/tmp/scratch`.
- **Case is folded only when an operand is Windows-shaped**, because
  drive-letter case is not stable across Node APIs. POSIX comparison stays
  case-sensitive.

Windows path forms are accepted by the schema, but no Windows backend exists
yet — the fence's Windows story is BST-1068.

## ExecPolicy shape rules (the seam owns these, not the backend)

`ExecPolicy` maps 1:1 onto sandbox-runtime's `SandboxRuntimeConfig`
(`allowWrite`/`allowRead`/`denyRead` → `filesystem.*`, `allowedDomains` →
`network.allowedDomains`). For that mapping claim to actually hold, entries are
shape-validated here:

- **Paths must be absolute**, contain no `..` segment, and are length- and
  count-bounded. A leading `~` is **rejected, never expanded**: srt resolves
  paths against its own process context, so a `denyRead: ['~/.ssh']` that
  reaches it unexpanded is a deny rule that silently protects nothing. Backends
  build home-relative deny lists from their own resolved home directory — see
  the FenceExecutor's always-deny list.
- **Domains** must be a hostname or a `*.example.com` wildcard. A **bare `*` is
  rejected**: `allowedDomains: []` meaning "no network" is this policy's
  safety-critical invariant, and one wildcard entry would invert it.
  Unrestricted egress is deliberately not expressible in `ExecPolicy`.

## Capability reconciliation — backends MUST call it

`assertExecRequestSatisfiable(capabilities, input)` throws typed
`ExecCapabilityMismatchError` when the request exceeds what the executor
advertises:

- `input.language` not in `capabilities().languages` → `language_unsupported`.
- `policy.allowedDomains` non-empty while `supportsNetwork` is false →
  `network_unsupported`. Running that script with networking quietly off is a
  *stronger* sandbox but a *wrong* result: it completes with exit code 0 and
  missing data.

Backends call this at the top of `execute()`. The rule lives here so `fence`
and `vm` cannot answer it differently.

## Two-mode resolution — NO DOWNGRADE (settled, do not relitigate)

`resolveCodeExecutor(requested, host)` picks a backend from
`CodeExecutorHostCapabilities { fence?: factory; vm?: factory }`. Capability
gating is "does the factory exist?" — never `isElectron()`, never platform
sniffing. A mode the host cannot satisfy throws the typed
`ExecutorKindUnavailableError` in BOTH directions: `vm` on a fence-only host
AND `fence` on a bare host. There is deliberately no `vm`→`fence` fallback.

**Factory presence is not evidence of isolation.** The resolver additionally
asserts the returned executor's `capabilities().maxIsolationTier` equals
`REQUIRED_ISOLATION_TIER[kind]` (`fence` → `'os-fence'`, `vm` → `'vm'`) and
throws `ExecutorTierMismatchError` otherwise. Without that check, a backend
that degraded internally (srt failing to apply Seatbelt/bubblewrap, a VM host
falling back to a plain process) would be handed back under the requested kind
and the workspace would silently get weaker isolation than it asked for — the
exact thing the no-downgrade rule exists to prevent. A backend that cannot
apply its platform sandbox MUST throw at construction rather than return a
weaker executor.

**Lifetime: the caller owns the returned executor.** Each `resolveCodeExecutor`
call invokes the factory, so each call yields a NEW executor that the caller
must `dispose()`. Free for the null stub; emphatically not free for a
VM-backed or proxy-owning backend.

## ExecResult semantics

```ts
{ exitCode: number | null; signal: string | null;
  stdout: string; stdoutOmittedBytes: number;
  stderr: string; stderrOmittedBytes: number;
  timedOut: boolean }
```

- `exitCode` is `null` exactly when the process was terminated by a signal —
  including a timeout kill — and `signal` names it. Pinning this here stops
  each backend inventing its own convention (`-1`, `124`, the signal number)
  that the tool layer would then have to normalize per-backend.
- Per-stream omitted byte counts replace a single `truncated` boolean (the
  shape the ticket originally named): one flag for two streams cannot say which
  stream was cut, and a boolean cannot tell the model whether 1 KB or 100 MB
  was dropped. `isExecResultTruncated(result)` is the convenience predicate.
- stdout/stderr are executor-bounded by `maxOutputBytes`; the tool layer's
  model projection still owes the standard tool output budgets
  (docs/agents/assistant-providers.md).

## Permission engine relationship

Approval/permission gating happens ABOVE this seam. The run_python tool is an
execute-risk native tool gated by the existing permission engine
(docs/agents/assistant-runtime.md § PERMISSION ENGINE) — ask/allow/deny and
approval suspension are decided before `execute()` is ever reached. The seam
never re-implements or bypasses that gate, and executor errors never
auto-approve or auto-decline anything.

The UX design for that gating — the pre-run approval card, the network
escalation, the result surface, and the remember-choice scope — is specified in
`docs/run-python-approval-ux-design-2026-08-01.md` (BST-1070, DESIGN ONLY;
implementation blocked on BST-1067). Its load-bearing ruling: a non-empty
`ExecPolicy.allowedDomains` escalates on the SUSPEND channel, not the approval
channel, because Mastra's `requireApproval` is per-tool and cannot be
conditioned on a single call's arguments — so an approval-channel escalation
would be silently skipped by any session/per-tool grant. That doc also records
four gaps in this seam's expressiveness (no incremental output channel, no
omission POSITION alongside the omitted byte counts, no read-list provenance,
and no channel for host-computed approval display context).

## The null stub

`createNullCodeExecutor({ platform })` lets tool code integrate against the
seam before any backend lands. It spawns nothing: every `execute()` rejects
with the typed `NoSandboxConfiguredError`, and its capabilities are honest
(`maxIsolationTier: 'none'`, `supportsNetwork: false`, `languages: []`).

Because it reports tier `'none'`, it **cannot be registered as a host's
`fence`/`vm` factory** — the resolver rejects it with
`ExecutorTierMismatchError`. That is intentional: a stub masquerading as a real
fence is precisely the confusion the tier check exists to catch. Tool code
integrates with it directly.

## Backends

- **FenceExecutor (BST-1062)**: wraps a bundled pinned CPython
  (python-build-standalone, BST-1061) with `@anthropic-ai/sandbox-runtime`
  (Seatbelt / bubblewrap / Windows restricted token). srt is a beta — pin the
  exact version, no caret.
- **VM executor (mode two)**: design settled in ADR-0003 (BST-1069) —
  `docs/adr/0003-mode-two-full-isolation-vm.md`, **Accepted 2026-08-01**.
  Embeds Virtualization.framework directly in a signed helper process,
  macOS/Apple silicon first; one warm VM per workspace (cap 1, LRU evict),
  a rootfs we own and fetch-verify on first enable, granted-folder VirtioFS
  shares only (never `/` or `$HOME`), no guest NIC at all (egress via a
  host-side deny-first proxy over vsock), plus a bubblewrap+seccomp fence
  inside the guest that is load-bearing for policy fidelity, not just defense
  in depth. Gating mode two on a user-installed Docker/OrbStack/Podman is
  **rejected** (ADR-0003 D9) — do not propose it as a shortcut. Still no
  implementation: do not design other code against a VM backend existing.

When changing this flow, update this doc and the paired spec in the same
change.
