# BST-1068 — the srt Windows fence (native alpha): assess & gate

Date: 2026-08-01
Subject: `@anthropic-ai/sandbox-runtime` (srt) `0.0.67` — the version PR #2190
pins in the workspace catalog, and `latest` on npm as of this date
(`npm view @anthropic-ai/sandbox-runtime dist-tags` → `latest: '0.0.67'`).

Decision: **keep Windows off the `fence` capability. A Windows host advertises
no `fence` factory, so `resolveCodeExecutor('fence', host)` throws
`ExecutorKindUnavailableError`. Do not prompt Windows users for the elevated
install.** Revisit when the gate in §5 is cleared.

**Unchanged after the hardware run (§7) — but now on four independent legs
instead of one (§2.6), three of them measured.** The fence itself worked: Python
ran under it, and the WFP kernel egress fence held against a process that
stripped every proxy variable. What did not hold is our ability to drive it
through this seam's contract: the correct lifecycle costs **1559 ms per policy
change**, `allowRead` is **not read-only** on Windows, and path canonicalization
**does not work the way this document assumed**. Those are design problems, not
maturity problems.

> ## Provenance — read this before citing anything below
>
> **§1–§5 were written on macOS (darwin/arm64) from srt 0.0.67's shipped
> source, type declarations, and README.** They are a code-reading, and every
> claim carries its evidence.
>
> **§6 has since been executed on a real, provisioned Windows 11 x64 host
> (Node 24.14.0, CPython 3.10.10). The results are §7.** BST-1068's acceptance
> criterion — *fenced Python verified on a real Windows host* — is therefore
> **MET**: Python ran under the fence as the `srt-sandbox` account, the WFP
> egress fence was proven at the kernel with `WSAEACCES`, and `pip --user`
> was proven to land in the sandbox account's profile.
>
> **Where §7 contradicts §1–§5, §7 wins and the section is marked.** The run
> refuted one of this document's own premises (§1.9a: `fs.realpath` does NOT
> canonicalize on Windows), invalidated one of its test fixtures (§6.2 ran
> against a directory the sandbox could already write), failed to reproduce
> one of srt's documented limitations (§1.5 cert revocation), and **crossed
> the affordability threshold this document set for itself** (§6.6: 1559 ms
> median, against a ≥1500 ms "not affordable" line).
>
> Claims still resting on srt's documentation rather than observation are
> labelled *(doc claim, not observed)* in place.

### Repo state this was written against

- `docs/agents/code-execution.md` and `packages/agent/src/code-execution.ts` at
  `origin/main` **57756e1**, which includes the BST-1060 seam hardening
  (**8448ffd**, PR #2189) and ADR-0003 (**29aab71**, PR #2185). §2 was drafted
  against the hardened contract before it merged and re-checked against it
  after; three of its details are load-bearing and did ship as described:
  `REQUIRED_ISOLATION_TIER` + `ExecutorTierMismatchError` and the
  `resolveCodeExecutor` tier assertion; `CodeExecutorFactory` is still
  **synchronous** (`() => CodeExecutor`), which is what forces the Windows
  readiness probe up into host-capability assembly (§2.2); and `signal` is now
  **required** on `ExecInput`, with backends obliged to terminate the process
  tree when it fires — which promotes §6.7 from a nicety to a contract
  requirement.
- **The FenceExecutor has since MERGED** (**5277afc**, PR #2190), so §2 and §4
  were re-checked against shipped code rather than the pre-merge draft. The
  outcome is in §2.5: the shipped gate matches this spike's recommendation, and
  the merged design makes the expressibility finding sharper, not softer.
  `docs/agents/code-execution.md` also gained a normative
  **"Backends MUST resolve before asking"** section in that window; the Windows
  wrinkles it raises are §1.9.

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

### 1.3 "Network fence = WFP kernel filters (permit loopback-to-proxy only), enforced even if the process unsets proxy env vars" — **CONFIRMED ON HARDWARE (§7.1), with one documented hole**

> **Measured 2026-08-01.** A fenced CPython that popped every proxy variable
> from `os.environ` and connected direct to a caller-owned loopback listener
> outside the permit range was refused at `connect()` with **`WSAEACCES`
> (10013)**. With `example.com` allow-listed, HTTP succeeded *and* the raw
> connect was still refused. This is no longer a doc claim.

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

> **⚠️ MEASURED (§7.3c) — and sharper than the paragraph above admits.** A
> directory created directly under the host's default `C:\` ACL inherited
> `Authenticated Users:(OI)(CI)(M)`. Because srt **only adds** ACEs and never
> removes existing ones, the sandbox account — itself an authenticated user —
> **wrote into a path listed only in `allowRead`.**
>
> **On Windows, `filesystem.allowRead` does not mean read-only.** It means "add
> a read ACE for the sandbox SID." Where the existing ACL already grants write
> to a group the sandbox account belongs to, the sandboxed process can still
> write. On macOS Seatbelt and Linux bubblewrap the identical `ExecPolicy`
> genuinely constrains — the profile and the bind mount are the whole access
> set, not an addition to one.
>
> This makes `ExecPolicy` **weaker on Windows for the same input**, with nothing
> in `ExecutorCapabilities` able to express it (§2.6, gap 3). A Windows backend
> would have to either verify the baseline ACL of every `allowRead` path and
> refuse when it is already writable by the sandbox principal, or stop
> advertising `allowRead` as a read-only guarantee.

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
`requests`, `httpx`, and `pip` take the env-var trust path (`README.md:543`:
`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, …, with the bundle
path auto-added to the session `allowRead` grant).

> **Measured 2026-08-01 (§7.3b) — split verdict.**
>
> - **The part that matters to us is SUPPORTED by observation.** The fenced
>   CPython/OpenSSL request returned **HTTP 200**. Agent Python runs are
>   unaffected, which was the decisive question.
> - **The schannel limitation itself did NOT reproduce.** On a genuinely
>   Schannel-backed `curl 8.21.0`, *both* the plain and the `--ssl-no-revoke`
>   fenced requests returned **200, exit 0**.
>
> That is neither confirmation nor refutation: the documented mechanism is real
> (it is quoted above from srt's README) but did not fire on this host. The
> most likely reason is **valid cached revocation data** — CryptoAPI only makes
> the CRL/OCSP fetch that WFP blocks on a cache miss, and any prior unfenced
> visit to that host populates it. `certutil -URLCache CRL delete` before the
> run would make it decisive; §6.4/d1 now says so and carries an explicit
> "both succeed" branch so this outcome is no longer forced into a category
> that does not fit it.

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

> **Measured 2026-08-01 (§7.1) — CONFIRMED.** A fenced `pip install --user
> requests` succeeded, and `requests.__file__` resolved under
> `C:\Users\srt-sandbox\AppData\Roaming\Python\…`. The package is real, usable
> inside the fence, and invisible to the caller.

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
| `resolveSrtWin()` requires an **explicit** `windows.srtWin.path` — "no ambient vendor fallback" | `windows-sandbox-utils.js:193-203` | Electron packaging must `asar`-unpack `vendor/srt-win/<arch>/srt-win.exe` and pass its real on-disk path; an exe inside an asar archive cannot be spawned. srt's own CLI opts into `VENDORED_SRT_WIN_EXE` explicitly (`cli.js:145-155`) — the library never guesses |
| `proxyAuthToken` is **visible in the runner's argv** | README known limitation 5 | "readable by any local principal that can open the runner process for `PROCESS_QUERY_LIMITED_INFORMATION`". Fine on a single-user dev machine; on a shared host, treat the allowlist as reachable by other same-session principals |
| `network.tlsTerminate` needs a **separate, unelevated** CA-trust step | `README.md:532-543`; `windowsTrustCa` / `ensurePersistentWindowsCa` | Not covered by `windows-install`. `initialize()` fails closed on a thumbprint mismatch. We do not use `tlsTerminate` today; noted so a future request-filtering feature does not discover it late |
| A **non-elevated readiness probe exists** | `checkWindowsSandboxStatusAsync`, `checkWindowsDependenciesAsync` (both exported) | This is what makes the capability model in §2 possible at all |
| `verifyWindowsWfpEgress` is **once per process**, never cleared by `reset()` | `sandbox-manager.js:391-403`; `:1526` comment "`windowsWfpVerified` is NOT cleared — per-process, not per-session" | Good news for a reset/initialize-per-policy lifecycle: the expensive `CreateProcessWithLogonW` probe is not repeated |

### 1.9 Path containment on Windows — three wrinkles the seam's new rule does not yet cover

`docs/agents/code-execution.md` gained a normative **"Backends MUST resolve
before asking"** section (realpath both operands before `isPathCoveredBy`; an
unresolved operand is a security bug; do NOT case-fold on darwin, because case
sensitivity is a *filesystem* property and folding errs toward a false PERMIT).
The reasoning is right and it transfers to Windows — but Windows has strictly
more aliasing than APFS, and one of its consequences is that the seam already
does on Windows-shaped paths the exact thing the section forbids on darwin.

Status after the Windows run and BST-1074: **(a) was measured and REFUTED — the
premise this section rested on was wrong**; **(b) is FIXED on main**; **(c)
stands as read.** No Windows backend exists, so none of this was ever live in
production, but (a) is not a latent Windows-only concern — the same JS-vs-native
`realpath` gap it exposed was reachable on darwin, and BST-1074 fixed it there.

**a. NTFS aliases a path more ways than a symlink.** 8.3 short names
(`C:\PROGRA~1\x` ≡ `C:\Program Files\x`), trailing dots and spaces (Win32
strips them, so `C:\scratch\evil.` opens `evil`), alternate data streams
(`file.txt:hidden`), reserved device names (`CON`, `NUL`, `COM1`), and the
`\\?\` extended-length prefix — which bypasses Win32 path normalization
entirely, and which srt is aware of, since it exports
`stripExtendedPathPrefix`. Short names in particular are the same dodge class
as the symlink the section exists to close: a textual comparison sees
`C:\PROGRA~1` and `C:\Program Files` as unrelated, and the filesystem does not.

**⚠️ MEASURED AND REFUTED (§7.3a). The original claim here was wrong.** This
paragraph read: *"`realpath` should still be the whole answer — libuv's
`uv_fs_realpath` implements Windows realpath via `GetFinalPathNameByHandleW`."*
On Windows 11 x64 / Node 24.14.0, `fs.realpathSync` returned the 8.3 short
spelling `C:\SRT-SP~1\PROGRA~1` unchanged, and returned an uppercased path
unchanged. It canonicalized **neither** the short name nor the case.

The cause is a Node API distinction the original claim missed: `fs.realpath` is
Node's **JavaScript** implementation, which resolves symlinks but copies
non-symlink components **verbatim from the input string**. Only
`fs.realpath.native` calls into libuv. BST-1074 hit the same gap from the other
side and switched `fence-policy`'s default resolver to `realpath.native` after
measuring on darwin that JS returns `mixedcase` where native returns
`MixedCase` — so the seam's "resolve before asking" requirement is only
actually satisfied by the native binding.

**What is still unverified: whether `realpath.native` expands 8.3 short names
on Windows.** Case canonicalization and short-name expansion are different
Win32 behaviours, and `.native` being right about case on darwin says nothing
about short names on NTFS. Assuming otherwise would repeat the exact mistake
this paragraph is a correction of. §6.8 now tests **both bindings** against
**both** aliases.

Until that is measured, treat this as the operative rule: **a Windows backend
must canonicalize explicitly and verify it before comparing coverage** —
`GetFinalPathNameByHandleW` / `GetLongPathNameW`, or a file-identity comparison
(`FILE_ID_INFO` / `BY_HANDLE_FILE_INFORMATION`) that sidesteps spelling
entirely. Carried into §5 as a hard prerequisite.

**b. `isPathCoveredBy` case-folds the whole path on Windows-shaped operands,
and that is the guess the new section rejects.** The predicate folds case
whenever `isWindowsShapedPath(target) || isWindowsShapedPath(root)`
(`packages/agent/src/code-execution.ts`), but its stated justification is
narrower than its behaviour: *"drive-letter case is not stable across Node
APIs."* Folding every segment to fix the drive letter is the same
platform-shaped guess in the same dangerous direction the section calls out —
NTFS is case-insensitive **by default** but supports **per-directory** case
sensitivity (`fsutil file setCaseSensitiveInfo`, which WSL sets on directories
it creates), so a false PERMIT is reachable on a real volume.

Recommendation was: **fold the drive letter only.**

**✅ FIXED ON MAIN — BST-1074 (`ae67943`, PR #2195)** picked this up from an
earlier draft of this section and narrowed the fold to the volume prefix, with
one correction to the recommendation as written: **UNC paths have TWO
case-insensitive volume segments**, the host *and* the share, both
case-insensitive at the SMB protocol level, so folding index 0 alone would have
left the share comparing case-sensitively. `isPathCoveredBy` now folds
`windowsVolumeSegmentCount(target, root)` segments — 1 for a drive letter, 2
for UNC — and has UNC assertions, which it had none of before.

Note the dependency between (a) and (b): narrowing the fold is only safe
*because* resolution is supposed to deliver canonical on-disk spelling for the
path body. §7.3a showed that guarantee did not hold with the JS `realpath`, so
the two changes have to land together — which is why BST-1074 also switched the
default resolver to `realpath.native`. On Windows, per (a), even that is not yet
proven sufficient.

**c. A mapped network drive cannot be resolved by the sandbox at all.** srt
fails such a launch with a typed `mapped_drive_cwd` error (`srt-win exec` exit
**16**, surfaced via `parseWindowsSandboxError`, carrying the failing root on
`.drive`), and the reason is the separate-account model itself: *"per-user
drive mappings don't exist under the sandbox logon."* A `Z:\` that resolves
perfectly for the caller is not a path at all for `srt-sandbox`. This has no
macOS or Linux analogue — it is a case where a path is canonical, existent, and
readable for the broker while being meaningless to the sandboxed process — and
any Windows fence must surface it as a typed refusal rather than a confusing
access error.

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

What it actually checks (`windows-sandbox-utils.js:1316-1400`):

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
   a construction-time error, never a weaker sandbox. That satisfies the seam's
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
| Budget the reset/initialize round trip | it re-stamps every ACE. **MEASURED (§7.2): median 1559 ms over ten cycles, fastest 1531 ms.** That crosses the >=1500 ms line this document set in advance, so per-exec policy is NOT affordable on Windows and the design needs a per-workspace session model or a seam-level policy-epoch concept |

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

### 2.5 Checked against the shipped FenceExecutor (5277afc)

§2.1–§2.4 were written before BST-1062 merged, from the PR diff. Now that it is
on main, here is the same recommendation checked against real symbols in
`packages/agent/src/fence/fence-executor.ts` rather than inferred shapes.

**The shipped gate matches the recommendation exactly.**

```ts
export function isFenceSupported(): boolean {
  return (platform === 'darwin' || platform === 'linux') && SandboxManager.isSupportedPlatform();
}

export function createFenceExecutorFactory(
  options: FenceExecutorOptions
): CodeExecutorFactory | undefined {
  if (!isFenceSupported()) {
    return;                       // absent factory → ExecutorKindUnavailableError
  }
  return () => createFenceExecutor(options);
}
```

That is §2.1's "absent factory, not present-and-throwing", implemented. Nothing
in this spike needs to change on that point, and `createFenceExecutor()` throws
`FenceUnsupportedPlatformError` if called directly on an unsupported host —
belt and braces, with a message that names the rule ("The host must not offer a
fence factory here").

Three details the shipped code makes concrete, which the pre-merge draft could
only assert:

1. **The explicit platform allow-list is the entire gate, and it is one line
   from being flipped.** `SandboxManager.isSupportedPlatform()` returns **true**
   on Windows (§1.1), so the `&&` is not what excludes it — the literal
   `platform === 'darwin' || platform === 'linux'` is. And
   `currentExecPlatform()` **already accepts `'win32'`** and returns it, so the
   `ExecPlatform` plumbing is Windows-ready end to end. A well-meaning cleanup
   that "simplifies" `isFenceSupported()` to just srt's own probe would enable
   Windows silently, with a `capabilities()` that reports `os-fence` and a
   filesystem policy that is quietly wrong from the second execution onward.
   That is why the *reason* for the gate has to live next to the line; I have
   added it to `docs/agents/code-execution.md`.
2. **`createFenceExecutorFactory` is synchronous**, as is `isFenceSupported()`.
   §2.2's argument was that a Windows readiness probe (two `srt-win.exe`
   spawns, seconds under a Defender cold scan) cannot fit inside a sync
   factory and must move up to host-capability assembly. That is now a fact
   about shipped signatures, not a prediction.
3. **The merged design makes the expressibility finding SHARPER.** The shipped
   lifecycle is "initialize ONCE per process, `updateConfig` per execution,"
   with the per-execution `customConfig` override applied *as well* — the doc is
   explicit that the override alone "would leave the proxy filtering on a stale
   allow-list; both are applied." On Windows those are precisely the two
   mechanisms that fail (§1.7): `updateConfig()` warns and keeps the previous
   file-access set, and the `customConfig` carrying `filesystem.allowWrite`
   throws outright. So the shipped executor does not merely *happen* to be
   darwin/linux-shaped — **the specific mechanism it relies on for per-execution
   policy is the one Windows srt refuses.** Widening `isFenceSupported()`
   without the §2.4 lifecycle rework would not be "alpha but probably fine"; it
   would throw on every execution, and if that throw were removed, silently
   pin every run to the first run's filesystem policy.

The corollary for the gate (§5) is unchanged but better grounded: enabling
Windows is a lifecycle rework, not a platform-flag change.

### 2.6 The recommendation after the hardware run — UNCHANGED, on four legs instead of one

The Windows run (§7) did not move the capability call. It moved the *basis* for
it: what was one argument from code-reading is now four, three of them measured
on real hardware, and they are independent — fixing any one leaves the others
standing.

| # | Leg | Status | Consequence if a Windows fence shipped anyway |
| --- | --- | --- | --- |
| 1 | **Correctness** — per-execution filesystem policy is inexpressible; `updateConfig()` warns and keeps the previous set, per-exec grants throw | Read from `sandbox-manager.js`; **§6.5 not run**, so still unobserved (§7.4) | Every run after the first silently uses the first run's policy |
| 2 | **Affordability** — the only correct lifecycle costs **1559 ms median** per policy change (§7.2) | **MEASURED** | ~1.6 s of setup before every `run_python`, against a standing latency constraint |
| 3 | **Policy fidelity** — `allowRead` is not read-only when the baseline ACL already grants write to the sandbox principal (§7.3c) | **MEASURED** | The same `ExecPolicy` yields materially weaker isolation on Windows, unadvertisable |
| 4 | **Containment** — path canonicalization does not work as assumed; `fs.realpath` de-aliases neither short names nor case, and `.native` is unproven for short names on NTFS (§7.3a) | **MEASURED (refutation)**; `.native` behaviour still open | Coverage comparisons can be dodged by spelling |

Legs 2, 3, and 4 are all *new since the pre-merge draft*, and none of them is a
maturity complaint — they would each be true of a Windows fence built on a
post-alpha srt. That is the substantive update: **the case for gating Windows
got stronger, not weaker, when we finally ran it.**

What would change the call: leg 2 is answered by a per-workspace session model
(or a seam policy-epoch concept), leg 3 by baseline-ACL verification at
`initialize()`, leg 4 by a verified explicit canonicalizer. Those are three
design changes and one measurement — a project, not a flag. §5 carries them.

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

## 4. The correction applied to the merged FenceExecutor (nothing structural)

BST-1062 shipped `createFenceExecutorFactory()` returning `undefined` on
`win32`, which is this spike's recommendation (§2.5). No code change was needed
or made. The only thing that needed correcting was the **stated reason**, which
read:

> Windows is srt-alpha (needs a provisioned sandbox user + WFP fence) and its
> process-tree kill is unverified here — deliberately NOT offered rather than
> shipped untested.

That is true but ranks the causes wrongly, and "unverified, so not shipped
untested" invites the reading that Windows just needs someone to test it —
when in fact the shipped per-execution policy mechanism is the one Windows srt
refuses (§2.5.3). This change rewrites that bullet in
`docs/agents/code-execution.md` to lead with the expressibility blocker, keep
the process-tree kill as the secondary problem it is, and pin the
`isFenceSupported()` allow-list as load-bearing so a future cleanup does not
delete the gate by accident.

---

## 5. Gate — what would have to be true to revisit

Rewritten after the Windows run. Item 2 is **decided**, not open; items 5–7 are
new, and every one of them came from running the thing.

1. srt Windows leaves alpha. (The §6 plan has now been run — §7 — so "accept
   alpha explicitly with evidence" is no longer hypothetical; the evidence
   argues against shipping, not for it.)
2. ~~Decide per-exec vs per-workspace policy from §6.6.~~ **DECIDED by
   measurement: 1559 ms median ⇒ per-exec policy is not affordable.** What
   remains is to *design* the replacement — a per-workspace session model with
   a typed refusal when a request's policy differs from the session's, or an
   explicit seam-level policy-epoch concept. Own ticket.
3. BST-1061's interpreter placement is resolved against §1.6 (machine-wide
   install location, or a tested `allowRead` grant on the app's own install
   directory).
4. Electron packaging unpacks `srt-win.exe` from asar and threads its path.
5. **NEW — a verified path canonicalizer exists for Windows.** §7.3a refuted
   the `realpath` premise. A backend needs `GetFinalPathNameByHandleW` /
   `GetLongPathNameW`, or file-identity comparison, with a Windows test proving
   it de-aliases **both** 8.3 short names and case. `realpath.native` is a
   candidate, not an answer, until §6.8 is run against it.
6. **NEW — `allowRead` baseline-ACL verification.** §7.3c showed additive ACEs
   let the sandbox write a read-only path whose existing ACL already grants
   write to `Authenticated Users`. Either verify each `allowRead` path's
   baseline at `initialize()` and refuse when it is already writable by the
   sandbox principal, or stop advertising `allowRead` as read-only on Windows.
7. **NEW — process-tree kill is demonstrated** (§6.7, still unrun). `ExecInput`
   requires `signal` and the seam obliges backends to take the tree down; on
   Windows `process.kill(-pid)` cannot, so srt-win's job object has to be shown
   to do it, or `packages/windows-job-native` extended to.

---

## 6. Runnable Windows test plan (EXECUTED 2026-08-01 — results in §7)

One sitting, ~90 min. Nothing below has been executed.

**Host:** Windows 11, x64 or arm64 (no 32-bit — §1.1), an account that can
elevate, Node ≥ 20.11. Prefer a VM, or a machine you are willing to leave a
local account on; §6.9 removes it.

### 6.A How not to fool yourself — read before running anything

Nobody on this team can run this plan. Someone else will run it once and report
the result as fact, and that report will decide whether we ship a security
boundary. **A step that can print "pass" while the mechanism under test is
entirely absent is worse than no step at all**, because it manufactures
confidence rather than merely lacking it.

Two such steps were caught in review of this document (a `%LOCALAPPDATA%` that
does not expand in PowerShell and so resolved against the wrong profile, turning
a file-not-found into a recorded DACL denial; and a bare `except OSError` that
declared "blocked" for a timeout, a refused connection, or an unreachable host —
on the plan's single most important assertion). Assume the same class is still
lurking. Three rules close it:

1. **Every isolation assertion needs a negative control.** Before claiming the
   fence denied an operation, run the *same operation outside the fence as
   yourself* and require it to **succeed**. A denial only means something if the
   thing would otherwise have worked. Controls below are labelled `CONTROL` and
   are not optional.
2. **Assert the specific Windows error code, never the exception class.**
   `ERROR_ACCESS_DENIED` (5) is the DACL fence. `WSAEACCES` (10013) is the WFP
   fence. `ERROR_FILE_NOT_FOUND` (2) / `ERROR_PATH_NOT_FOUND` (3) / `ETIMEDOUT`
   / `ECONNREFUSED` are **inconclusive** — they mean the mechanism was never
   consulted, and they must be recorded as INCONCLUSIVE, never as a pass.
3. **Scripts exit non-zero on anything but the expected outcome**, so a result
   cannot be mis-eyeballed from a wall of output. Every script below prints
   exactly one of `PASS:`, `FAIL:`, or `INCONCLUSIVE:` and sets an exit code to
   match (`0` / `1` / `2`).

**Never nest quotes inside an `srt -c` string — put the code in a file.**
PowerShell does not treat `\"` as an escaped quote (that is C/cmd escaping), so
a line like `srt -c "python.exe -c \"...\""` dies at PowerShell parse time
before `npx` or srt ever starts. Write the script to `scratch\` with an
`@'…'@` here-string and pass the **path**, as every step below does. Same trap,
different escape: curl's `-w` takes a **single** `%` in PowerShell —
`%%{http_code}` is cmd/batch escaping and, because `%%` is curl's own escape
for a literal percent, it makes curl print the text `%{http_code}` instead of
the status.

**Expand host paths in the OUTER PowerShell, never inside the `srt -c` string.**
The command string is handed to an inner `cmd.exe` running as `srt-sandbox`, so
`%LOCALAPPDATA%`, `%USERPROFILE%`, and `%TEMP%` resolve against the **sandbox
account's** profile there — silently pointing at a different directory than you
meant. Build the absolute path with `$env:…` in PowerShell and interpolate it.

Report every step as PASS / FAIL / INCONCLUSIVE with its exit code and full
output. An INCONCLUSIVE is a perfectly good result and must not be smoothed into
a pass.

### 6.0 Setup

**Preflight — refuse to run on paths this plan did not create.** Everything the
run touches must be absent beforehand, and the one file that is *not* ours
(`~/.srt-settings.json`) is backed up rather than overwritten. Teardown (§6.9)
deletes only what this block recorded.

```powershell
$ErrorActionPreference = 'Stop'
$RUN      = 'C:\srt-spike'
$SETTINGS = Join-Path $env:USERPROFILE '.srt-settings.json'
$BACKUP   = "$SETTINGS.bst1068.bak"
$CREATED  = [System.Collections.ArrayList]::new()   # only these get deleted

if (Test-Path $RUN) { throw "$RUN already exists. Choose a fresh path or remove it YOURSELF after checking what is in it — this plan must not delete anything it did not create." }
if (Test-Path $BACKUP) { throw "$BACKUP already exists — a previous run did not restore cleanly. Resolve by hand before continuing." }
if (Test-Path $SETTINGS) {
  Copy-Item $SETTINGS $BACKUP           # your real srt config; restored in §6.9
  "backed up existing $SETTINGS -> $BACKUP"
} else { "no pre-existing $SETTINGS" }

New-Item -ItemType Directory $RUN, "$RUN\scratch" | Out-Null
[void]$CREATED.Add($RUN)
cd $RUN
npm init -y
npm i @anthropic-ai/sandbox-runtime@0.0.67
```

> Keep `$RUN`, `$SETTINGS`, `$BACKUP`, and `$CREATED` alive in this **same
> PowerShell session** through teardown. If the session dies, do §6.9 by hand
> and check each path before deleting it.

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

Unelevated status probe — **this one gates everything after it**:

```powershell
node --input-type=module -e @'
import {checkWindowsSandboxStatusAsync,resolveSrtWin,VENDORED_SRT_WIN_EXE} from "@anthropic-ai/sandbox-runtime";
const srtWin = resolveSrtWin({path: VENDORED_SRT_WIN_EXE});
const s = await checkWindowsSandboxStatusAsync({srtWin});
console.log(JSON.stringify(s, null, 2));
if (!s.user.provisioned || !s.user.credPresent) {
  console.log("FAIL: sandbox user not provisioned/credential unreadable — every later step is meaningless. Re-run windows-install.");
  process.exit(1);
}
if (!/^S-1-5-21-/.test(s.user.sid ?? "")) { console.log("FAIL: no sandbox user SID"); process.exit(1); }
console.log(`PASS: sandbox user provisioned, sid=${s.user.sid}; wfp.state=${s.wfp.state}`);
'@
```

> `wfp.state` is `"cannot-read"` from a non-elevated shell and `"installed"` from
> an elevated one — **both are a pass**, because BFE enumeration is admin-gated
> (§2.2). `cannot-read` is *not* evidence the filters are absent, and it is *not*
> evidence they are present either; §6.3 is the only thing that settles that.
> A `FAIL:` here stops the run.

Settings file at `%USERPROFILE%\.srt-settings.json` (the CLI supplies
`VENDORED_SRT_WIN_EXE` itself, `cli.js:145-155`, so `windows.srtWin.path` may be
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
who = getpass.getuser()
print("python:", sys.version.split()[0], "| user:", who, "| profile:", os.environ.get("USERPROFILE"))
if who.lower().startswith("srt-sandbox"):
    print("PASS: running as the sandbox account"); sys.exit(0)
print(f"FAIL: ran as '{who}', not srt-sandbox — the code executed OUTSIDE the fence"); sys.exit(1)
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_a.py

npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_a.py"
echo "exit=$LASTEXITCODE"
```

> This step is self-controlling: an unfenced run prints your own username and
> fails. `USERPROFILE` should also point at the sandbox account's profile.
> A `FAIL:` here refutes §1.2 — stop and re-open the assessment.

### 6.2 (b) Write outside scratch is DACL-denied

**CONTROL first** — prove the target is writable by *you*, so a later denial is
attributable to the fence and not to a missing directory (the failure caught in
review). Note `$env:USERPROFILE` is expanded **here**, in the outer shell:

```powershell
$outside = Join-Path $env:USERPROFILE 'Documents\srt-escape.txt'
Set-Content -Path $outside -Value 'control' -ErrorAction Stop
Remove-Item $outside
"CONTROL PASS: $outside is writable by me"
$outside | Out-File -Encoding ascii C:\srt-spike\scratch\target.txt
```

> If the CONTROL fails, fix it before continuing — a denial against a path you
> could not write anyway proves nothing.

**PREFLIGHT for the `allowRead`-only fixture — this one invalidated the
original run (§7.3c).** `C:\srt-spike\py` was created under the default `C:\`
ACL and inherited `Authenticated Users:(OI)(CI)(M)`. srt only **adds** ACEs, so
the sandbox account could write it regardless of the policy, and the probe
proved nothing. The fixture has to start caller-private, and that has to be
**verified rather than assumed**:

```powershell
# Break inheritance and give only the caller + SYSTEM + Administrators access.
icacls C:\srt-spike\py /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)(F)" `
  "SYSTEM:(OI)(CI)(F)" "Administrators:(OI)(CI)(F)" | Out-Null

# It must NOT mention a group the sandbox account belongs to.
icacls C:\srt-spike\py
$acl = (icacls C:\srt-spike\py) -join "`n"
if ($acl -match 'Authenticated Users|BUILTIN\\Users|Everyone') {
  throw "baseline ACL still grants a group srt-sandbox belongs to — the allowRead assertion would be vacuous"
}
"PREFLIGHT PASS: py fixture is caller-private"
```

> Then confirm behaviourally, which is the only real proof: **before** adding
> `py` to `allowRead`, run the fenced probe below with `py` absent from the
> policy entirely and require the write to be **denied**. If it is denied only
> then, the later `allowRead` run is testing what it claims. If it is allowed,
> the baseline ACL is still too broad — fix it before continuing.

```powershell
@'
import sys, pathlib
target = pathlib.Path(r"C:\srt-spike\scratch\target.txt").read_text().strip()
rc = 0

try:
    pathlib.Path(r"C:\srt-spike\scratch\ok.txt").write_text("in-scratch write")
    print("PASS: write inside scratch succeeded")
except OSError as e:
    print(f"FAIL: scratch is in allowWrite but write failed: {e}"); rc = 1

def probe(label, path):
    # Branch on the EXCEPTION CLASS, not winerror. CPython 3.10 on Windows
    # reports a real access denial as PermissionError errno=13 with
    # winerror=None (measured, §7.3e), so requiring winerror==5 reported a
    # genuine control-backed denial as INCONCLUSIVE. The discrimination that
    # matters — denied vs never-consulted — survives, because
    # FileNotFoundError/NotADirectoryError are distinct classes.
    global rc
    try:
        open(path, "w").write("x")
        print(f"FAIL[{label}]: wrote {path} — no DACL denial"); rc = 1
    except PermissionError as e:
        print(f"PASS[{label}]: {path} denied (PermissionError errno={e.errno} "
              f"winerror={getattr(e, 'winerror', None)})")
    except (FileNotFoundError, NotADirectoryError) as e:
        print(f"INCONCLUSIVE[{label}]: {path} {type(e).__name__} — path/parent missing, "
              f"the DACL was never consulted; NOT a pass"); rc = max(rc, 2)
    except OSError as e:
        print(f"INCONCLUSIVE[{label}]: {path} {type(e).__name__} errno={e.errno} "
              f"winerror={getattr(e, 'winerror', None)} — NOT a pass"); rc = max(rc, 2)

probe("caller-profile", target)          # absolute path from the CONTROL above
probe("allowRead-only", r"C:\srt-spike\py\srt-escape.txt")
sys.exit(rc)
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_b.py

npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_b.py"
echo "exit=$LASTEXITCODE"
```

> The caller-profile probe reads its target from the file the CONTROL wrote, so
> the fenced run and the control test **the same absolute path** — no `~` (which
> is the sandbox account's profile inside the fence) and no unexpanded token.
> `C:\srt-spike\py` is `allowRead` only, so it must deny writes too.
> Afterwards, confirm from your own shell that `C:\srt-spike\scratch\ok.txt`
> exists and is readable by you — the ACEs are additive, so your rights are
> untouched.
>
> Not tested as a pass/fail: `C:\Windows\Temp` is world-writable by its own ACL
> and the sandbox account may legitimately write there. That is the §1.4 model
> difference (DACL fence, not a namespace), and it is worth recording as an
> observation.

### 6.3 (c) Network blocked with `allowedDomains: []` — the decisive step

The earlier draft connected to a hard-coded public IP and accepted any `OSError`
as proof. Both are wrong: a dead route or a timeout would have been recorded as
a working kernel fence. This version connects to **a listener we own on
loopback**, so an absent fence produces an immediate successful connect rather
than a slow ambiguous failure — the same technique srt's own
`verifyWindowsWfpEgress` uses. No DNS, no internet, no timeouts.

**Terminal 1 — bind a listener outside the WFP loopback-permit range and leave
it running:**

```powershell
node -e "const s=require('net').createServer(c=>c.end()); s.listen(0,'127.0.0.1',()=>console.log('PORT', s.address().port))"
```

> Note the port. If it happens to land inside `60080-60089`, Ctrl-C and re-run —
> that range is *permitted* by the WFP filter and would invert the test.

**Terminal 2 — CONTROL: the listener must be reachable unfenced.**

```powershell
$PORT = <port from Terminal 1>
C:\srt-spike\py\python.exe -c "import socket;socket.create_connection(('127.0.0.1',$PORT),5);print('CONTROL PASS: listener reachable unfenced')"
```

> If the CONTROL fails, the listener is wrong and every result below is void.

**Terminal 2 — the fenced run:**

```powershell
@'
import os, socket, sys, urllib.request
PORT = int(sys.argv[1])
# The HTTP expectation is a PARAMETER, because this same script is rerun as the
# allow-listed control where success is REQUIRED. Hard-coding "HTTP success =
# FAIL" made the control exit 1 while the fence was working perfectly (§7.3d).
EXPECT = sys.argv[2]                      # "block" | "allow"
assert EXPECT in ("block", "allow"), f"expected block|allow, got {EXPECT!r}"
rc = 0

# 1. Proxy-mediated HTTP, judged against the policy actually in force.
try:
    status = urllib.request.urlopen("https://example.com", timeout=15).status
    if EXPECT == "allow":
        print(f"PASS: HTTP reached example.com (status {status}) with it allow-listed")
    else:
        print("FAIL: HTTP reached example.com under allowedDomains: []"); rc = 1
except Exception as e:
    if EXPECT == "block":
        print(f"PASS: HTTP blocked under allowedDomains: [] ({type(e).__name__})")
    else:
        print(f"FAIL: HTTP blocked even though example.com is allow-listed "
              f"({type(e).__name__}: {e}) — the proxy path is broken, so the "
              f"empty-list run proves nothing"); rc = 1

# 2. DNS is documented as UNFENCED. Record it; it is not a pass/fail.
try:
    print("observed: dns example.com ->", socket.gethostbyname("example.com"))
except OSError as e:
    print(f"observed: dns failed ({type(e).__name__} winerror={getattr(e,'winerror',None)})")

# 3. THE assertion: strip every proxy hint, then connect direct to our listener.
for k in ("HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy","NO_PROXY"):
    os.environ.pop(k, None)
try:
    socket.create_connection(("127.0.0.1", PORT), 5)
    print(f"FAIL: raw TCP to 127.0.0.1:{PORT} CONNECTED — the WFP egress fence is NOT active")
    sys.exit(1)
except OSError as e:
    code = getattr(e, "winerror", None)
    if code == 10013:
        print("PASS: raw TCP blocked at connect with WSAEACCES (10013) — kernel WFP filter")
    else:
        print(f"INCONCLUSIVE: raw TCP failed with {type(e).__name__} winerror={code}. "
              f"Only 10013 proves the fence; a timeout/refusal/unreachable means the "
              f"connect never reached the filter. NOT a pass.")
        rc = max(rc, 2)
sys.exit(rc)
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_c.py

npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_c.py $PORT block"
echo "exit=$LASTEXITCODE"
```

**6.3-control — prove the HTTP leg's failure was policy, not plumbing.** A
blocked HTTP request means nothing on its own; the proxy could simply be down.
Set `allowedDomains` to `["example.com"]` and re-run:

```powershell
@'
import urllib.request
print("CONTROL PASS: http status", urllib.request.urlopen("https://example.com", timeout=20).status)
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_http.py

npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_http.py"
npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_c.py $PORT allow"
```

> Required results: HTTP now **succeeds** (proving the earlier block was the
> allow-list, not a broken proxy) **and** raw TCP is **still** blocked with
> 10013 (proving the kernel fence is independent of the allow-list). Only both
> together make step (c) a pass. Restore `allowedDomains: []` afterwards.

### 6.4 (d) Documented failure modes

**d1 — certificate revocation (schannel vs OpenSSL).** With
`allowedDomains: ["example.com"]`. The two curl runs are a differential: same
host, same config, one flag apart, so a failure that is not about revocation
would take both down and be visible as such.

```powershell
npx srt -c "C:\Windows\System32\curl.exe -sS -o NUL -w '%{http_code}' https://example.com"; "curl-plain exit=$LASTEXITCODE"
npx srt -c "C:\Windows\System32\curl.exe --ssl-no-revoke -sS -o NUL -w '%{http_code}' https://example.com"; "curl-norevoke exit=$LASTEXITCODE"
npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_http.py"; "python exit=$LASTEXITCODE"
```

> `-w` takes a **single** `%` here. `%%` is curl's own escape for a literal
> percent, so `-w %%{http_code}` makes curl print the text `%{http_code}`
> instead of the status — the doubled form is cmd/batch escaping and is wrong
> in this position. The `t_http.py` script from 6.3-control is reused rather
> than a nested `python -c`, for the quoting reason in §6.A.

**Clear the revocation cache first, or the test cannot fire.** CryptoAPI only
fetches a CRL/OCSP response on a cache **miss**, and the WFP fence only blocks
that fetch — so a host that has recently validated this chain unfenced will pass
both runs and tell you nothing. This is what happened on the first real run
(§7.3b):

```powershell
certutil -URLCache CRL delete | Out-Null
certutil -URLCache OCSP delete | Out-Null
"revocation cache cleared"
```

> Reading the result — **four** outcomes, not two:
> - plain **fails** (expect `CRYPT_E_REVOCATION_OFFLINE` / `0x80092013`, curl
>   exit 35 or 60) **and** `--ssl-no-revoke` **succeeds** ⇒ the documented
>   revocation limitation is confirmed.
> - **both** curl runs **fail** ⇒ INCONCLUSIVE, not a revocation finding —
>   something else (allow-list, proxy) is broken. Fix it and re-run.
> - **both** curl runs **succeed** ⇒ **NOT REPRODUCED on this host — which is
>   NOT evidence the limitation is absent.** This is the observed outcome
>   (§7.3b: both returned 200 on a Schannel curl). The mechanism srt documents
>   is real; it simply did not fire, most likely because cached revocation data
>   satisfied the check. Record it as "not reproduced", say whether the cache
>   was cleared first, and do **not** promote it to either "confirmed" or
>   "refuted".
> - the two disagree in the *other* direction (plain succeeds, `--ssl-no-revoke`
>   fails) ⇒ something is wrong with the invocation itself; re-check quoting.
>
> **The Python leg is the one that matters to us**, and it is independent of
> which branch above lands. Success ⇒ §1.5's "low impact" assessment holds
> (CPython uses OpenSSL, not schannel) — this is what was observed. Failure ⇒
> the assessment is **wrong** and every agent HTTP call breaks on Windows;
> record it prominently and re-open §1.5.

**d2 — per-user tool install unreachable (our packaging risk).** `$env:LOCALAPPDATA`
is expanded in the **outer PowerShell** so the fenced command receives an
absolute path; the unexpanded `%LOCALAPPDATA%` token would resolve against the
`srt-sandbox` profile inside the fence and turn this into a file-not-found test
that looks like a DACL denial.

```powershell
# A UNIQUE directory that must not already exist — `Programs\py` could be a real
# per-user Python install, and Copy-Item would merge into it (and §6.9 would
# then delete it).
$perUser = Join-Path $env:LOCALAPPDATA "Programs\bst1068-py-$([guid]::NewGuid().ToString('N').Substring(0,8))"
if (Test-Path $perUser) { throw "pick another name — $perUser exists" }
$perUserExe = Join-Path $perUser 'python.exe'
Copy-Item -Recurse C:\srt-spike\py $perUser
[void]$CREATED.Add($perUser)             # so teardown deletes only what we made
Test-Path $perUserExe    # must be True before continuing

# CONTROL — the copy runs fine as you, so a fenced failure is about identity.
& $perUserExe -c "print('CONTROL PASS: per-user interpreter runs unfenced')"

# FENCED — expect a failure, and check WHICH failure.
npx srt -c "`"$perUserExe`" -c `"print('reached')`""
"fenced exit=$LASTEXITCODE"
```

> Reading the result:
> - stderr says **access is denied** ⇒ PASS, the documented limitation is
>   confirmed and BST-1061 cannot ship CPython to a per-user directory unaided.
> - stderr says **cannot find the path/file** ⇒ **INCONCLUSIVE**, not a pass —
>   the ACL was never consulted. Re-check `Test-Path` and the quoting.
> - it prints `reached` ⇒ the limitation does not apply as documented; record it,
>   it would simplify our packaging story.
>
> Then add the **expanded absolute** `$perUser` path to `filesystem.allowRead`
> in the settings file (a literal path — srt expands globs at `initialize()`
> only, and never expands `%…%`), re-run the fenced command, and require
> `reached`. That second half is what proves the `allowRead` grant is the
> mitigation; without it the step only shows a failure, not a fix.

**d3 — `pip install --user` lands in the wrong profile.** With `allowedDomains`
covering PyPI:

```powershell
@'
import sys, requests
p = requests.__file__
print("requests at", p)
# Assert POSITIVELY that the module is rooted in the SANDBOX profile. The
# earlier form asserted a caller directory was absent, which is unreliable —
# %APPDATA%\Python already existed on the real host (§7.3f), so it could not
# establish anything.
if "srt-sandbox" in p.lower():
    print("PASS: installed into the sandbox account's profile"); sys.exit(0)
print("FAIL: not rooted in the sandbox profile — check where pip actually wrote"); sys.exit(1)
'@ | Out-File -Encoding ascii C:\srt-spike\scratch\t_req.py

npx srt -c "C:\srt-spike\py\python.exe -m pip install --user --no-input requests"
"pip exit=$LASTEXITCODE"   # must be 0, else the next line proves nothing
npx srt -c "C:\srt-spike\py\python.exe C:\srt-spike\scratch\t_req.py"
"import exit=$LASTEXITCODE"
```

> The install must succeed first; a failed install followed by a failed import
> tells you nothing. The assertion is that `requests.__file__` is rooted in the
> **sandbox** profile — a positive claim about where it went, rather than a
> negative claim about a caller directory that may well have pre-existed for
> unrelated reasons. Then record whether a scratch-scoped venv
> (`python -m venv C:\srt-spike\scratch\venv`) is a working substitute — that
> is the pattern a real agent workflow needs.

### 6.5 (e) The seam blocker, on hardware

```powershell
node --input-type=module -e @'
import {SandboxManager, VENDORED_SRT_WIN_EXE} from "@anthropic-ai/sandbox-runtime";
const base = {network:{allowedDomains:[]},
              filesystem:{allowRead:["C:\\srt-spike\\py"],allowWrite:["C:\\srt-spike\\scratch"],denyRead:[],denyWrite:[]},
              windows:{srtWin:{path: VENDORED_SRT_WIN_EXE}}};
await SandboxManager.initialize(base);
let rc = 0;
try {
  await SandboxManager.wrapWithSandboxArgv("C:\\srt-spike\\py\\python.exe -c \"pass\"", undefined, base, undefined, "C:\\srt-spike\\scratch");
  console.log("FAIL: per-exec filesystem grants did NOT throw — §1.7.1 refuted"); rc = 1;
} catch (e) {
  const m = e instanceof Error ? e.message : String(e);
  if (/Per-exec filesystem\.allowRead\/allowWrite is not supported/.test(m)) {
    console.log("PASS: threw the documented per-exec grant error");
  } else {
    console.log(`INCONCLUSIVE: threw something else — ${m}`); rc = 2;
  }
}
await SandboxManager.reset();
process.exit(rc);
'@
```

> The message is matched, not merely caught: any other throw (a bad path, a
> missing binary) would otherwise read as confirmation. A PASS means PR #2190's
> FenceExecutor, run unmodified on Windows, throws on **every** execution —
> converting §2.4 from a code reading into a measured fact.

### 6.6 (f) Cost of the only correct lifecycle

Create `C:\srt-spike\scratch\p0` … `p9` first, then:

```powershell
node --input-type=module -e @'
import {SandboxManager, VENDORED_SRT_WIN_EXE} from "@anthropic-ai/sandbox-runtime";
import fs from "node:fs";
const mk = n => ({network:{allowedDomains:[]},
  filesystem:{allowRead:["C:\\srt-spike\\py"],allowWrite:[`C:\\srt-spike\\scratch\\p${n}`],denyRead:[],denyWrite:[]},
  windows:{srtWin:{path: VENDORED_SRT_WIN_EXE}}});
for (let i=0;i<10;i++) if (!fs.existsSync(`C:\\srt-spike\\scratch\\p${i}`)) { console.log(`FAIL: p${i} missing — ACLs would be stamped on nothing`); process.exit(1); }
const t = [];
for (let i=0;i<10;i++){ const s=Date.now(); await SandboxManager.initialize(mk(i)); await SandboxManager.reset(); t.push(Date.now()-s); }
t.sort((a,b)=>a-b);
const median = t[5];
console.log("ms:", t, "median", median);
if (median < 5) { console.log("INCONCLUSIVE: implausibly fast — verify ACEs are actually being stamped/revoked (icacls the p* dirs mid-run)"); process.exit(2); }
console.log(median <= 250 ? "RESULT: per-exec policy is affordable" : median >= 1500 ? "RESULT: per-exec policy is NOT affordable — needs a per-workspace session model" : "RESULT: middle ground — judgement call, report the number");
'@
```

> The directories are checked first because stamping ACEs onto paths that do not
> exist would be fast *and* meaningless. The first iteration includes the
> once-per-process `verifyWindowsWfpEgress` logon and will be an outlier, hence
> the median. Sanity-check with `icacls C:\srt-spike\scratch\p3` while a run is
> in flight: the `srt-sandbox` ACE should appear and disappear.

### 6.7 (g) Cancellation / process-tree kill — the unported piece

The seam requires this: `ExecInput.signal` is mandatory and
`docs/agents/code-execution.md` states backends MUST terminate the process tree
when it fires. So this is a contract requirement on a Windows fence, not a
nicety.

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

Run under `npx srt -c …`. Then, **before killing anything**, confirm the log is
actually growing — otherwise "it stopped" is vacuous because it never started:

```powershell
Remove-Item C:\srt-spike\scratch\grandchild.log -ErrorAction SilentlyContinue
# ... start the fenced run in another terminal ...
$a = (Get-Item C:\srt-spike\scratch\grandchild.log).Length; Start-Sleep 2
$b = (Get-Item C:\srt-spike\scratch\grandchild.log).Length
if ($b -le $a) { "INCONCLUSIVE: grandchild is not writing — the kill test proves nothing"; }
else { "control ok: log growing ($a -> $b)" }
```

Now kill the broker (Ctrl-C, and separately `Stop-Process` on the direct child)
and re-measure over 5 s.

> Expected: **UNKNOWN — that is the point of the test.** srt-win places the child
> in a job object (§1.2), which *should* take the tree down when the job handle
> closes; PR #2190's `process.kill(-pid)` definitely will not, since POSIX
> process groups do not exist on Windows. PASS = the log stops growing within
> 2 s of the kill. If it keeps growing, cancellation needs a Windows-specific
> implementation — and it should extend the existing `packages/windows-job-native`
> addon (already built and tested in CI, currently dev-tooling-only) rather than
> add a third kill path.

### 6.8 (h) Which `realpath` binding de-aliases Windows paths — if either?

**Round one refuted the premise (§7.3a) and, in doing so, exposed that the test
asked the wrong API.** `fs.realpathSync` is Node's **JavaScript** resolver: it
follows symlinks but copies non-symlink components verbatim from the input, so
it can never expand a short name or restore case. Only `fs.realpathSync.native`
reaches libuv / `GetFinalPathNameByHandleW`.

So this now tests **both bindings** against **both** alias forms. Note what it
deliberately does not assume: that `.native` fixing case on darwin (which
BST-1074 measured) implies it expands 8.3 short names on NTFS. Those are
different Win32 behaviours, and inferring the second from the first is the same
shortcut that produced the original wrong premise.

No fence and no install needed — run it first, it takes seconds.

```powershell
mkdir "C:\srt-spike\Program Files Test" -ErrorAction SilentlyContinue
node -e @'
const fs = require("node:fs");
const cp = require("node:child_process");
const long = "C:\\srt-spike\\Program Files Test";
let rc = 0;

const short = cp.execSync(`cmd /c for %I in ("${long}") do @echo %~sI`).toString().trim();
console.log("8.3 alias:", short || "(none)");

for (const [name, fn] of Object.entries({ js: fs.realpathSync, native: fs.realpathSync.native })) {
  if (short && short.toLowerCase() !== long.toLowerCase()) {
    let r; try { r = fn(short); } catch (e) { r = `<threw ${e.code}>`; }
    const ok = r === long;                       // exact spelling, never folded
    console.log(`${name}: realpath(8.3)  -> ${r}  ${ok ? "PASS expands" : "FAIL does NOT expand"}`);
    if (!ok) rc = Math.max(rc, 1);
  } else {
    console.log(`${name}: 8.3 alias unavailable — INCONCLUSIVE for short names`);
    rc = Math.max(rc, 2);
  }
  let r2; try { r2 = fn(long.toUpperCase()); } catch (e) { r2 = `<threw ${e.code}>`; }
  const ok2 = r2 === long;
  console.log(`${name}: realpath(UPPER) -> ${r2}  ${ok2 ? "PASS restores case" : "FAIL keeps input case"}`);
  if (!ok2) rc = Math.max(rc, 1);
}
process.exit(rc);
'@

fsutil 8dot3name query C:
fsutil file queryCaseSensitiveInfo C:\srt-spike
```

> Comparison is **exact-spelling** on purpose: the question is whether the
> resolver returns the canonical on-disk form, and a case-insensitive compare
> would paper over precisely the failure being measured.
>
> Reading the result:
> - **`native` passes both** ⇒ the seam's `realpath.native` default (BST-1074)
>   is sufficient on Windows too, and §1.9b's volume-only fold is safe. Record
>   it and close gate item 5.
> - **`native` expands short names but not case, or vice versa** ⇒ partial; a
>   Windows backend still needs an explicit canonicalizer for the other half.
> - **`native` fails both** (as `js` already did) ⇒ gate item 5 stands in full:
>   `GetFinalPathNameByHandleW` / `GetLongPathNameW`, or file-identity
>   comparison, each with its own test.
> - **`INCONCLUSIVE` on short names** is a real outcome — many volumes have 8.3
>   generation disabled, which `fsutil 8dot3name query C:` reports. Record it as
>   untested rather than as a pass; the containment question is unanswered
>   either way.
>
> `fsutil file queryCaseSensitiveInfo` is worth capturing too: if per-directory
> case sensitivity is enabled anywhere on the volume, §1.9b's false-PERMIT
> concern is reachable in practice rather than theoretical.

### 6.9 Teardown

Run in the **same session** as §6.0, so `$CREATED`, `$SETTINGS`, and `$BACKUP`
are still set. Order matters: the account and filters come out **before** any
local state, and nothing is deleted unless uninstall actually succeeded.

```powershell
$ErrorActionPreference = 'Stop'

# 1. Uninstall FIRST, and verify. A cancelled UAC prompt exits without removing
#    anything, and deleting state.db then would strand a provisioned account and
#    live WFP filters with no credential store — worse than not cleaning up.
npx @anthropic-ai/sandbox-runtime windows-uninstall
if ($LASTEXITCODE -ne 0) { throw "windows-uninstall exited $LASTEXITCODE — STOP. Do not delete local state; re-run uninstall (accept the UAC prompt) first." }

node --input-type=module -e @'
import {checkWindowsSandboxStatusAsync,resolveSrtWin,VENDORED_SRT_WIN_EXE} from "@anthropic-ai/sandbox-runtime";
const s = await checkWindowsSandboxStatusAsync({srtWin: resolveSrtWin({path: VENDORED_SRT_WIN_EXE})});
console.log("post-uninstall provisioned =", s.user.provisioned);
process.exit(s.user.provisioned ? 1 : 0);
'@
if ($LASTEXITCODE -ne 0) { throw "sandbox user still provisioned — STOP, do not delete state.db." }

# 2. Only now is srt's own state safe to remove (uninstall leaves state.db).
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\sandbox-runtime" -ErrorAction SilentlyContinue

# 3. Delete ONLY the paths §6.0/d2 recorded creating.
foreach ($p in $CREATED) { if (Test-Path $p) { "removing $p"; Remove-Item -Recurse -Force $p } }

# 4. Restore the caller's settings file rather than deleting it.
if (Test-Path $BACKUP) { Move-Item -Force $BACKUP $SETTINGS; "restored $SETTINGS" }
elseif (Test-Path $SETTINGS) { Remove-Item $SETTINGS; "removed the settings file this run created" }
```

> The `provisioned: false` check is the *desired* outcome here — it confirms
> removal. It is asserted rather than eyeballed precisely because
> `windows-uninstall` treats a dismissed UAC prompt as a user choice, not an
> error (§1.2), so "it printed something and exited" is not evidence.
> If an unclean run left ACEs behind, `srt-win acl recover` sweeps by trustee
> SID (§1.4); spot-check with `icacls C:\srt-spike` before step 3.
>
> **If the session was lost**, do not run this block — `$CREATED` would be empty
> and `$BACKUP` unknown. Uninstall, then delete each path by hand after checking
> what is in it.

### 6.10 Reporting back

Paste the recorded output into this doc under a new `## 7. Windows run <date>`
section — every step as PASS / FAIL / INCONCLUSIVE with its exit code, and the
CONTROL result alongside each. **Report INCONCLUSIVE as INCONCLUSIVE**; a step
whose control did not pass has produced no evidence, and writing it up as a pass
is the specific failure this section is built to prevent.

Three results change the recommendation:

| Step | If it comes back… | Consequence |
| --- | --- | --- |
| 6.4/d1 Python leg | fails | §1.5 is wrong — every agent HTTP call breaks on Windows, not just schannel tools |
| 6.6 median | ≥ ~1500 ms | per-exec policy is unaffordable; the Windows fence needs a per-workspace session model, or the seam needs a policy-epoch concept |
| 6.3 raw TCP | connects, or is anything other than WSAEACCES 10013 | the fence is not what srt documents (or was not proven) — §1.3 must be re-opened before anything ships |

---

## 7. Windows run — 2026-08-01 (real hardware)

**Host:** Windows 11 x64, provisioned via `windows-install`, Node 24.14.0,
CPython 3.10.10, `curl 8.21.0` (Schannel), srt 0.0.67.
**Run by:** a human reviewer on #2191, not by the author of §1–§6.

This section is authoritative over §1–§5 wherever they disagree.

### 7.1 What the fence proved

| Assertion | Result | Evidence |
| --- | --- | --- |
| Fenced Python runs as the sandbox account | **PASS** | CPython 3.10.10 executed under the fence; `pip` and imports resolved against `C:\Users\srt-sandbox\...` |
| Write into the caller's profile is denied | **PASS** | denial observed, with the control proving the same absolute path writable unfenced (shape correction in §7.3/e) |
| **Raw TCP blocked at the kernel after stripping every proxy env var** | **PASS** | `WSAEACCES (10013)` — the decisive assertion of the whole plan |
| HTTP succeeds once the domain is allow-listed | **PASS** | proves the empty-allow-list block was policy, not a dead proxy |
| `pip install --user` writes to the SANDBOX profile, not the caller's | **PASS** | `requests.__file__` resolved under `C:\Users\srt-sandbox\AppData\Roaming\Python\…` |

**§1.3 (WFP kernel egress fence) is now CONFIRMED ON HARDWARE, not just from
srt's docs.** A process that strips `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and
connects direct to a loopback listener outside the permit range is refused at
`connect()` with `WSAEACCES`. That is the single most important thing this run
establishes, and it holds.

**§1.6 (per-user installs unreachable / wrong profile) is CONFIRMED**, via the
`pip --user` result: packages installed inside the fence are invisible to the
caller. The scratch-scoped venv remains the pattern a real agent workflow needs.

### 7.2 The decision-changing result: per-exec policy is NOT affordable

Ten real `initialize()` / `reset()` cycles over pre-existing `p0`…`p9`:

```
[1531, 1535, 1538, 1548, 1551, 1559, 1570, 1607, 1642, 1689] ms   median 1559 ms
```

§6.6 set the threshold in advance: `≥ ~1500 ms` ⇒ **"per-exec policy is NOT
affordable — needs a per-workspace session model."** 1559 ms clears it, and not
marginally: the *fastest* of ten cycles (1531 ms) is already over the line, so
this is not a tail-latency artefact. The distribution is tight (1531–1689),
which is what a real fixed cost looks like rather than noise.

What it means concretely: on Windows, the only lifecycle that applies filesystem
policy **correctly** (§2.4 — `reset()` then `initialize()`, because
`updateConfig()` warns and keeps the previous access set) costs ~1.6 s **per
policy change**. Under this seam's contract, where `ExecPolicy` is a property of
every `ExecInput`, that is ~1.6 s of pure setup on every `run_python` call
before any user code executes. Against the project's standing "latency-critical
paths" constraint, that is not a tuning problem; it is a design verdict.

**Consequence, carried through:** a Windows fence cannot honour per-execution
policy. It needs a **per-workspace session model** — policy fixed for the
lifetime of a workspace session, with a typed refusal when a request's policy
differs from the session's — or the seam needs an explicit **policy-epoch**
concept that makes "this executor changes policy only at epoch boundaries" a
first-class, advertisable property rather than an invisible difference. Either
is a design change, not a platform-flag flip. This is now the second independent
reason the gate holds (§2.6).

### 7.3 Where the run contradicted this document

**a. §1.9a premise REFUTED — `fs.realpath` does not canonicalize on Windows.**
`cmd` produced the 8.3 alias `C:\SRT-SP~1\PROGRA~1`; `fs.realpathSync(short)`
returned **that same short spelling**, and `fs.realpathSync(long.toUpperCase())`
returned **the uppercase input**. So neither short-name expansion nor case
restoration happened. §1.9a is corrected in place — the cause is that
`fs.realpath` is Node's **JS** implementation, which resolves symlinks but
copies non-symlink components verbatim from the input; only
`fs.realpath.native` reaches libuv's `GetFinalPathNameByHandleW`. The §6.8 test
asked the wrong binding. This is the same gap BST-1074 found and fixed for the
fence (it switched `fence-policy`'s default resolver to `realpath.native` after
measuring, on darwin, that JS returns `mixedcase` where native returns
`MixedCase`).

**§6.8 has been rewritten to test BOTH bindings**, because `.native` fixing
*case* on darwin does not establish that it expands *8.3 short names* on
Windows — a different Win32 behaviour, and precisely the kind of assumption
that produced this finding in the first place. Until that is measured, a
Windows backend must canonicalize explicitly (`GetFinalPathNameByHandleW` /
`GetLongPathNameW`, or a file-identity comparison via
`FILE_ID_INFO`/`BY_HANDLE_FILE_INFORMATION`) and **verify** it before comparing
coverage. Recorded as a hard prerequisite in §5.

**b. §1.5 cert revocation NOT reproduced.** Both the plain and
`--ssl-no-revoke` fenced curl requests returned **HTTP 200, exit 0**, on a curl
that is genuinely Schannel-backed (`curl 8.21.0 … Schannel`). The CPython leg
also returned 200.

Reading this honestly: **this is neither a confirmation nor a refutation.** srt
documents the limitation (§1.5 cites it) and the mechanism is real, but it did
not fire here. The most likely explanation is that CryptoAPI had **valid cached
revocation data** for that chain — the CRL/OCSP fetch the WFP fence blocks only
happens on a cache miss, and any prior unfenced browse to that host populates
it. `certutil -URLCache CRL delete` before the run would make the test
decisive; §6.4/d1 now says so and carries a third "both succeed" branch.

**What this run DID establish for our purposes is the part that mattered:** the
CPython/OpenSSL leg returned 200, so **§1.5's "low impact on agent Python"
assessment is supported by observation**, independent of whether the schannel
limitation reproduces. That was the decisive question; the schannel behaviour is
context for tools we do not ship.

**c. The §6.2 fixture was insecurely permissioned — and the finding is about
the product, not just the test.** `C:\srt-spike`, created directly under the
host's default `C:\` ACL, inherited `Authenticated Users:(OI)(CI)(M)`. Because
srt **only adds** grants and never removes existing ACEs, `srt-sandbox` — an
authenticated user — could write `C:\srt-spike\py\srt-escape.txt` even though
`py` appeared **only in `allowRead`**. The documented run exited 1.

That is the DACL model working exactly as §1.4 describes, so it is not a fence
failure. But it is the concrete, measured instance of §1.4's abstract warning,
and it is sharp enough to state as a product-level rule:

> **On Windows, `filesystem.allowRead` does not mean read-only.** It means "add
> a read ACE for the sandbox SID." If the path's existing ACL already grants
> write to a group the sandbox account belongs to (`Authenticated Users`,
> `Users`, `Everyone` — true by default for anything created off the `C:\`
> root), the sandboxed process can still write there. On macOS Seatbelt and
> Linux bubblewrap the same `ExecPolicy` genuinely constrains.

This is a **third** expressibility gap (§2.6): the identical `ExecPolicy`
produces materially weaker isolation on Windows, and nothing in
`ExecutorCapabilities` can say so. §6.2 now builds its fixture under a
caller-private ACL and **preflights that the sandbox account cannot write it**
before treating the `allowRead` assertion as meaningful.

**d. A control was reused as an assertion — one survived the §6.A sweep.**
`t_c.py` unconditionally treated successful HTTP as `FAIL`, but §6.3-control
reruns that same script *after* allow-listing `example.com`, where HTTP success
is the required outcome. The live run did exactly the wrong thing: HTTP
succeeded, raw TCP was still correctly blocked with `WSAEACCES`, and the command
still exited 1 printing `FAIL: HTTP reached example.com under allowedDomains:
[]`. The script is now parameterized (`t_c.py <PORT> <block|allow>`) so the
paired control can pass. Noted plainly because §6.A exists to catch exactly
this and did not.

**e. CPython's access-denied shape is `PermissionError errno=13 winerror=None`.**
§6.2 required `winerror == 5`, so a genuine, control-backed denial was reported
`INCONCLUSIVE`. Corrected to branch on the exception **class** — `PermissionError`
(errno `EACCES`) is denied, `FileNotFoundError` is the inconclusive
missing-parent case — which preserves the discrimination that mattered without
depending on a `winerror` CPython does not always populate.

**f. `%APPDATA%\Python` already existed**, so §6.4/d3's `expect False`
precondition could not establish where `pip --user` wrote. Replaced with the
assertion the run showed to be reliable: `requests.__file__` must be rooted in
the **sandbox** profile.

### 7.4 What the run did NOT cover

- **§6.5 (the per-exec `filesystem.allowRead/allowWrite` throw) was not
  reported.** The expressibility argument's *correctness* leg therefore still
  rests on reading `sandbox-manager.js`, not on observation — though §7.2's
  affordability result now carries the recommendation on its own.
- **§6.7 (process-tree kill / job-object behaviour) was not reported.** Whether
  srt-win's job object takes a grandchild down remains open, and `ExecInput`'s
  required `signal` makes it a contract obligation for any Windows backend.
- **§6.8 as re-written** (both `realpath` bindings, short name *and* case) has
  not been run; only the original single-binding version was.
