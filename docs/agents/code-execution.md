# Agent Code Execution: the CodeExecutor Seam

> Read before touching code execution, sandbox backends, or the run_python tool
> chain. Rules here are true now; the record behind each is in
> `code-execution/<topic>.md`.

## The seam

- `packages/agent/src/code-execution.ts` (`@brainstrike/agent/code-execution`)
  is the single module every execution backend plugs into, between tool
  dispatch and the process spawn.
- Decide anything two backends could disagree about here, once. Why: a rule
  left to each backend becomes drift between `fence` and `vm`.
- `ExecutorKind` derives from the exported `EXECUTOR_KINDS` tuple, the single
  source of truth. `parseExecutorKind` is the strict boundary for persisted or
  workspace-supplied values and renders rejections without `JSON.stringify`.

Guard: `packages/agent/src/__tests__/code-execution.spec.ts`.

## Validation is the whole request, not just the policy

- `execInputSchema` validates the whole request strictly, unknown keys
  rejected. Read the schema for the fields and bounds.
- `signal` and `maxOutputBytes` are required. Backends MUST terminate the
  process tree when the signal fires, and the capture bound belongs to the
  request, never to a backend.
- Take run_python's timeout default and ceiling from its `defineNativeTool()`
  `executionBudget`
  (`packages/assistant-contract/src/native-tools/definitions/run-python.ts`).
  Never hardcode either number: the approval card, `MAX_EXEC_TIMEOUT_MS` and
  the per-tool execution guard all read that one source, and the guard's
  `TOOL_GUARD_MARGIN_MS` head start is what lets the tool's own `timed_out`
  beat the guard's generic `tool_timeout`.
- `scratchDir` is absolute AND covered by `policy.allowWrite`, so an
  interpreter that cannot write its scratch dir fails validation rather than
  the run.
- `isPathCoveredBy` is the ONLY containment predicate, including on
  runtime-computed paths: false on an unresolved `..`; a backslash separates
  only in a Windows-shaped path; case folds on the Windows VOLUME segments
  only, never directory segments, never POSIX.
- Resolve with `realpath.native`, never `fs/promises`' `realpath`, which copies
  non-symlink components verbatim and loses OS-canonical case.

Settled: the timeout budget is single-sourced; `signal` and `maxOutputBytes`
stay required; directory segments are never folded. Evidence:
`code-execution/seam-validation-rationale.md`.
Guard: `packages/agent/src/__tests__/code-execution.spec.ts`.

### Backends MUST resolve before asking (requirement, not advice)

- `realpath` BOTH operands before calling `isPathCoveredBy`. An unresolved
  operand is a security bug: resolution is what closes a symlink into a denied
  store and a case variant on a case-insensitive volume.
- Do NOT fold case on darwin. Case sensitivity is a filesystem property, so
  `platform === 'darwin'` guesses toward a false PERMIT.
- A path with no canonical form raises the backend's typed policy error.
- Canonicalize deny rules BEST-EFFORT and keep the literal when the path is
  absent, so the rule still reaches the sandbox.
- Expect resolved spellings in the config handed to the sandbox (macOS
  `/var/folders/…` → `/private/var/folders/…`).
- A Windows backend canonicalizes explicitly (8.3 short names, trailing dots,
  alternate data streams, `\\?\`, device names) and verifies it before
  comparing coverage. None exists today.
- `packages/agent/src/fence/fence-policy.ts` is the reference implementation.
  If a THIRD backend appears, move this duty into the seam as a helper.

Settled: no darwin case-folding; volume-only folding on Windows, which moves
together with Windows canonicalization. Evidence:
`code-execution/path-containment.md`.
Guard: `packages/agent/src/__tests__/fence-policy.spec.ts`.

## ExecPolicy shape rules (the seam owns these, not the backend)

- `ExecPolicy` maps 1:1 onto sandbox-runtime's `SandboxRuntimeConfig`; entries
  are shape-validated here so that mapping holds.
- Paths are absolute, carry no `..`, and are length- and count-bounded. A
  leading `~` is rejected, never expanded — srt resolves it against its own
  process context, so an unexpanded `denyRead: ['~/.ssh']` protects nothing.
- Domains are a hostname or a `*.example.com` wildcard. A bare `*` is rejected:
  `allowedDomains: []` meaning "no network" is this policy's safety-critical
  invariant, and unrestricted egress is deliberately not expressible.

Guard: `packages/agent/src/__tests__/code-execution.spec.ts`.

## Capability reconciliation — backends MUST call it

- Call `assertExecRequestSatisfiable(capabilities, input)` at the top of
  `execute()`. It throws `ExecCapabilityMismatchError`: `language_unsupported`
  outside `capabilities().languages`, `network_unsupported` for non-empty
  `allowedDomains` while `supportsNetwork` is false.
- Why network errors rather than downgrades: running with networking quietly
  off is a stronger sandbox but a wrong result — exit 0 with missing data.

## Two-mode resolution — NO DOWNGRADE (settled, do not relitigate)

- `resolveCodeExecutor(requested, host)` gates on factory presence — never
  `isElectron()`, never platform sniffing.
- There is NO `vm`→`fence` fallback, ever. A mode the host cannot satisfy
  throws `ExecutorKindUnavailableError` in BOTH directions: `vm` on a
  fence-only host AND `fence` on a bare host.
- Factory presence is not evidence of isolation: the resolver also asserts
  `capabilities().maxIsolationTier === REQUIRED_ISOLATION_TIER[kind]` and
  throws `ExecutorTierMismatchError`.
- A backend that cannot apply its platform sandbox throws at construction
  rather than returning a weaker executor.
- The caller owns the returned executor and MUST `dispose()` it: each call
  invokes the factory and yields a NEW executor.

Settled: no downgrade in either direction; the tier is checked, not trusted.
Evidence: `code-execution/no-downgrade.md`.
Guard: `packages/agent/src/__tests__/code-execution.spec.ts`.

## ExecResult semantics

- `exitCode` is `null` exactly when a signal terminated the process, including
  a timeout kill, and `signal` names it. No per-backend convention.
- Report per-stream omitted byte counts, never one `truncated` boolean;
  `isExecResultTruncated(result)` is the predicate.
- stdout/stderr are executor-bounded by `maxOutputBytes`; the tool layer still
  owes its model projection budget (`docs/agents/assistant-providers.md`).

Evidence: `code-execution/exec-result-shape.md`.

## Cancellation

- `ExecInput.signal` firing ends the run: terminate the process tree and throw
  `ExecAbortedError` (`code: 'exec_aborted'`, predicate `isExecAbortedError`)
  for BOTH positions — aborted while queued, and aborted mid-run.
- Never encode an abort as an `ExecResult`; it would differ from a timeout only
  by the ABSENCE of a flag. One `catch` is the whole contract.
- Carry `partialStdout`, `partialStderr`, the omitted byte counts and
  `processStarted` on the error.

Settled: an abort is an error, not a result. Evidence:
`code-execution/cancellation-as-error.md`.

## The run_python tool

`packages/agent/src/tools/run-python-tool.ts`, exported as
`createRunPythonTool`; registered by the desktop composition root in
`apps/desktop/src/assistant-server/native-tool-executors-execution.ts`.

- GATE A is the framework's pre-execution approval: under `'ask'` the
  permission gate clones run_python with the function-form `requireApproval`,
  so Mastra collects the approval BEFORE `execute()` runs, on the same card and
  transport as every other ask tool.
- A decline streams `tool-output-denied`, mapped to the DECLINE terminal
  (`StreamChunkTool` status `'declined'`, shared `DeclinedToolCallResult`),
  never the ERROR terminal.
- The injected `resolveApprovalDecision()` (required factory option) arms ONLY
  the direct-invocation guard: `'ask'` with no suspension channel refuses with
  `approval_confirmation_unavailable`; unrecognised resume data refuses with
  `resume_unrecognized`.
- GATE B: network is expressible ONLY through the per-call suspension. The
  schema accepts `allowedDomains` (`policyDomainSchema`), but the policy stays
  `[]` unless the escalation resumes with exactly `{action:'allow'}`; anything
  else denies with `network_denied` + `deniedDomains`, and a missing channel
  refuses with `network_confirmation_unavailable`.
- The suspension channel has NO grant surface: no session grant, per-tool
  override or `yolo` posture pre-answers it.
- Without Mastra workflow storage run_python is fail-safe omitted, which also
  keeps it off Hosted Web. A pause that cannot resume must never be armed.
- It lives in the DEFERRED `execution` discovery namespace: a scripted test
  model `load_tool`s it by exact name first.
- Register the factory-returned Mastra Tool object directly, never re-wrapped
  in the registry's `{description, execute, id, inputSchema}` literal, which
  drops `suspendSchema` and silently disarms the network gate. Excluded for the
  built-in local provider, alongside `askUser`/`submitPlan`.
- The per-call scratch dir is the only writable path: `mkdtemp` under
  `os.tmpdir()`, `realpath`'d, removed in a `finally` on every exit path.
- `toRunPythonResult` maps five terminal states: `completed` (the ONLY arm
  carrying `exitCode`), `timed_out`, `killed`, `cancelled` (partial output,
  never an empty success), `unavailable`. An unrecognised error RETHROWS.
- Keep `interpreter_unavailable` distinct from `no_sandbox_configured`, matched
  structurally by the `python_*` code prefix, so the user is told WHICH half is
  missing and this package need not depend on `apps/desktop`.
- Output is bounded twice and both counts reported: what the model projection
  trims is ADDED to the executor's omitted byte counts, and the TAIL is kept.
- The approval card's facts are server-computed in
  `run-python-approval-context.ts` from the SAME schema and constants
  `execute()` uses; `policyFingerprint` rides the context so approval-time and
  execute-time terms stay comparable.
- Prove the network deny through the PROXIED path (`urllib`), never a raw
  socket, and keep it mutation-checked — srt refuses a raw
  `socket.create_connection` whatever the policy says, so that assertion passes
  identically with `[]` and `['example.com']`.

Settled: Gate A is the framework's approval, Gate B the suspension channel; the
pre-1.56 in-tool approval design is dead. Evidence:
`code-execution/run-python-approval-gates.md`,
`code-execution/run-python-result-and-scratch.md`.
Guard: `packages/agent/src/__tests__/run-python-tool.spec.ts`,
`packages/agent/src/__tests__/mastra-tool-approval-chunks.spec.ts`,
`packages/agent/src/__tests__/mastra-tool-suspend-resume.integration.spec.ts`.

## Permission engine relationship

- Approval gating happens ABOVE this seam: the allow/ask/deny DECISION comes
  from the permission engine (`docs/agents/assistant-runtime.md` § PERMISSION
  ENGINE), `'ask'` enforcement is the same per-tool `requireApproval` clone
  every execute-risk tool uses, and `'deny'` omits the tool before any call.
- The one in-tool remnant is the DIRECT-invocation guard: outside an agent run
  `'ask'` refuses rather than running unprompted.
- The seam never re-implements or bypasses the decision, and executor errors
  never auto-approve or auto-decline.
- Escalate a non-empty `allowedDomains` on the SUSPEND channel, not the
  approval channel: `requireApproval` is per-tool and cannot be conditioned on
  one call's arguments, so a session or per-tool grant would silently skip it.

Evidence: `code-execution/permission-engine-ux-design.md`.

## The null stub

- `createNullCodeExecutor({ platform })` spawns nothing: every `execute()`
  rejects with `NoSandboxConfiguredError`, and its capabilities are honest
  (`maxIsolationTier: 'none'`, `supportsNetwork: false`, `languages: []`).
- It cannot be a host's `fence`/`vm` factory — the resolver rejects it with
  `ExecutorTierMismatchError`. Tool code integrates with it directly.

## Backends

### FenceExecutor

`packages/agent/src/fence/` — the Node-only subpath
`@brainstrike/agent/fence-executor`, never the root, `client` or
`browser-safe` entries; srt stays `external` in tsup.

- `@anthropic-ai/sandbox-runtime` is pinned EXACTLY, no caret, in the
  `pnpm-workspace.yaml` catalog, and the escape-resistance suite asserts that
  version. Before a bump, re-derive the boundary from its README and `.d.ts`
  and diff the published tarballs — never from memory.
- Re-green a bump on macOS AND Linux. CI supplies only the Linux half, in the
  `Unit (agent-1)` / `Unit (agent-2)` rows; macOS is always a local run, and a
  CI runner has no credential stores, so the `~/.ssh` cases get their
  full-strength form there. The bump log names the platforms that actually ran.
- Platforms are darwin and linux only: `isFenceSupported()` is the probe and
  `createFenceExecutorFactory()` returns `undefined` elsewhere.
- Keep the explicit `platform === 'darwin' || platform === 'linux'` allow-list
  in `isFenceSupported()` — do not "simplify" it away.
  `SandboxManager.isSupportedPlatform()` returns TRUE on Windows, so that line
  is the entire gate.
- Windows stays gated OFF: srt's Windows filesystem scope is session-level, so
  the initialize-once/`updateConfig`-per-execution lifecycle below is
  inexpressible there and no capability field can advertise the gap.
- Interpreters are injected; this module never guesses a binary path.
  `capabilities().languages` is exactly the injected key set, and an
  un-injected language throws `FenceUnsupportedLanguageError`.
- The desktop composition root resolves the bundled CPython once
  (`resolveDesktopPythonExecutable()`, `apps/desktop/src/python-runtime/`) and
  injects the absolute path; this package never imports it. It unpacks under
  `userData/python-runtime/`, a SIBLING of every always-deny store, and fails
  with a typed `python_*` family disjoint from the seam's and fence's codes.
  There is no PATH-python fallback in any state.
- `ALWAYS_DENY_READ_PATHS` applies on top of every policy, resolved to ABSOLUTE
  paths from `os.homedir()` rather than handed to srt as `~/…`, and stays
  literal. srt's glob-deny handling is version-dependent and is NOT relied on.
- Refuse with `FencePolicyError`: an `allowRead` at or under an always-denied
  store; a ROOT-WIDE `allowRead`, since srt's nested-deny re-emission tests
  `denied.startsWith(allowed + '/')` and never matches for `'/'`; an
  `allowRead` naming EXACTLY a path the same policy denies, which srt resolves
  in the allow's favour; an `allowWrite` at or under an always-denied store,
  since bubblewrap re-binds an allowed write path read-WRITE over its tmpfs
  mask; and any glob, relative path, `..` or `~`. An `allowRead` ANCESTOR short
  of the root is fine — srt re-emits the nested deny.
- The sandboxed environment is an ALLOW-LIST (`INHERITED_ENV_VARS`), never a
  pass-through; anything more is named on `FenceInterpreter.env`, and keys srt
  CHANGED in the env it returns are carried over. Denying `~/.aws` on disk is
  pointless if `AWS_SECRET_ACCESS_KEY` rides in on the environment.
- `scratchDir` is always writable and listed first in `filesystem.allowWrite`;
  the script is written there `mode: 0o600` and removed after the run.
- Initialize `SandboxManager` ONCE per process and `updateConfig` per
  execution — both, because the singleton proxy reads module-level config at
  request time. That global state is why executions are SERIALIZED
  process-wide and executors refcounted: `dispose()` resets only when the last
  goes away, and `cleanupAfterCommand()` runs after every execution.
- The deadline starts when `execute()` is entered, not at spawn. If the budget
  elapses while queued, nothing spawns and `FenceQueueTimeoutError` is thrown —
  never a fabricated `ExecResult` for code that did not run.
- A timeout kills the whole process TREE (`detached: true`, SIGTERM then
  SIGKILL on the negative pid) and no successful path settles before the group
  is down: settlement waits on a bounded signal-0 probe.
- `EPERM` FROM THE PROBE IS INCONCLUSIVE, NOT A DENIAL — do not relitigate.
  Every member is our own descendant running as us, so `EPERM` reports the
  post-reap race; it polls on exactly like `alive`, and ONLY `ESRCH` releases a
  tracked group. Failure rejects with `FenceProcessGroupTeardownError`, the
  group stays tracked, and later executions fail closed until `ESRCH` proves it
  gone.
- `'close'` settles only once the root's exit status is known, and the settle
  path SIGKILLs the group: a descendant that detaches its stdio closes our
  pipes while still running, and would meet the NEXT execution's allow-list.
- Live groups are reaped on the host's `process exit`. Residual risk: a hard
  crash of the host cannot run that reaper, so a run continues fenced but
  unbounded.
- Bytes past `maxOutputBytes` are dropped rather than buffered, while the pipes
  keep draining so the sandboxed process never blocks. A mid-run abort kills
  the group first and carries partial output on the error.
- `execute()` re-parses `execInputSchema` and reconciles capabilities before
  touching the filesystem, so a caller that bypassed the seam cannot spawn.
- The integration suite skips only with a message naming exactly what is
  missing, never by weakening an assertion. Its reachability guard matters both
  ways: without it the allow-list test fails RED on a restricted-egress host
  AND its network-deny sibling passes VACUOUSLY.

Settled: Windows off; a root-wide `allowRead` refused; `EPERM` polls on.
Evidence: `code-execution/srt-version-pin.md`,
`code-execution/windows-fence-gate.md`,
`code-execution/fence-policy-refusals.md`,
`code-execution/process-tree-teardown.md`.
Guard: `packages/agent/src/__tests__/fence-policy.spec.ts`,
`packages/agent/src/__tests__/fence-executor.integration.spec.ts`.

#### Where the Linux half actually comes from

- The `unit-shard` job in `.github/workflows/test.yml` installs `bwrap`,
  `socat` and ripgrep, lifts `kernel.apparmor_restrict_unprivileged_userns`,
  and ends the step with a bwrap smoke test and `python3 --version`. Without
  the sysctl the dependency check goes green and every fenced run still dies
  building its namespace.
- The Unit integration steps set `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`, which
  `packages/agent/src/__tests__/fixtures/fence-host-gate.ts` reads to escalate
  a skip into a collection failure. Declare it on `test:integration` in
  `turbo.jsonc` too, or Strict env mode leaves the guarantee inert.
- EVERY suite-wide skip reason escalates — missing dependencies, no `python3`,
  an unreachable probe host, the escape-resistance network cases — so the
  escalation lives at the choke point that sees the COMPLETE reason
  (`refuseToSkipInAPromisedLane`), never inside the dependency check.
- Scope the escalation to lanes that PROMISED the prerequisites: developer
  machines and the coverage lanes install nothing and keep the loud skip.
- A green `Unit` is not evidence on its own: open the affected-integration step
  and confirm the escape-resistance suite RAN rather than printing
  `SUITE SKIPPED`.

Settled: an unreachable probe host reds the lane rather than skipping quietly;
`isFenceSupported()` still cannot tell a host's kernel forbids a namespace
(BST-1317). Evidence: `code-execution/linux-fence-lane.md`.
Guard: `scripts/__tests__/linux-fence-lane-contract.test.mjs`.

#### Escape-resistance suite

- `packages/agent/src/__tests__/fence-escape-resistance.integration.spec.ts`
  attacks the fence; the contract suites prove it behaves.
- Read `fence-escape-resistance.README.md` before changing either file: it is
  the honest guarantee/non-guarantee statement, carries the mutation-kill
  table, and records the srt re-green procedure.
- srt is an OS fence, not a VM. Mode two (ADR-0003) is the answer for
  adversarial code; this suite must not be read as claiming otherwise.

Evidence: `code-execution/escape-resistance-suite.md`.

### VM executor (mode two)

- The design is settled in `docs/adr/0003-mode-two-full-isolation-vm.md`
  (Accepted 2026-08-01): Virtualization.framework in a signed helper process,
  macOS/Apple silicon first, granted-folder VirtioFS shares only, no guest NIC,
  plus a bubblewrap+seccomp fence inside the guest. Read the ADR for the rest.
- Gating mode two on a user-installed Docker/OrbStack/Podman is rejected
  (ADR-0003 D9) — do not propose it as a shortcut.
- There is still no implementation: do not design other code against a VM
  backend existing.

Evidence: `code-execution/vm-mode-two.md`.

When changing this flow, update this doc and the paired spec in the same change.
