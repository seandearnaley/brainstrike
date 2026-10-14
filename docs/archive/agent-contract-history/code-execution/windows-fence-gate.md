# Why Windows is gated off, measured on real hardware — evidence

Supports `docs/agents/code-execution.md` § "FenceExecutor". Read this before
enabling the fence on Windows, or before "simplifying" the explicit
`darwin || linux` allow-list in `isFenceSupported()`. The contract holds the
rules; this file is the record of why.

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
    `docs/archive/agent-contract-history/research/bst-1068-srt-windows-fence-spike.md`.
