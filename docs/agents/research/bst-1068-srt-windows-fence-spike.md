# BST-1068 — the srt Windows fence (native alpha): assess & gate

Date: 2026-08-01
Subject: `@anthropic-ai/sandbox-runtime` (srt) `0.0.67` — the version PR #2190
pins in the workspace catalog, and `latest` on npm as of this date
(`npm view @anthropic-ai/sandbox-runtime dist-tags` → `latest: '0.0.67'`).

Decision: **keep Windows off the `fence` capability. A Windows host advertises
no `fence` factory, so `resolveCodeExecutor('fence', host)` throws
`ExecutorKindUnavailableError`. Do not prompt Windows users for the elevated
install.** Revisit when the gate in §5 is cleared.

> ## Scope honesty — read this before citing anything below
>
> **No part of this spike was executed on Windows.** It was produced on macOS
> (darwin/arm64). srt's Windows fence requires a one-time ELEVATED install on
> real Windows hardware (`npx @anthropic-ai/sandbox-runtime windows-install`)
> that creates the `srt-sandbox` local account and machine-wide WFP filters —
> not reproducible, not simulable, and not inferable from here.
>
> Everything in §1–§5 is derived from **reading srt 0.0.67's shipped source,
> type declarations, and README**, plus the PR #2190 implementation. Every
> claim carries its evidence. Claims about **runtime behaviour on Windows are
> srt's own documented claims, not observations of ours** — they are labelled
> as such.
>
> §6 is the hands-on half: a runnable plan for a Windows box, in one sitting.
> Until someone runs it, BST-1068's acceptance criterion "fenced Python
> verified on a real Windows host" is **NOT met**.

### Repo state this was written against

- `docs/agents/code-execution.md` and `packages/agent/src/code-execution.ts` at
  `origin/main` (856767a8c).
- **PR #2189** (`bst-1060-followup-seam-review-hardening`, unmerged) adds
  `REQUIRED_ISOLATION_TIER`, `ExecutorTierMismatchError`, and the
  `resolveCodeExecutor` assertion that a `fence` executor reports
  `maxIsolationTier: 'os-fence'`. §2 is written against that hardened contract
  because it is the contract BST-1062 will land onto.
- **PR #2190** (`bst-1062-build-the-fenceexecutor-on-anthropic-aisandbox-runtime`,
  unmerged) is the FenceExecutor under review.

---

## 1. Verification report

Evidence paths are relative to the installed package
`node_modules/@anthropic-ai/sandbox-runtime` at version `0.0.67`. README line
numbers are from the packaged `README.md`; the GitHub `main` README was
cross-checked and matches (same alpha label, same limitation headings).

### 1.1 "A real native fence, not WSL2-only, labeled ALPHA" — **CONFIRMED**

| Evidence | What it shows |
| --- | --- |
| `README.md:449` | "**Windows**: Alpha — uses a bundled `srt-win.exe` helper (no additional dependencies)" |
| `README.md:496-498` | section heading `## Windows (alpha)`; "Windows support is **alpha**." |
| `dist/utils/platform.js` `getPlatform()` | `case 'win32': return 'windows'` — a first-class platform, distinct from the `linux`/WSL branch |
| `dist/sandbox/sandbox-manager.js:603-610` `isSupportedPlatform()` | returns `platform === 'macos' \|\| platform === 'windows'`; WSL is handled under `linux` (WSL1 excluded via `getWslVersion()`) |
| `vendor/srt-win/{x64,arm64}/srt-win.exe` | `PE32+ executable (console) x86-64` and `PE32+ … Aarch64, for MS Windows` (3.0 MB / 2.7 MB). Native PE binaries, not a WSL shim |

Refinement: **arch coverage is x64 and arm64 only.** There is no `ia32`
binary, and `VENDORED_SRT_WIN_EXE`
(`dist/sandbox/windows-sandbox-utils.js:137`) indexes a `nodeArchToDir` map by
`process.arch` with no fallback. 32-bit Windows is unsupported.

### 1.2 "Runs under a dedicated `srt-sandbox` local user account, provisioned by a one-time elevated install that also creates machine-wide WFP filters keyed to that account's SID" — **CONFIRMED**

| Evidence | What it shows |
| --- | --- |
| `README.md:508` | install "provisions the `srt-sandbox` local user account (with a random password stored DPAPI-encrypted under `%LOCALAPPDATA%\sandbox-runtime\state.db`), the `sandbox-runtime-users` local group, and installs a machine-wide WFP filter set keyed on the `srt-sandbox` SID. It is **idempotent**" |
| `README.md:518` | two-hop launch: broker → `CreateProcessWithLogonW` starts a runner as `srt-sandbox` → runner spawns the target under a restricted token inside a job object |
| `windows-sandbox-utils.d.ts` `installWindowsSandbox` | "One-shot install … all in a single self-elevating process (one UAC prompt). Idempotent; re-running rotates the sandbox user's password." Returns `{cancelled: true}` on UAC dismissal rather than throwing |
| `windows-sandbox-utils.d.ts` `WindowsInstallOptions.timeoutMs` | default 120 000 ms, sized to the UAC consent dialog's ~2 min auto-dismiss |
| `dist/cli.js:45-51` | `windows-install` subcommand with `--sublayer-guid`, `--proxy-port-range`, `--sandbox-user`, `--force` |

Refinements:

- The account name is **configurable** (`WindowsInstallOptions.sandboxUser`,
  default `srt-sandbox`), and an existing local user of that name is
  **adopted**, not recreated.
- The install is **machine-wide and outlives the app.** `windows-uninstall`
  removes the filters, the account, its profile, and the group, but
  `%LOCALAPPDATA%\sandbox-runtime\state.db` "is left in place … delete the
  directory manually for a full sweep" (`README.md:567`). This matters for §3.
- The restricted token is the **inner** layer. The outer, load-bearing boundary
  is the separate user SID: srt's own module header
  (`windows-sandbox-utils.d.ts`) says the separate account "structurally closes
  the surrogate-spawn class (schtasks,
  `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, BITS, RunAs="Interactive User" COM)".
  `docs/agents/code-execution.md` currently describes the Windows backend as
  just "Windows restricted token" — an understatement, corrected in this change.

### 1.3 "Network fence = WFP kernel filters (permit loopback-to-proxy only), enforced even if the process unsets proxy env vars" — **CONFIRMED, with one documented hole**

| Evidence | What it shows |
| --- | --- |
| `README.md:522` | "a two-filter WFP set at `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6`: a PERMIT for loopback destinations inside the configured proxy port range (default `60080–60089`), and a BLOCK for any connect whose token carries the `srt-sandbox` SID" |
| `README.md:611` | "Environment variables … point tools at the proxies, but the WFP filter is the boundary — a process that ignores or unsets them is still fenced" |
| `windows-sandbox-utils.d.ts` `verifyWindowsWfpEgress` | behavioural proof: binds a loopback listener OUTSIDE the permit range, spawns `srt-win runner` as the sandbox user, attempts a direct connect. "an active fence yields WSAEACCES immediately". Throws on any outcome other than `blocked` |
| `sandbox-manager.js:391-403` | `initialize()` calls `verifyWindowsWfpEgress()` once per process and rethrows — "a stale install (sandbox user provisioned but filters since removed) fails closed at session start instead of running every exec with full egress" |

**The hole (documented, not a defect):** DNS is not fenced. README known
limitation: "`getaddrinfo()` is serviced by the `Dnscache` service running as
`NETWORK SERVICE`, so name resolution succeeds even though the subsequent
`connect()` from the sandboxed process is blocked." srt notes "This mirrors the
macOS behaviour" — so it is **not** a Windows-specific downgrade and does not
change our `supportsNetwork` answer. Tools doing their own UDP/53 (`nslookup`,
`dig`) are fenced.

The proxy-port-range coupling is a real configuration hazard:
`windows.proxyPortRange` in the runtime config **must match** what
`windows-install --proxy-port-range` used — "the WFP loopback PERMIT only covers
that range" (`README.md:549`). A mismatch is a total network outage inside the
fence, not a security hole.

### 1.4 "Filesystem fence = additive NTFS DACLs scoped to the sandbox SID" — **CONFIRMED**

| Evidence | What it shows |
| --- | --- |
| `README.md:524` | "The `srt-sandbox` account has no inherent rights on the calling user's files, so at `initialize()` the sandbox writes **additive, inheriting explicit ACEs for the `srt-sandbox` SID only** — it never rewrites or replaces a path's existing security descriptor" |
| `README.md:526-530` | `allowWrite` → inheriting `MODIFY` ALLOW with `FILE_DELETE_CHILD` withheld; `allowRead` → inheriting `READ\|EXECUTE` ALLOW; `denyRead`/`denyWrite` → inheriting DENY on the target **plus** an inheriting `FILE_DELETE_CHILD` DENY on its parent (blocks rename/delete-via-parent) |
| `README.md:619` | "Writes additive `(OI)(CI)` explicit ACEs … then removes them at `reset()`" |
| `sandbox-manager.js:1496-1525` `reset()` | calls `revokeWindowsAcl` + `restoreWindowsAcl`, best-effort with warn-level logging; leftovers recoverable via `srt-win acl recover` (sweeps by trustee SID) |
| `README.md:530` | refcounted across concurrent hosts via `state.db`; crash-recovery pass on the next `initialize()`; **globs expand point-in-time at `initialize()` — "a matching path that appears later is not covered"** |

**Model difference from macOS/Linux, and it cuts both ways.** This is an
identity-based DACL fence, not a namespace. Compared to bubblewrap's bind
mounts, the sandbox account still sees every path whose existing ACL grants
`Users`/`Everyone` — `C:\Windows`, `Program Files`, other accounts' world-
readable data. The upside is that the calling user's profile is closed by
default with no enumeration required. The downside is that "deny by omission"
only covers paths whose ACLs are already user-scoped.

### 1.5 Known limit: "certificate-revocation checks fail (CRL/OCSP get WFP-blocked)" — **CONFIRMED, and it does NOT hit our primary workload**

README known limitation 1: "CryptoAPI's CRL/OCSP fetch goes out via WinHTTP
under the caller's token, ignoring the proxy environment, so it is blocked by
the WFP egress fence. Tools that use schannel with revocation checking on by
default fail with `CRYPT_E_REVOCATION_OFFLINE` (`0x80092013`) unless revocation
is disabled per tool: `curl --ssl-no-revoke`,
`git -c http.schannelCheckRevoke=false`, `CARGO_HTTP_CHECK_REVOKE=false`.
`Invoke-WebRequest`, .NET `HttpClient`, and `gh` do not check revocation by
default and are unaffected."

**Assessment for BST-1062's actual workload: low impact.** The failure is scoped
to **schannel** TLS backends. CPython links OpenSSL, not schannel, so `urllib`,
`requests`, `httpx`, and `pip` take the env-var trust path (`README.md:541`:
`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, …, with the bundle
path auto-added to the session `allowRead` grant). Agent Python runs should be
unaffected. This is a **prediction from srt's documentation, not an
observation** — §6.4/d1 is the test that settles it.

### 1.6 Known limit: "per-user tool installs unreachable because the sandbox runs as a DIFFERENT account" — **CONFIRMED, and this one is directly in our path**

README known limitation 2: "tools installed under your profile (nvm/fnm-managed
Node, per-user `winget`/Scoop packages, `pip install --user`,
`%LOCALAPPDATA%\Programs\…`) resolve on the inherited `PATH` but cannot be
opened by the sandbox account. Prefer machine-wide installs (`Program Files`,
`choco`/`winget --scope machine`), or add the specific profile paths to
`filesystem.allowRead`."

**This is the sharpest practical finding in the spike.** A Windows Electron app
installed per-user (the default for most Electron installers) lives under
exactly the named-and-unreachable `%LOCALAPPDATA%\Programs\<app>`. BST-1061's
bundled CPython would therefore ship into a directory the sandbox account cannot
execute from. The mitigation is mechanical — add the interpreter root to session
`filesystem.allowRead`, which grants an inheriting `READ|EXECUTE` ACE for the
sandbox SID — but it must be a deliberate, tested step, and it means the app
stamps a persistent ACE onto its own install directory. §6.4/d2 tests both
halves.

Corollary: `pip install --user` inside the fence writes into the **sandbox
account's** profile, not the user's, and is invisible afterwards. Any "install a
package then use it" agent workflow needs an explicit scratch-scoped venv.

### 1.7 Known limit: "filesystem overrides are session-level, not per-exec" — **CONFIRMED, and stronger than stated**

Two independent mechanisms, both hostile to the seam's per-execution policy
model:

1. **Per-exec grants throw.** `sandbox-manager.js` `wrapWithSandboxArgv`,
   Windows branch:

   ```
   throw new Error(
     `Per-exec filesystem.allowRead/allowWrite is not supported ` +
     `on Windows — \`srt-win exec\` only exposes per-exec ` +
     `denies. Set them at the session level (initialize()).`)
   ```

   fired whenever `customConfig.filesystem.allowRead?.length ||
   customConfig.filesystem.allowWrite?.length`. Only per-exec **denies** are
   supported. README known limitation 3 says the same.

2. **`updateConfig()` warns and keeps the old set.**
   `sandbox-manager.js:1352-1362`:

   ```
   if (getPlatform() === 'windows' && config && !sameWindowsStampSet(newConfig)) {
     logForDebugging(`[Sandbox Windows] updateConfig: the resolved file-access set
       (filesystem.* ∪ credentials.files) changed but the ACL stamp/grant is
       session-wide — call reset() then initialize() to apply. The
       previously-applied set stays in effect.`, { level: 'warn' })
   }
   ```

   It logs at warn level and proceeds. From our seam's point of view that is a
   **silent degradation**: the network half of the config is applied, the
   filesystem half is not, and nothing throws.

PR #2190's FenceExecutor does **both** of these on every execution — it calls
`SandboxManager.updateConfig(config)` and passes the same `config` (which always
carries `filesystem.allowWrite` with at least `scratchDir`) as
`wrapWithSandboxArgv`'s `customConfig`. On Windows the first would silently
no-op the filesystem policy and the second would throw. See §4.

### 1.8 Findings not on the original list

| Finding | Evidence | Why it matters |
| --- | --- | --- |
| `wrapWithSandbox()` (shell-string form) **throws on Windows** | `sandbox-manager.js:1193-1200` | `wrapWithSandboxArgv()` + `{shell:false}` is the only supported wrap. PR #2190 already uses the argv form — but its POSIX `shellQuote()` emits `'…'` single-quoting, which `cmd.exe` (the default inner shell, `parseWindowsBinShell`) does not treat as quoting. A Windows fence needs a `cmd`/`pwsh`-correct quoter |
| `resolveSrtWin()` requires an **explicit** `windows.srtWin.path` — "no ambient vendor fallback" | `windows-sandbox-utils.js:193-203` | Electron packaging must `asar`-unpack `vendor/srt-win/<arch>/srt-win.exe` and pass its real on-disk path; an exe inside an asar archive cannot be spawned. srt's own CLI opts into `VENDORED_SRT_WIN_EXE` explicitly (`cli.js:141-155`) — the library never guesses |
| `proxyAuthToken` is **visible in the runner's argv** | README known limitation 5 | "readable by any local principal that can open the runner process for `PROCESS_QUERY_LIMITED_INFORMATION`". Fine on a single-user dev machine; on a shared host, treat the allowlist as reachable by other same-session principals |
| `network.tlsTerminate` needs a **separate, unelevated** CA-trust step | `README.md:532-543`; `windowsTrustCa` / `ensurePersistentWindowsCa` | Not covered by `windows-install`. `initialize()` fails closed on a thumbprint mismatch. We do not use `tlsTerminate` today; noted so a future request-filtering feature does not discover it late |
| A **non-elevated readiness probe exists** | `checkWindowsSandboxStatusAsync`, `checkWindowsDependenciesAsync` (both exported) | This is what makes the capability model in §2 possible at all |
| `verifyWindowsWfpEgress` is **once per process**, never cleared by `reset()` | `sandbox-manager.js:391-403`; `:1526` comment "`windowsWfpVerified` is NOT cleared — per-process, not per-session" | Good news for a reset/initialize-per-policy lifecycle: the expensive `CreateProcessWithLogonW` probe is not repeated |

---

## 2. Capability-model specification (the deliverable that feeds BST-1062)

### 2.1 Absent factory, not present-and-throwing

**Recommendation: on `win32`, the host advertises no `fence` factory.**
`resolveCodeExecutor('fence', host)` then throws `ExecutorKindUnavailableError`
— the seam's existing, typed, correct answer.

Reasoning, against the seam's own rules:

- The seam defines capability gating as "does the factory exist?"
  (`docs/agents/code-execution.md` § Two-mode resolution). "The elevated install
  has not been run" is precisely "this host does not have the capability."
  Absent factory is the literal encoding of that.
- Present-and-throwing would make `resolveCodeExecutor` **succeed** and hand
  back an executor whose every `execute()` fails. The caller would have to
  `dispose()` a thing that never worked, and the failure would surface at
  tool-call time (mid-conversation) instead of at capability-assembly time. The
  error would also be an srt `WindowsSandboxError('not_provisioned')` rather
  than the seam's typed error, so the tool layer would need a second,
  backend-specific error path for a condition the seam already models.
- `ExecutorKindUnavailableError` already renders the actionable message
  ("available: none"). A "run the install" hint belongs in the settings UI that
  reads the same probe, not in an executor that exists only to fail.

### 2.2 How "installed" is detected without elevation

srt already ships the probe. Two unelevated `srt-win.exe` spawns, run
concurrently:

```ts
import {
  checkWindowsDependenciesAsync,
  resolveSrtWin,
} from '@anthropic-ai/sandbox-runtime';

const srtWin = resolveSrtWin({ path: unpackedSrtWinExePath }); // asar-unpacked
const { errors } = await checkWindowsDependenciesAsync({ srtWin });
const ready: boolean = errors.length === 0;
```

What it actually checks (`windows-sandbox-utils.js:1318-1400`):

- `srt-win user status` → `provisioned` (the account exists) **and**
  `credPresent` (the DPAPI credential row in `state.db` is readable **by this
  process**). Either false → an error string embedding
  `windowsInstallInstructions()` verbatim.
- `srt-win wfp status` → BFE enumeration, which is **admin-gated**. A
  non-elevated caller gets `state: 'cannot-read'` with a `hint`, and srt treats
  that as **informational only**, not an error. WFP state is genuinely
  unobservable without elevation.
- The authoritative non-elevated check is therefore **behavioural**, not
  enumerative: `verifyWindowsWfpEgress()` binds a loopback listener outside the
  permit range and has the sandbox user attempt a direct connect to it; blocked
  ⇒ fence live. srt runs this itself inside `initialize()`, once per process,
  and fails closed.

Two consequences for host wiring:

1. **The probe is async; `CodeExecutorFactory` is sync (`() => CodeExecutor`).**
   The probe therefore belongs where the host assembles
   `CodeExecutorHostCapabilities`, not inside the factory. The fence module
   needs an async twin of its capability probe. Shape (specification, not
   implementation):

   ```ts
   /**
    * Windows readiness needs two out-of-process `srt-win.exe` probes, so the
    * synchronous `createFenceExecutorFactory` cannot answer it and reports no
    * fence on win32. Hosts that want a Windows fence call this instead, once,
    * while assembling CodeExecutorHostCapabilities.
    */
   export async function resolveFenceExecutorFactory(
     options: FenceExecutorOptions
   ): Promise<CodeExecutorFactory | undefined>;
   ```

   The `undefined` return is the same "capability absent" signal the sync probe
   already uses.

2. **A stale-true probe is safe; a stale-false probe is merely conservative.**
   If the user runs `windows-uninstall` after we probed, the next
   `SandboxManager.initialize()` throws `WindowsSandboxError('not_provisioned')`
   or `verifyWindowsWfpEgress()` throws — srt fails closed, so the worst case is
   a construction-time error, never a weaker sandbox. That satisfies PR #2189's
   rule that "a backend that cannot apply its platform sandbox MUST throw at
   construction rather than return a weaker executor."

### 2.3 Can a Windows fence honestly claim `maxIsolationTier: 'os-fence'`?

**Yes — the tier is a statement about the isolation *mechanism*, and the Windows
mechanism is a genuine OS-kernel fence.** Alpha status is a *reliability*
property and must not be encoded in the tier.

- Separate security principal (distinct user SID) + WFP filters enforced in the
  kernel at `ALE_AUTH_CONNECT` + NTFS DACLs. None of that is advisory, and none
  of it depends on the sandboxed process cooperating. On the ladder
  `none | os-fence | vm` that is unambiguously `os-fence`. Arguably it is a
  *stronger* identity boundary than Seatbelt, which fences a process running as
  you.
- Reporting `'none'` to express "alpha" would be two lies for the price of one:
  it misdescribes the mechanism, and it would trip `ExecutorTierMismatchError` —
  an error that says "tier mismatch" when the truth is "we have not verified this
  platform." Inventing an `'os-fence-alpha'` tier is worse: the tier is a
  security contract the resolver asserts on, and blending maturity into it makes
  that assertion meaningless.
- **The correct place to express "alpha, not shipped" is capability
  *presence*.** No factory ⇒ no fence on this host. That is exactly §2.1.

### 2.4 The blocker the capability model *cannot* express — and why it decides the gate

The seam's contract is that **`ExecPolicy` is a property of each `ExecInput`**.
Every `execute()` may carry a different `allowWrite` / `denyRead`. On Windows
srt, filesystem scope is fixed at `initialize()` and released at `reset()`
(§1.7). There is **no field in `ExecutorCapabilities`** that can say "this
executor honours your network policy per-run but your filesystem policy only
per-session." An executor advertising `os-fence` while running request *n* under
request *1*'s filesystem policy would be silently degrading the policy — the
exact class this seam exists to prevent — and the tier check would not catch it,
because the tier would be truthful.

So the gate is **not** a capability flag. It is a **lifecycle requirement** on
any future Windows fence:

| Rule | Why |
| --- | --- |
| Apply policy at `initialize()`. On a policy change, `reset()` then `initialize(next)`. **Never** `updateConfig()` for a changed file-access set | `updateConfig()` warns and keeps the previous set (§1.7.2) |
| Never pass `filesystem.allowRead`/`allowWrite` in `wrapWithSandboxArgv`'s `customConfig` | it throws on Windows (§1.7.1). Per-exec **denies** are fine |
| Never call `wrapWithSandbox()` | throws on Windows (§1.8) |
| Replace the POSIX quoter | `shellQuote()`'s `'…'` form is not quoting to `cmd.exe` |
| Replace the process-tree kill | `process.kill(-pid, …)` is POSIX process-group semantics; `detached: true` on Windows opens a new console, not a group. The real sandboxed child is a grandchild under srt-win's job object. **Unverified** — §6.7. Note the repo already has a Windows Job Object addon, `packages/windows-job-native` (`initialize()` / `terminateOtherProcesses()` / `activeProcessCount()`), today wired only into `apps/desktop/scripts/start-agent-devtools-session.mjs` for dev process trees — if §6.7 shows srt-win's own job object does not suffice, extend that rather than writing a third kill path |
| Set `windows.srtWin.path` (asar-unpacked) and `windows.proxyPortRange` matching the install | no ambient default; a range mismatch is a total egress outage (§1.3, §1.8) |
| Budget the reset/initialize round trip | it re-stamps every ACE. If it costs more than a fraction of a second, per-exec policy is unaffordable on Windows and the design needs a per-workspace session model. **Unmeasured** — §6.6 |

**Target capabilities for that future executor**, so the shape is settled now:

```ts
const windowsFenceCapabilities: ExecutorCapabilities = {
  languages,               // exactly the injected interpreter keys
  maxIsolationTier: 'os-fence',
  platform: 'win32',
  supportsNetwork: true,   // WFP permit + allow-list proxy is the same model
};
```

`supportsNetwork: true` is correct despite the unfenced DNS resolver: the flag
means "can honour a non-empty `allowedDomains`", and connect-time enforcement is
kernel-level. The DNS hole is identical on macOS, which we already ship.

---

## 3. Onboarding recommendation

**Report Windows as fence-unavailable. Do not prompt for the elevated install —
not at onboarding, not on first `run_python`, not at all in this release.**

User-visible behaviour: on Windows the `run_python` tool is simply not offered,
and Settings carries one plain line — *"Sandboxed code execution requires macOS
or Linux. Windows support is in progress."* No unsandboxed fallback, ever.

Why this and not the alternatives:

- **The ask is disproportionate to what we could deliver.** `windows-install` is
  not "grant an app a permission." It creates a hidden local user account with a
  DPAPI-stored password, a local group, and **machine-wide kernel network
  filters**, and it persists after the app is uninstalled unless the user
  separately runs `windows-uninstall` (which still leaves `state.db` behind —
  §1.2). For an app whose whole pitch is local-first and privacy-preserving,
  making a machine-wide, account-creating UAC prompt part of onboarding inverts
  the trust story on day one.
- **We cannot honestly ship the feature yet anyway** (§2.4). Asking for that
  concession to enable something that would then silently misapply filesystem
  policy is the worst of both.
- **Deferring is not free either, and that is the honest cost.** Managed and
  corporate Windows fleets frequently block local-account creation outright, so
  even a later opt-in flow will have a population that can never enable it. That
  argues for building the Windows fence behind an explicit, user-initiated
  Settings action — never an onboarding step — when the time comes, with the
  status probe (§2.2) driving a truthful "not installed / installed / installed
  but filters missing" readout and a visible uninstall path.

---

## 4. What PR #2190 should change (nothing structural)

PR #2190's `createFenceExecutorFactory()` already returns `undefined` on
`win32`, which is the recommendation. The only correction is to the **stated
reason**. Its doc currently says:

> Windows is srt-alpha (needs a provisioned sandbox user + WFP fence) and its
> process-tree kill is unverified here — deliberately NOT offered rather than
> shipped untested.

The process-tree kill is real but secondary. The primary reason is §2.4: the
executor's per-execution policy model is **not expressible** on Windows srt —
`updateConfig()` would silently drop the filesystem half and the `customConfig`
override would throw. Suggested replacement wording, to be applied on #2190's
own branch (this spike deliberately does not edit that PR's files):

> Windows is deliberately NOT offered. srt's Windows fence is a real OS-kernel
> fence (separate `srt-sandbox` user SID + WFP + NTFS DACLs) but its filesystem
> scope is **session-level**: `updateConfig()` warns and keeps the previous
> access set, and a per-exec `filesystem.allowRead/allowWrite` throws. This
> executor's per-execution policy model therefore cannot be honoured there.
> Process-tree kill (`process.kill(-pid)`) is POSIX-only and also unported. See
> `docs/agents/research/bst-1068-srt-windows-fence-spike.md`.

---

## 5. Gate — what would have to be true to revisit

1. srt Windows leaves alpha, **or** we accept alpha explicitly with the §6 plan
   run green on our own hardware.
2. The lifecycle rework in §2.4 is specified as its own ticket, with §6.6's
   measured reset/initialize cost deciding between per-exec policy and a
   per-workspace session model.
3. BST-1061's interpreter placement is resolved against §1.6 (machine-wide
   install location, or a tested `allowRead` grant on the app's own install
   directory).
4. Electron packaging unpacks `srt-win.exe` from asar and threads its path.

---

## 6. Runnable Windows test plan (BLOCKED ON WINDOWS HARDWARE)

One sitting, ~60–90 min. Nothing below has been executed.

**Host:** Windows 11, x64 or arm64 (no 32-bit — §1.1), an account that can
elevate, Node ≥ 20.11. Prefer a VM, or a machine you are willing to leave a
local account on; §6.8 removes it.

**Record for every step:** the exact command, exit code, and stdout/stderr.
Where a step's expectation is srt's documented claim rather than an established
fact, it is marked *(doc claim under test)*.

### 6.0 Setup

```powershell
mkdir C:\srt-spike; cd C:\srt-spike
npm init -y
npm i @anthropic-ai/sandbox-runtime@0.0.67
mkdir C:\srt-spike\scratch
```

Put a **machine-readable** CPython at `C:\srt-spike\py\python.exe` — unzip a
python-build-standalone release there (deliberately NOT under `%LOCALAPPDATA%`;
that is tested separately in 6.4/d2). Use space-free paths throughout: the
default inner shell is `cmd.exe`.

Install (expect exactly one UAC prompt):

```powershell
npx @anthropic-ai/sandbox-runtime windows-install
```

> Expected: exit 0. Idempotent — running it twice is safe and rotates the
> sandbox account password.

Unelevated status probe:

```powershell
node --input-type=module -e "import {checkWindowsSandboxStatusAsync,resolveSrtWin,VENDORED_SRT_WIN_EXE} from '@anthropic-ai/sandbox-runtime'; const srtWin=resolveSrtWin({path:VENDORED_SRT_WIN_EXE}); console.log(JSON.stringify(await checkWindowsSandboxStatusAsync({srtWin}),null,2));"
```

> Expected: `user.provisioned: true`, `user.credPresent: true`, `user.sid`
> matching `S-1-5-21-…`, `user.groupExists: true`.
> `wfp.state` is `"cannot-read"` **with a `hint`** from a non-elevated shell and
> `"installed"` from an elevated one — both are pass. **A `cannot-read` here is
> not a failure**; it is exactly the admin-gating described in §2.2.

Settings file at `%USERPROFILE%\.srt-settings.json` (the CLI supplies
`VENDORED_SRT_WIN_EXE` itself, `cli.js:141-155`, so `windows.srtWin.path` may be
omitted for CLI runs):

```json
{
  "network":    { "allowedDomains": [], "deniedDomains": [] },
  "filesystem": { "allowRead": ["C:\\srt-spike\\py"],
                  "allowWrite": ["C:\\srt-spike\\scratch"],
                  "denyRead": [], "denyWrite": [] }
}
```

### 6.1 (a) Fenced Python runs — and runs as the sandbox account

```powershell
@'
import sys, getpass, os
print("hello from the fence")
print(sys.version)
print("user:", getpass.getuser())
print("profile:", os.environ.get("USERPROFILE"))
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_a.py

npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_a.py"
```

> Expected: exit 0; greeting and version print.
> **The load-bearing assertion is `user: srt-sandbox`** — proof it ran under the
> separate account and not as you. `USERPROFILE` should point at the sandbox
> account's profile, not yours.
> Fail ⇒ §1.2 is refuted; stop and re-open the assessment.

### 6.2 (b) Write outside scratch is DACL-denied

```powershell
@'
import os, pathlib
pathlib.Path(r"C:\srt-spike\scratch\ok.txt").write_text("in-scratch write")
print("scratch write: OK")
for target in (r"C:\Users\<YOU>\Documents\srt-escape.txt",
               os.path.expanduser(r"~\Documents\srt-escape.txt"),
               r"C:\srt-spike\py\srt-escape.txt",
               r"C:\Windows\Temp\srt-escape.txt"):
    try:
        open(target, "w").write("x"); print("WROTE (check):", target)
    except OSError as e:
        print("denied:", target, type(e).__name__, getattr(e, "winerror", e.errno))
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_b.py

npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_b.py"
```

> Substitute your real username for `<YOU>` — note that `~` **inside** the
> sandbox is the *sandbox account's* profile, which is why the literal path is
> tested too.
> Expected: `scratch write: OK`; your real `Documents` path **denied**
> (`PermissionError`, `winerror 5`); `C:\srt-spike\py` is `allowRead` only ⇒
> **denied** for write. `C:\Windows\Temp` is world-writable by ACL and **may
> succeed** — that is the §1.4 model difference, not a defect. Record which.
> Also confirm afterwards that `ok.txt` exists and is readable by you (the ACEs
> are additive; your own rights are untouched).

### 6.3 (c) Network blocked with `allowedDomains: []`

```powershell
@'
import os, socket, urllib.request
try:
    urllib.request.urlopen("https://example.com", timeout=15)
    print("HTTP: REACHED (UNEXPECTED)")
except Exception as e:
    print("HTTP blocked:", type(e).__name__, e)

print("dns:", socket.gethostbyname("example.com"))   # documented to SUCCEED

for k in ("HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy","NO_PROXY"):
    os.environ.pop(k, None)
try:
    socket.create_connection(("93.184.216.34", 443), 15)
    print("RAW TCP: CONNECTED (FENCE BREACH)")
except OSError as e:
    print("raw tcp blocked:", type(e).__name__, getattr(e, "winerror", e.errno))
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_c.py

npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_c.py"
```

> Expected:
> - `HTTP blocked` — the proxy refuses every domain under an empty allow-list.
> - `dns:` **prints an address**. This is the documented unfenced-resolver
>   limitation (§1.3) and is a **pass**, not a failure. A literal IP is used
>   below precisely so DNS is irrelevant to the real assertion.
> - `raw tcp blocked` with **WinError 10013 (WSAEACCES)** after the proxy env
>   vars are stripped. *(doc claim under test — the single most important
>   assertion in the plan: this is the kernel WFP filter, not an env
>   convention.)* A `CONNECTED` here means the fence is not installed or the
>   filters are absent; re-run the §6.0 probe from an elevated shell.
>
> Then set `allowedDomains` to `["example.com"]` and re-run: HTTP should succeed
> and raw TCP should **still** be blocked.

### 6.4 (d) Documented failure modes

**d1 — certificate revocation (schannel vs OpenSSL).** With
`allowedDomains: ["example.com"]`:

```powershell
npx srt -c "C:\Windows\System32\curl.exe -sS -o NUL -w %%{http_code} https://example.com"
npx srt -c "C:\Windows\System32\curl.exe --ssl-no-revoke -sS -o NUL -w %%{http_code} https://example.com"
npx srt -c "C:\srt-spike\py\python.exe -c \"import urllib.request;print(urllib.request.urlopen('https://example.com',timeout=20).status)\""
```

> Expected *(doc claim under test)*: the first fails with a schannel revocation
> error (`CRYPT_E_REVOCATION_OFFLINE` / `0x80092013`, curl exit 35 or 60); the
> second succeeds; **the Python one succeeds** because CPython uses OpenSSL.
> **This is the decisive one for us**: if Python also fails, §1.5's "low impact"
> assessment is wrong and every agent HTTP call on Windows breaks.

**d2 — per-user tool install unreachable (our packaging risk).**

```powershell
Copy-Item -Recurse C:\srt-spike\py "$env:LOCALAPPDATA\Programs\py"
npx srt -c "%LOCALAPPDATA%\Programs\py\python.exe -c \"print('reached')\""
```

> Expected *(doc claim under test)*: **fails** — access denied launching the
> interpreter, because it sits in the calling user's profile and the sandbox
> account has no rights there. Then add the expanded absolute path to
> `filesystem.allowRead`, re-run, and expect **success**.
> This settles where BST-1061's bundled CPython may live, and whether granting a
> persistent `READ|EXECUTE` ACE on the app's own install directory is the
> mitigation we ship.

**d3 — `pip install --user` lands in the wrong profile.**

```powershell
npx srt -c "C:\srt-spike\py\python.exe -m pip install --user --no-input requests"
npx srt -c "C:\srt-spike\py\python.exe -c \"import requests;print(requests.__file__)\""
```

> With `allowedDomains` covering PyPI, expect the install to write into the
> **sandbox account's** profile — invisible to the user and unmanaged by us.
> Record whether a scratch-scoped venv
> (`python -m venv C:\srt-spike\scratch\venv`) is a working substitute; that is
> the pattern a real agent workflow would need.

### 6.5 (e) The seam blocker, on hardware

```powershell
node --input-type=module -e "import {SandboxManager,VENDORED_SRT_WIN_EXE} from '@anthropic-ai/sandbox-runtime'; const base={network:{allowedDomains:[]},filesystem:{allowRead:['C:\\srt-spike\\py'],allowWrite:['C:\\srt-spike\\scratch'],denyRead:[],denyWrite:[]},windows:{srtWin:{path:VENDORED_SRT_WIN_EXE}}}; await SandboxManager.initialize(base); try { await SandboxManager.wrapWithSandboxArgv('C:\\srt-spike\\py\\python.exe -c \"pass\"', undefined, base, undefined, 'C:\\srt-spike\\scratch'); console.log('NO THROW (unexpected)'); } catch (e) { console.log('threw:', e.message); } await SandboxManager.reset();"
```

> Expected: throws *"Per-exec filesystem.allowRead/allowWrite is not supported on
> Windows"*. This reproduces §1.7.1 — i.e. PR #2190's FenceExecutor, run
> unmodified on Windows, would throw on **every** execution. Confirming it on
> hardware converts §2.4 from a code reading into a measured fact.

### 6.6 (f) Cost of the only correct lifecycle

Create `C:\srt-spike\scratch\p0` … `p9` first, then:

```powershell
node --input-type=module -e "import {SandboxManager,VENDORED_SRT_WIN_EXE} from '@anthropic-ai/sandbox-runtime'; const mk=(n)=>({network:{allowedDomains:[]},filesystem:{allowRead:['C:\\srt-spike\\py'],allowWrite:['C:\\srt-spike\\scratch\\p'+n],denyRead:[],denyWrite:[]},windows:{srtWin:{path:VENDORED_SRT_WIN_EXE}}}); const t=[]; for (let i=0;i<10;i++){ const s=Date.now(); await SandboxManager.initialize(mk(i)); await SandboxManager.reset(); t.push(Date.now()-s);} t.sort((a,b)=>a-b); console.log('ms:',t,'median',t[5]);"
```

> Records the per-policy-change cost of `reset()` + `initialize()` — the only
> lifecycle that applies filesystem policy correctly on Windows (§2.4).
> **Decision rule:** median under ~250 ms ⇒ per-exec policy is affordable and a
> Windows fence can keep the seam's contract as-is. Median over ~1.5 s ⇒ it is
> not, and the Windows fence needs a per-workspace session model (or the seam
> needs an explicit policy-epoch concept). The first iteration includes the
> once-per-process `verifyWindowsWfpEgress` logon and will be an outlier — hence
> the median.

### 6.7 (g) Cancellation / process-tree kill — the unported piece

```powershell
@'
import subprocess, sys, time
subprocess.Popen([sys.executable, "-c",
  "import time,pathlib\n"
  "p=pathlib.Path(r'C:\\srt-spike\\scratch\\grandchild.log')\n"
  "while True:\n    p.open('a').write('tick\\n')\n    time.sleep(0.2)"])
print("spawned grandchild", flush=True)
time.sleep(300)
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_g.py
```

Run it under `npx srt -c …`, confirm `grandchild.log` is growing, then kill the
broker (Ctrl-C, and separately `Stop-Process` on the direct child) and watch the
log for 5 s.

> Expected: **UNKNOWN — that is the point of the test.** srt-win places the child
> in a job object (§1.2), which *should* take the tree down when the job handle
> closes; PR #2190's `process.kill(-pid)` definitely will not, since POSIX
> process groups do not exist on Windows. Record whether the log stops growing
> within 2 s. If the job object does the work, a Windows fence needs no kill
> logic of its own beyond closing the broker's child; if it does not,
> cancellation needs a Windows-specific implementation and that is a ticket —
> and it should extend the existing `packages/windows-job-native` addon (already
> built and tested in CI, currently dev-tooling-only) rather than add a third
> kill path.

### 6.8 Teardown

```powershell
npx @anthropic-ai/sandbox-runtime windows-uninstall
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\sandbox-runtime"   # state.db is NOT removed by uninstall
Remove-Item -Recurse -Force C:\srt-spike, "$env:USERPROFILE\.srt-settings.json", "$env:LOCALAPPDATA\Programs\py"
```

> Then re-run the §6.0 status probe: expect `provisioned: false`. If an unclean
> run left ACEs behind, `srt-win acl recover` sweeps by trustee SID (§1.4).

### 6.9 Reporting back

Paste the recorded output into this doc under a new `## 7. Windows run <date>`
section and update §5's gate. The three results that change the recommendation
are **6.4/d1 Python** (breaks the low-impact assessment if it fails), **6.6
median** (decides per-exec vs per-session policy), and **6.3 raw tcp** (if it
connects, the fence is not what srt documents).
