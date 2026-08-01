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
  `/tmp/scratch/../../etc/passwd` as covered by `/tmp/scratch`. Resolving
  first is a requirement, not just the fix for this case; see below.
- **Separators follow the path's own shape.** A backslash is a separator only
  in a Windows-shaped path; on POSIX it is a legal filename character, so
  `/tmp/scratch\run` is a sibling directory named `scratch\run`, not a
  descendant of `/tmp/scratch`.
- **Only the Windows VOLUME segments are case-folded** — the drive letter
  (`C:`), or the host AND share for a UNC path (`\\server\share`, both
  case-insensitive at the SMB protocol level). Never directory segments, never
  on POSIX. Volume case is what Node APIs spell inconsistently; directory
  segments are a different question, because NTFS supports per-directory case
  sensitivity (WSL enables it), so folding them could report coverage the
  filesystem does not grant. That is a false PERMIT, the unsafe direction, and
  the same platform-shaped guess this doc rejects for darwin below.
  Case-insensitive volumes are served correctly by resolving first — but only
  with the NATIVE resolver, see the next bullet.
- **Resolve with `realpath.native`, not `fs/promises`' `realpath`.** Node's JS
  implementation resolves symlinks but copies non-symlink components verbatim
  from the input string; it does NOT return the OS-canonical case. Only the
  native binding (`realpath(3)`, `GetFinalPathNameByHandleW`) does. Measured on
  darwin: for an on-disk `MixedCase`, the JS version returns `mixedcase`, the
  native one `MixedCase`. Since directory segments compare case-sensitively,
  the JS resolver silently voids both the containment guarantee and the
  always-deny check on a case-insensitive volume.

### Backends MUST resolve before asking (requirement, not advice)

`realpath` BOTH operands before calling `isPathCoveredBy`. An unresolved
operand is a security bug, not a style choice, because resolution is what
closes two concrete dodges that no textual comparison can:

- **A symlink into a denied store.** `allowRead: ['/opt/innocent']` compares
  as unrelated to `~/.ssh` — and then srt follows the link. Only the resolved
  path reveals it.
- **A case variant on a case-insensitive volume.** `~/.SSH` is textually
  unequal to `~/.ssh`, but APFS hands back the same directory.

**Do NOT "fix" the case problem by folding case on darwin.** Case sensitivity
is a filesystem property, not a platform one — APFS is case-insensitive by
default but can be formatted case-sensitive — so `platform === 'darwin'` is a
guess. It is also a guess in the DANGEROUS direction: folding makes containment
MORE permissive, producing a false PERMIT at validation that then fails
opaquely once srt applies the real policy. Not folding can only produce a false
reject: confusing, never unsafe. `realpath` is correct on both volume types
with no platform sniffing.

Corollaries:

- **A path with no canonical form is a typed error, never a guess.** A
  nonexistent `scratchDir`/`allowWrite`/`allowRead` entry raises the backend's
  typed policy error rather than being assumed.
- **Deny rules canonicalize BEST-EFFORT.** A host that legitimately lacks
  `~/.gnupg` is normal, not an error, and an absent path has nothing to
  re-open; keep the literal so the rule still reaches the sandbox.
- **macOS canonicalizes `/var/folders/…` → `/private/var/folders/…`** (`/var`
  is a symlink to `/private/var`), so anything derived from `os.tmpdir()` —
  which is where scratch dirs come from — changes spelling on resolution.
  Expect the resolved path, not the one you passed, in the config handed to
  the sandbox.

The FenceExecutor (`packages/agent/src/fence/fence-policy.ts`) is the reference
implementation, including the injected resolver that keeps this unit-testable.
**If a third backend appears, move this duty into the seam as a helper** —
deliberately not extracted at one consumer, where the shape would be a guess
derived from a single call site.

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

## Cancellation

`ExecInput.signal` firing means the run is over. Backends MUST terminate the
process tree, and MUST throw `ExecAbortedError` (`code: 'exec_aborted'`,
predicate `isExecAbortedError`) — for BOTH positions: aborted while queued
behind another execution, and aborted mid-run.

**Why an error and not an `ExecResult`.** `ExecResult` describes a run that
COMPLETED, normally or by timeout. Encoding an abort as a result would make it
distinguishable from a timeout only by the ABSENCE of a flag
(`exitCode: null, signal: 'SIGKILL', timedOut: false`), so every consumer would
have to reverse-engineer "why is `exitCode` null while `timedOut` is false?" —
exactly the implicit encoding this module exists to kill. One `catch` is the
whole contract.

Nothing is discarded: `partialStdout`, `partialStderr`, `stdoutOmittedBytes`
and `stderrOmittedBytes` ride on the error, so a debug bundle still has whatever
the process produced before it was killed, without pretending the run finished.
`processStarted` separates "nothing ever spawned" (no side effects) from
"killed mid-run" (possible partial ones).

A backend that serializes executions must honour an abort WHILE QUEUED, not
only once spawned — otherwise pressing Stop behind two other runs waits for
them.

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
with the typed `NoSandboxConfiguredError`, and its capabilities are honest
(`maxIsolationTier: 'none'`, `supportsNetwork: false`, `languages: []`).

Because it reports tier `'none'`, it **cannot be registered as a host's
`fence`/`vm` factory** — the resolver rejects it with
`ExecutorTierMismatchError`. That is intentional: a stub masquerading as a real
fence is precisely the confusion the tier check exists to catch. Tool code
integrates with it directly.

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
- **Containment compares `realpath` output** — the reference implementation of
  the seam's "resolve before asking" requirement above, including the
  nonexistent-path error and the best-effort deny canonicalization. The
  resolver is injected (`FencePathResolver`, defaulting to
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
- **Capture honours the request's `maxOutputBytes`**, not a backend constant,
  and COUNTS what it drops into `stdoutOmittedBytes` / `stderrOmittedBytes` —
  per stream, so 1 KB of loss is distinguishable from 100 MB. Bytes past the
  cap are dropped rather than buffered (a runaway loop must not exhaust
  memory) while the pipes keep draining so the sandboxed process never blocks.
  The tool layer still owes its own model projection budget
  (docs/agents/assistant-providers.md).
- **Cancellation**: `input.signal` is honoured while QUEUED as well as while
  running — pressing Stop behind two other executions must not wait for them.
  Either position throws `ExecAbortedError`; the mid-run path kills the group
  first and carries the partial output on the error. Both are tested, and the
  real-fence test asserts a grandchild does not outlive the abort.
- **Capability reconciliation**: `execute()` re-parses `execInputSchema` and
  calls `assertExecRequestSatisfiable` before touching the filesystem, so a
  caller that bypassed the seam still cannot reach a spawn.

The integration suite skips only with a message naming exactly what is
missing (platform, srt dependency, interpreter, or unsandboxed reachability of
the probe URL) — never by weakening an assertion. The reachability guard
matters in both directions: without it the allow-list test fails RED on a host
with restricted egress, AND its sibling network-deny test would pass
VACUOUSLY, asserting a leak guard it never actually exercised.

### VM executor (mode two)

Design settled in ADR-0003 (BST-1069) —
`docs/adr/0003-mode-two-full-isolation-vm.md`, **Accepted 2026-08-01**. Embeds
Virtualization.framework directly in a signed helper process, macOS/Apple
silicon first; one warm VM per workspace (cap 1, LRU evict), a rootfs we own
and fetch-verify on first enable, granted-folder VirtioFS shares only (never
`/` or `$HOME`), no guest NIC at all (egress via a host-side deny-first proxy
over vsock), plus a bubblewrap+seccomp fence inside the guest that is
load-bearing for policy fidelity, not just defense in depth. Gating mode two on
a user-installed Docker/OrbStack/Podman is **rejected** (ADR-0003 D9) — do not
propose it as a shortcut. Still no implementation: do not design other code
against a VM backend existing.

When changing this flow, update this doc and the paired spec in the same
change.
