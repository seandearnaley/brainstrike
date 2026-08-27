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
- **Windows has more aliases than symlinks, and `isPathCoveredBy`'s case-fold
  is the same guess this section rejects on darwin** (BST-1068; latent today —
  no Windows backend exists, so nothing Windows-shaped reaches the predicate
  from a real host). Whoever builds one owns this:
  - NTFS aliases a path far more ways than APFS does: **8.3 short names**
    (`C:\PROGRA~1` ≡ `C:\Program Files`), trailing dots/spaces, alternate data
    streams, the `\\?\` extended-length prefix (which bypasses Win32
    normalization outright — srt ships `stripExtendedPathPrefix` for it), and
    reserved device names. **MEASURED on Windows 11 x64 / Node 24.14.0
    (BST-1068 §7.3a): `fs.realpath` canonicalized NEITHER — it returned the 8.3
    short spelling unchanged and an uppercased path unchanged.** That is the JS
    resolver copying non-symlink components verbatim; only `realpath.native`
    reaches libuv, which is why `fence-policy` defaults to it (BST-1074).
    Whether `.native` expands 8.3 short names on NTFS is a *different* Win32
    behaviour and is **still unproven** — do not assume it from its darwin case
    behaviour. Until measured, a Windows backend must canonicalize explicitly
    (`GetFinalPathNameByHandleW`/`GetLongPathNameW`, or file-identity
    comparison) and verify it before comparing coverage.
  - `isPathCoveredBy` folds case on the **volume prefix only** (1 segment for a
    drive letter, 2 for UNC — host *and* share are both case-insensitive at the
    SMB level). It previously folded every segment while its justification
    covered only the drive letter, which is the same platform-shaped guess this
    section rejects for darwin: NTFS supports **per-directory** case sensitivity
    (`fsutil file setCaseSensitiveInfo`, which WSL sets on directories it
    creates), so a false PERMIT was reachable. Narrowed in BST-1074 — and note
    the dependency: the narrowing is only safe **because** resolution is
    supposed to deliver canonical on-disk spelling for the path body, which is
    exactly the guarantee the bullet above shows is not yet established on
    Windows. The two must move together.
  - **A mapped network drive is not a path the sandbox can resolve at all.**
    srt fails such a launch with a typed `mapped_drive_cwd` error (exit 16)
    because per-user drive mappings do not exist under the sandbox account's
    logon. On a separate-account fence, drive letters are caller-scoped state,
    not machine-global facts.

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

## The run_python tool (BST-1067, LIVE)

`packages/agent/src/tools/run-python-tool.ts`, exported from the package root
as `createRunPythonTool`. Paired tests: `run-python-tool.spec.ts` (unit lane,
stub executors) and `run-python-tool.integration.spec.ts` (integration lane,
REAL Seatbelt/bwrap + a real interpreter). Registered by the desktop
composition root in `apps/desktop/src/assistant-server/assistant-tools.ts`.

- **GATE A IS THE FRAMEWORK'S PRE-EXECUTION APPROVAL (BST-1097, re-based at
  the @mastra/core ^1.57 adoption).** Under an `'ask'` policy the permission
  gate registers run_python as an ordinary `requireApproval` clone — the same
  idiom as every other ask tool — and Mastra collects the approval BEFORE
  `execute()` runs (same `tool-call-approval` chunk, card, grant surface, and
  approve/decline transport as always). Approve is consumed by the framework
  and the tool runs once; decline never reaches the tool, and **since
  `@mastra/core` 1.59 (BST-1282) the decline leg streams a `tool-output-denied`
  chunk** carrying `{toolCallId, toolName, args?, approval:{id, approved:false,
  reason?}}`. That SUPERSEDES the older "decline streams NO tool result"
  statement: Brainstrike maps the chunk (disposition `'mapped'`, decoded in
  `mastra/tool-event-mapper.ts`) to the DECLINE terminal — `StreamChunkTool`
  status `'declined'`, carrying the shared `DeclinedToolCallResult` envelope —
  so the call settles with a `toolCallResult` and its durable `tool.started`
  pairs off against a `tool.failed` row relabelled `Tool call declined`.
  Without that mapping the renderer's tool part would stay pending forever —
  the hang mastra #20886 shipped this chunk to fix. It is deliberately NOT the
  ERROR terminal: a decline queues no visible failure text and sets no
  `isError`, or a decline followed by no model text would read as "I couldn't
  complete the tool action because it failed" (see docs/agents/mastra-boundary.md,
  1.57 → 1.59). Because the envelope is `{kind: 'declined', …}`, a run_python
  decline still lands on THIS tool's own muted declined surface rather than a
  generic card. The approval card's "Declined" state still owns the primary UX,
  identical to every other ask tool; the tool's typed `declined` result arm
  remains legacy, kept only for pre-rework persisted threads. Paired tests:
  `mastra-tool-approval-chunks.spec.ts`, *"settles the declined tool call from
  the 1.59 tool-output-denied chunk instead of leaving it pending"* (mutation-
  checked: treating the chunk as ignored fails it) and *"does NOT report a
  declined tool call as a failure when the denial is the last chunk before
  finish"*, plus the envelope case in `run-python-result.test.tsx`. The
  pre-1.56 design (self-raised in-tool
  approval suspension; the flag forbidden) is DEAD: 1.56's approval rework
  consumes `{approved}` resumes before the tool can read them, and the same
  rework is what makes the flag safe — the suspend-resume transport now
  attaches the `approved: true` rider Mastra's per-leg re-check demands, so
  the flag no longer kills the tool's own Gate B resume
  (`createToolResumeIteratorFromRuntime`, agent-streaming.ts). The injected
  `resolveApprovalDecision()` (REQUIRED factory option; the desktop derives it
  from the request's permission snapshot via `resolveSelfApprovalDecision`,
  the same resolver the permission gate uses) now arms ONLY the
  direct-invocation guard: `'ask'` with no suspension channel refuses with
  `approval_confirmation_unavailable`, never an unprompted run. Resume data
  matching no known shape still refuses with `resume_unrecognized` rather
  than mislabelling transport drift as a user decision (`network_denied` is
  reserved for answers the user actually gave). Regression proof: the GATE A
  + GATE B case in `mastra-tool-suspend-resume.integration.spec.ts` asserts
  the EXECUTOR ran on the approve→allow path — final-text assertions are
  vacuous here (the scripted model prints its text regardless of the tool
  result, which is how the original defect shipped green).
- **NETWORK IS EXPRESSIBLE ONLY THROUGH GATE B (BST-1070, LIVE).** The input
  schema accepts `allowedDomains` (validated by the seam's exported
  `policyDomainSchema` — a bare `*` and single-label wildcards never parse),
  but a request alone opens NOTHING: the tool suspends with the exact domain
  list BEFORE the host is even resolved, and the policy stays `[]` unless the
  per-call escalation resumes with an explicit allow. The suspension channel
  has NO grant surface, so no session grant, per-tool override, or `yolo`
  posture ever pre-answers it; anything that is not exactly
  `{action:'allow'}` denies (`network_denied`, carrying `deniedDomains` so
  the model can rewrite offline), and a missing channel (direct invocation)
  refuses with `network_confirmation_unavailable` rather than running
  offline-with-exit-0 or granting silently. Both directions are
  mutation-proven in `run-python-tool.spec.ts`. The prerequisite that kept
  this inexpressible (suspend rediscovery across reloads) closed in BST-1084.
  - **A suspending tool is STORAGE-GATED**: without Mastra workflow storage
    `run_python` is fail-safe omitted entirely (a pause that cannot resume
    must never be armed) — which also keeps it off Hosted Web.
  - **run_python lives in the DEFERRED `execution` discovery namespace**: a
    scripted test model must load it via `search_tools` first, or the
    ToolNotFoundError it gets is the discovery surface working, not a
    suspension bug (see the Gate B integration proof's comment).
  - **Testing the deny is easy to get VACUOUSLY right.** srt enforces
    `allowedDomains` at its HTTP PROXY, so a raw `socket.create_connection` is
    refused by the fence whatever the policy says — a raw-socket assertion
    passes identically with `allowedDomains: []` and `['example.com']`, i.e.
    it proves nothing about the policy. The integration proof uses `urllib`
    (the proxied path) and is mutation-checked: granting the domain makes it
    fail. Keep it that way.
- **Registered as the factory-returned Mastra Tool object**, never re-wrapped
  in the desktop registry's `{description, execute, id, inputSchema}` literal —
  that shape drops `suspendSchema`, which is exactly what BST-1070 will add.
  A desktop test asserts the real Tool object so the trap is armed before the
  schema exists. Excluded for the built-in local provider, alongside
  `askUser`/`submitPlan`.
- **Per-call scratch dir is the only writable path**: `mkdtemp` under
  `os.tmpdir()`, `realpath`'d (macOS `/var` → `/private/var`, and the seam
  compares resolved paths for `scratchDir ⊆ allowWrite`), removed in a
  `finally` on every exit path. Under `os.tmpdir()` rather than userData so a
  hard-crash orphan is reaped by the OS.
- **Five distinct terminal states**, mapped in `toRunPythonResult`:
  `completed` (the ONLY arm carrying `exitCode`, so a signal kill can never
  render as exit 0), `timed_out`, `killed` (`exitCode: null` with
  `timedOut: false` — a REAL state per the seam's "including a timeout kill",
  reachable via SIGSEGV/OOM, not a defensive branch), `cancelled` (carries
  partial output; never an empty success), and `unavailable`. An unrecognised
  error RETHROWS rather than being labelled with a diagnosis this layer cannot
  make.
- **`interpreter_unavailable` is distinct from `no_sandbox_configured`.** Host
  resolution is async (the bundled CPython may need a first-run unpack), and a
  `python_*`-coded failure from BST-1061's resolver maps to its own reason so
  the user is told WHICH half is missing. Matched structurally by code prefix —
  this package must not depend on `apps/desktop`, and the seam's own codes are
  all `exec_*`/`executor_*`/`fence_*`, so the prefixes cannot collide.
- **Output is bounded twice, and both counts are reported.** The executor cap
  (`RUN_PYTHON_MAX_OUTPUT_BYTES`) stops a runaway loop exhausting memory; the
  model projection fits the tool budget. Anything the projection trims is ADDED
  to the executor's `stdoutOmittedBytes`/`stderrOmittedBytes`, so the model can
  tell "the script produced 4 MB" from "we showed you the last 10 KB". The tail
  is kept — a traceback ends with the exception.
- **The approval card's facts are server-computed (BST-1070 Gate A, LIVE).**
  `run-python-approval-context.ts` derives a `CodeExecutionApprovalContext`
  (tool-approval contract) from the SAME strict schema + constants execute()
  uses — network `[]`, scratch under `os.tmpdir()` (only the PARENT is namable
  pre-mkdtemp, hence `scratchParentDir`), `defaultReadAccess: 'permissive'`
  (the fence's honest read semantics — see the escape-resistance README), the
  shared timeout default (single-sourced with the tool via
  `RUN_PYTHON_DEFAULT_TIMEOUT_MS`). `policyFingerprint` rides the context so
  approval-time and execute-time terms are COMPARABLE; the execute-time
  enforcement is deliberately deferred until workspace exec config introduces
  a real drift input — today both sides are the same pure function of the
  durable args in the same process, so a compare would be a guard whose
  failure no test can provoke. Wire path + card behaviour:
  docs/agents/assistant-runtime.md § PERMISSION ENGINE step 4.

## Permission engine relationship

Approval/permission gating happens ABOVE this seam. run_python is an
execute-risk native tool whose allow/ask/deny DECISION comes from the existing
permission engine (docs/agents/assistant-runtime.md § PERMISSION ENGINE), and
since the @mastra/core ^1.57 adoption its `'ask'` ENFORCEMENT is the same
per-tool `requireApproval` clone every other execute-risk tool uses (the
1.56-era `approved: true` resume rider is what lets the flag coexist with the
tool's Gate B suspension — see the Gate A section above). The one in-tool
remnant is the DIRECT-invocation guard: outside an agent run, `'ask'` refuses
rather than running unprompted. `'deny'` still omits the tool from the map
before any call. The seam never re-implements or bypasses the decision, and
executor errors never auto-approve or auto-decline anything.

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

### FenceExecutor (BST-1062, LIVE)

`packages/agent/src/fence/` — exported as the Node-only subpath
`@brainstrike/agent/fence-executor` (never from the root, `client`, or
`browser-safe` entries; srt stays `external` in tsup, the `mcp-client`
precedent). Paired tests: `fence-policy.spec.ts` (unit lane, pure mapping) and
`fence-executor.integration.spec.ts` (integration lane, REAL Seatbelt/bwrap).

- **srt version: `@anthropic-ai/sandbox-runtime` pinned EXACTLY to `0.0.73`**
  (bumped from `0.0.67` in BST-1285) in the workspace catalog (`catalogMode:
  strict` means every package references the catalog; the catalog entry itself
  carries no caret). It is a fast-moving beta — re-derive the boundary from its
  README/`.d.ts` before bumping, never from memory. The escape-resistance suite
  (BST-1071) ASSERTS this version, so a bump goes red until the suite is
  re-greened on macOS AND Linux; see
  `packages/agent/src/__tests__/fence-escape-resistance.README.md` for the
  required procedure and the guarantee/non-guarantee list. **CI cannot supply
  the Linux half**: no workflow installs `bwrap`/`socat`/ripgrep, so
  `describeHostSkipReason()` skips the whole suite there and only the ungated
  version-pin test runs. A Linux re-green has to come from a bubblewrap-equipped
  host, and the bump log has to say which platforms actually ran.
- **Platforms: darwin + linux only.** `isFenceSupported()` is the probe and
  `createFenceExecutorFactory()` returns `undefined` on anything else, so an
  unsupported host simply has no `fence` capability and `resolveCodeExecutor`
  throws `ExecutorKindUnavailableError`.
  - **The `platform === 'darwin' || platform === 'linux'` allow-list in
    `isFenceSupported()` is load-bearing — do not "simplify" it away.**
    `SandboxManager.isSupportedPlatform()` returns TRUE on Windows, so dropping
    the explicit allow-list and trusting srt's own probe silently enables
    Windows. `currentExecPlatform()` already accepts `'win32'`, so that one
    line is the entire gate.
  - **Why Windows is gated OFF (BST-1068, settled).** Not primarily maturity.
    srt's Windows backend is a real OS-kernel fence — a dedicated `srt-sandbox`
    user SID, WFP egress filters, additive NTFS DACLs — and would honestly
    report `maxIsolationTier: 'os-fence'`. The blocker is that **its filesystem
    scope is session-level**: `updateConfig()` warns and keeps the previously
    applied access set, and a per-exec `filesystem.allowRead`/`allowWrite`
    throws. The "initialize once, `updateConfig` per execution" lifecycle two
    bullets down is therefore inexpressible there — it would silently apply the
    FIRST run's filesystem policy to every later run — and no
    `ExecutorCapabilities` field can advertise that gap. Process-tree kill is a
    real secondary problem (`process.kill(-pid)` is POSIX-only).
  - **Confirmed on real Windows hardware, 2026-08-01.** The plan in the spike
    was executed on a provisioned Windows 11 x64 host. The fence itself works —
    Python ran as `srt-sandbox`, and a process that stripped every proxy env var
    was refused at `connect()` with `WSAEACCES`. Three measured results
    nonetheless keep the gate shut, and none of them is a maturity complaint:
    - **`reset()`+`initialize()` costs 1559 ms median** (ten cycles, fastest
      1531 ms). That is the only lifecycle that applies filesystem policy
      correctly on Windows, so per-execution `ExecPolicy` would add ~1.6 s of
      setup to every `run_python`.
    - **`filesystem.allowRead` is not read-only on Windows.** srt only ADDS
      ACEs, so a path whose existing ACL already grants write to a group the
      sandbox account belongs to (`Authenticated Users` — the default for
      anything created off `C:\`) stays writable. The same `ExecPolicy` is
      therefore weaker on Windows than under Seatbelt or bubblewrap.
    - **Path canonicalization did not behave as assumed** — see the Windows
      bullet under "resolve before asking" above.

    Full assessment, capability spec, the test plan, and the hardware results:
    `docs/agents/research/bst-1068-srt-windows-fence-spike.md`.
- **Interpreters are injected** (`interpreters: { python: { command, args?,
  scriptExtension } }`). This module never guesses a binary path; BST-1061
  owns resolving the bundled CPython. `capabilities().languages` is exactly
  the injected key set, and an un-injected language throws
  `FenceUnsupportedLanguageError`.
  - **The bundled-CPython resolver (BST-1061, LIVE) is
    `resolveDesktopPythonExecutable()` in `apps/desktop/src/python-runtime/`**
    — the desktop composition root resolves once and INJECTS the resulting
    absolute path; this package never imports it. It unpacks under
    `userData/python-runtime/` (a SIBLING of every always-deny store below,
    never a descendant, so the interpreter stays fence-readable) and fails
    with a typed `python_*` error family (`python_unsupported_platform`,
    `python_manifest_invalid`, `python_archive_missing`,
    `python_checksum_mismatch`, `python_unpack_failed`) kept disjoint from
    the seam's and fence's codes, so `run_python` can distinguish "no
    interpreter" from "no sandbox". There is no PATH-python fallback in any
    state. In development the desktop composition root locates the checked-in
    manifest and archive directory from the emitted `dist/main.js` module path,
    not `app.getAppPath()` (which is already `dist/` for direct-file E2E
    launches); packaged macOS builds use electron-builder's
    `<Resources>/python-runtime` resource.
- **Always-deny-read** (`ALWAYS_DENY_READ_PATHS`, applied on top of every
  policy): `.ssh`, `.aws`, `.gnupg`, `.config/gcloud`, `.config/gh`, `.kube`,
  `.docker`, `.netrc`, `.npmrc`, `.pypirc` — resolved to ABSOLUTE paths from
  `os.homedir()` here, not handed to srt as `~/...`: a path this sensitive
  must not depend on another package's tilde expansion. They stay literal
  (never globbed) because a literal path is what the containment checks compare
  against, and because the literal re-application on top of a broader
  `allowRead` is the srt behavior this layer verifies by execution. srt's
  GLOB-deny handling is version-dependent and is NOT relied on (0.0.72 changed
  macOS to re-emit glob denies where a broader allow used to clobber them; on
  Linux a glob deny is expanded by ripgrep at run time). An `allowRead` entry
  AT or UNDER one of these throws
  `FencePolicyError`; it is never silently dropped. An ANCESTOR entry is fine
  (srt re-emits the nested deny).
- **Every policy path is shape-checked, then RESOLVED, and anything ambiguous
  is refused.** A GLOB in `allowRead` is rejected — srt would expand it into
  paths the containment guard never compared, so `allowRead: ['~/.config/*']`
  would silently re-open `~/.config/gcloud`. A RELATIVE path is rejected (srt
  resolves it against the Node process cwd, not `scratchDir`), as is a `..`
  segment and a `~` (never expanded — see the seam's rule).
- **A ROOT-WIDE `allowRead` is refused** (`FencePolicyError`), even though it is
  a mere ancestor of the always-denied stores. Ancestors are normally safe
  because srt re-emits the nested deny after the broader allow — but through
  0.0.73 that re-emission tests `denied.startsWith(allowed + '/')`, which for
  `allowed === '/'` compares against `'//'` and never matches. **Measured on
  macOS (BST-1071): `allowRead: ['/']` made `~/.ssh/*` and the contents of
  `~/.config/gh/hosts.yml` readable from sandboxed code.** Re-measured against
  0.0.73's generated Seatbelt profile in BST-1285 and UNCHANGED — the root
  allow is still emitted after the credential deny under last-match-wins — so
  this refusal remains load-bearing, not redundant. Linux is unaffected
  (bubblewrap masks denied directories with tmpfs) — re-measured by execution
  under real bwrap at 0.0.73 in BST-1285 — so CI alone would not have caught it
  even if CI ran this suite, which it does not. That is why the refusal lives
  in the policy layer, not a platform branch. Every ancestor SHORT of the root
  is still accepted.
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
- **Timeout kills the whole process TREE, and no successful path settles before
  the group is down.** Children are spawned `detached: true` (so the child is a
  process-group leader) and the timeout signals the negative pid: SIGTERM,
  then SIGKILL after 500 ms. Sending SIGKILL is not itself proof of teardown:
  settlement waits up to 500 ms for a signal-0 probe to report `ESRCH` for the
  process group, so a runnable descendant cannot land one final side effect
  after a successful result. That confirmation is bounded because a zombie,
  uninterruptible process, or `EPERM` probe must not deadlock the process-global
  execution queue.

  **`EPERM` FROM THE PROBE IS INCONCLUSIVE, NOT A DENIAL — do not relitigate.**
  Every member of the group is our own descendant running as us, so a genuine
  permission failure is impossible; the same reasoning is recorded at
  `apps/desktop/src/terminal-ipc-handlers.ts` for its own group kill. What
  `EPERM` reports is the post-reap race — the leader is a just-SIGKILLed zombie
  and the kernel refuses to route a group signal through it. Measured against
  the real sandbox fence on macOS, the group reaches `ESRCH` about 7 ms later.
  Treating that first `EPERM` as fatal rejected EVERY normal teardown on that
  host (the BST-1437 follow-up).

  So `EPERM` polls on exactly like `alive`, and ONLY `ESRCH` returns. Returning
  early on `EPERM` would be unsound in the other direction, however it is
  corroborated: a process group can outlive its leader, so "the leader is gone"
  never proves the group is empty. An `EPERM` that survives the whole window is
  still a teardown failure, so the fail-closed guarantee is unchanged — a
  tracked group is released only by `ESRCH`. Failure rejects with `FenceProcessGroupTeardownError`; a
  completed `ExecResult` is attached as `outcome`, while cancellation remains
  an `ExecAbortedError` with the teardown error as its `cause` and partial output
  intact. The failed group remains tracked, and later executions fail closed
  before installing another process-global policy until `ESRCH` proves it gone.
  The timeout path shares one memoized SIGKILL confirmation rather than starting
  a second poll from its hard backstop. `timedOut` is set; the exit code is
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

#### Where the Linux half actually comes from (BST-1316, 2026-08-16, measured)

The srt bump procedure below requires re-greening on macOS AND Linux. **Until
2026-08-16 the Linux half was unobtainable from CI, and nothing said so.**
`SandboxManager.checkDependenciesAsync()` requires `bwrap`, `socat` and `rg` on
Linux; no workflow installed any of them, so all three real-fence suites
(`fence-executor`, `run-python-tool`, `fence-escape-resistance`) skipped
themselves on every Linux run — loud in the log, green in the check:

```
[fence-escape-resistance] SUITE SKIPPED — sandbox-runtime dependencies are missing
on this linux host: ripgrep (rg) not found, bubblewrap (bwrap) not installed,
socat not installed
✓ src/__tests__/fence-escape-resistance.integration.spec.ts (32 tests | 27 skipped)
```

The only assertion that ever ran on Linux was the ungated version pin. The
`unit-shard` job in `.github/workflows/test.yml` now supplies the half, and two
things beyond the install were load-bearing:

- **The install alone makes the lane RED, not covered.** On
  `ubicloud-standard-4` (Ubuntu 24.04.4, kernel 6.14.0-azure, bubblewrap 0.9.0)
  the three binaries install in ~8 s and the dependency check goes green — and
  then every fenced run dies before executing a line:
  `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, and under
  `--unshare-user`, `bwrap: setting up uid map: Permission denied`. Ubuntu
  23.10+ ships `kernel.apparmor_restrict_unprivileged_userns=1` and the image
  carries no AppArmor profile granting bwrap `userns create` (only the generic
  `unprivileged_userns` and `lxc-usernsexec` profiles). **Measured: installing
  the dependencies and nothing else took the suites from 27 quiet skips to 44
  failures across 3 files**, every one of them the same empty stdout. The lane
  therefore also lifts that sysctl — Ubuntu's own documented remediation, on an
  ephemeral VM that already runs this repo's code under passwordless sudo. It
  changes only whether bwrap can BUILD its namespace, never what the fence
  denies inside one, which is the entire subject of these suites. The install
  step ends with a bwrap smoke test so a future image change fails there, with
  the kernel's own message, rather than 40 assertions deep in a security suite.
- **The skip must not be able to go quiet again.** The Unit integration steps
  set `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`, which the shared host gate
  (`packages/agent/src/__tests__/fixtures/fence-host-gate.ts`) reads to
  escalate a skip into a collection failure. It is scoped to lanes that
  PROMISED the prerequisites: developer machines and the coverage lanes install
  nothing and keep the loud-skip behaviour. Because turbo runs tasks in Strict
  env mode, the variable is also declared on `test:integration` in
  `turbo.jsonc` — without that it never reaches vitest and the guarantee is
  inert.
  - **EVERY suite-wide reason escalates, not only the dependency one**, and the
    escalation therefore lives at the choke point that sees the COMPLETE reason
    (`refuseToSkipInAPromisedLane`), never inside the dependency check. Scoping
    it to `checkDependenciesAsync()` alone — the shape this first shipped as,
    caught in review — left three other roads to a green lane that proved
    nothing: no `python3` on `PATH` (all three suites), and an unreachable
    probe host, which skips `fence-executor` and `run-python-tool` *entirely*,
    filesystem and process-tree proofs included. The escape-resistance
    network-cases gate escalates too: silently dropping the egress proofs is
    the same broken promise as dropping the suite.
  - The network prerequisite is the debatable one, since it depends on hosts
    this repo does not control and a transient outage would red a required
    lane. Accepted deliberately: that failure names itself in one line and a
    reader can see it is not a code defect, whereas the silent skip it replaces
    is undiagnosable by construction. If it proves flaky the answer is a more
    robust probe, not a return to green-on-unrun.
  - The install step also asserts `python3 --version`, so a runner image that
    drops the interpreter fails as provisioning rather than reaching the
    runtime gate at all.

  Every leg — install, sysctl, interpreter, env flag, turbo declaration, and
  the completeness of the escalation — is pinned with control tests in
  `scripts/__tests__/linux-fence-lane-contract.test.mjs`.

An srt bump reaches this lane automatically: the pin lives in
`pnpm-workspace.yaml`, so the lockfile change puts `@brainstrike/agent` in
turbo's `...[origin/main]` selection (verified on the BST-1285 bump PR, whose
`Unit (rest)` job did collect the escape-resistance file — and skipped 27 of
its 32 tests, which is what surfaced all of this).

**One Linux assertion was platform-blind and is now fixed, not weakened.**
`fence-executor`'s "DENIES a CHILD process spawned by the sandboxed code from
writing outside scratchDir" matched only Seatbelt's wording. Seatbelt refuses
the open (`PermissionError` / "Operation not permitted"); bubblewrap masks
everything outside the write grant by re-mounting it read-only, so CPython
raises `OSError: [Errno 30] Read-only file system`. Its sibling "DENIES a write
outside scratchDir" already named that shape. The regex now enumerates both
rather than dropping to "any error" — the same test still asserts the file does
not exist and the child's return code is non-zero.

**Read this as a product finding too, not only a CI one.** `isFenceSupported()`
and `checkDependenciesAsync()` both look for binaries on `PATH`; neither builds
a sandbox. A stock Ubuntu 24.04+ host carries the same kernel restriction the
runner did, so on such a host the fence constructs successfully and then fails
per run with bubblewrap's message. That is not silent degradation — the run
reports a non-zero exit and the bwrap stderr, and `resolveCodeExecutor` never
hands back a weaker tier — but it is not diagnosable either, and no capability
field says "this host cannot build a namespace". Closing it needs a
construction-time probe that actually spawns through bwrap. **Filed as BST-1317
with the two candidate shapes** (throw at construction vs. report it as a
capability); deliberately not fixed alongside the CI lane.

#### Escape-resistance suite (BST-1071, LIVE)

`packages/agent/src/__tests__/fence-escape-resistance.integration.spec.ts`, with
`fence-escape-resistance.README.md` beside it. The contract suite above proves
the executor behaves; this one attacks it — traversal, symlink escape, fork /
multiprocessing / depth-2 grandchild inheritance, raw sockets that ignore the
proxy, DNS as an exfil channel, resource exhaustion shape, host-env exfiltration,
descendant survival across a policy change, and cancellation in both positions.

**Read the README before changing either file.** It is the honest statement of
what the fence does and does NOT guarantee (reads are permissive by default;
exfiltration via an allow-listed domain is unaddressed; CPU/memory are bounded
only by the timeout; kernel-level attacks defeat it entirely; there is no
always-deny list for WRITES), it carries the mutation-kill table proving each
security assertion actually detects the hole it names, and it records the srt
re-green procedure. srt is an OS fence, not a VM — mode two (ADR-0003) is the
answer for adversarial code, and this suite must not be read as claiming
otherwise.

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
