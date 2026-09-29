# Packaged MCP lanes — evidence

Supports `docs/agents/ci-quality.md` § "Desktop Electron provisioning" — the
packaged MCP core / Apps bridge / Tasks / Apps lanes that run inside the
`Native Electron Package` job (BST-1602 for the core lane's approval proof).
Read this before reordering those steps, changing a packaged lane, or debugging
a core-lane approval-proof failure. The contract holds the rules; this file is
the record of why.

That job also owns the packaged MCP core lifecycle proof. The spec carries both
`@packaged` and `@destructive`, and desktop's generic full-regression lane
grep-inverts `@packaged`; an unpackaged regression run must never discover it.
The dependency build includes `@brainstrike/mcp-test-lab`, then the job packages
the desktop once, runs the packaged native-addon checks, and invokes
`test:e2e:lane:packaged-mcp-core` against that existing artifact. The canonical
lane does not build or package. The same job runs
`test:e2e:lane:packaged-mcp-apps-bridge` (`mcp-apps-bridge.desktop.test.ts`,
tagged `@packaged @destructive`, excluded from the generic full-regression
lane) right after packaging; `scripts/__tests__/mcp-apps-bridge-packaged-ci-contract.test.mjs`
pins the step order and the lane script. The same job packages with
`VITE_MCP_TASK_HARNESS=1` so the E2E-only MCP Tasks harness chunk exists in
THAT package (release packaging never sets it), then runs
`test:e2e:lane:packaged-mcp-tasks` right after packaging (the core lane keeps
its pinned slot immediately after the packaged native checks) (`mcp-task-restart.packaged.desktop.test.ts`,
tagged `@packaged @destructive`, excluded from the generic full-regression lane);
`scripts/__tests__/mcp-tasks-packaged-ci-contract.test.mjs` pins the flag, the
step order, and the lane script. `test:e2e:mcp-packaged` remains the local
developer convenience that builds the lab, packages the app, and delegates to
the same lane. `scripts/__tests__/e2e-lane-coverage.test.mjs` pins the tags,
broad-lane exclusion, canonical delegation, and workflow reachability/order.
The packaged launcher copies only an explicit cross-platform process-environment
allowlist plus test-owned overrides; it never forwards the ambient CI environment.
Its stdio fixtures enforce the exact SDK-default key set expected from that
allowlist, so the packaged proof has no production-environment bypass.

THE CORE LANE'S APPROVAL PROOF AND ITS ERROR PATH (BST-1602). Under the `ask`
MCP policy the proof races two locators — `assistant-tool-approval-notice` and
the scripted completion text — because an approval pause and a final text are
mutually exclusive outcomes of one turn (`agent-streaming`'s pause is terminal
for its leg; see `docs/agents/assistant-runtime.md`). The race is the right
observation; what was wrong was what it did when the WRONG racer won. Two rules
now hold, and both are load-bearing:

- The diagnostic branch never CLICKS. It previously reached for a page-wide
  `getByRole('button', { name: 'Expand details' })` while several tool cards were
  mounted, so the branch that exists to explain a failure produced a
  `locator.click` timeout instead of its own message — and the stalled app then
  failed `closePackagedDesktop` with `code=1` (main's 5 s
  `SIGNAL_SHUTDOWN_TIMEOUT_MS` forced exit), burying the real cause under two
  unrelated errors. A failing proof's error path must resolve immediately: it
  reads text, it does not act.
- Both racers are explicitly `.catch`-handled. The loser keeps waiting out its
  own 45 s budget and then rejects (timeout, or "target closed"), which
  Playwright reports as a second, test-less error. `Promise.race` still settles
  on whichever promise settles first, so "neither appeared" still fails.

The branch dumps three boundaries: `startModelProviderShim`'s `transcript()`
(every decided request — `roles`, `toolResultCount`, and the turn it chose, so
the shim's pure turn accounting is never guesswork), each `tool-fallback` card's
text, and the assistant region. That dump is what distinguishes the two very
different failures that land here. A tool that RAN unprompted would be a
permission-engine defect. What actually reproduces is the other one: when
`legacy_echo` is not in the run's ACTIVE tool definitions at the moment the
model calls it, the call fails fast with a tool RESULT and never reaches the
approval gate at all, so the shim's third turn emits the completion text and
`completed` wins the race. Demonstrated by forcing a `search_tools` miss: the
dump shows `search_tools … 0 results` next to `legacy.echo … Tool execution
failed.`, with no approval notice. In the wild the same state is reachable
because per-run MCP discovery is skip-on-failure — `mcp-tool-loader.ts`'s
`fetchMcpToolsetsWithTimeout` drops the WHOLE toolset after the hard-coded 5 s
`DEFAULT_MCP_TIMEOUT_MS` and `logMcpToolsetErrors` drops a single server's, both
continuing the run, and `pickMcpDiscoveryLogMethod` demotes exactly the two
likeliest reasons (`Connection closed`, `mcp_tool_discovery_timeout`) to
`debug`, which this lane's `LOG_LEVEL=info` does not record. Waiting for the
Settings row to read `Connected` does NOT establish that precondition. Making
that degradation visible is its own change; do not widen this lane to paper
over it.

After packaging, that same `Native Electron Package` job runs
`test:e2e:lane:packaged-mcp-apps`. The tagged `@packaged` spec launches the exact
electron-builder artifact, injects its harness into the REAL main window
(production preload, default session, the production header CSP — never a
harness window on a private partition, which escapes the header stamp and hid
a `frame-src` regression), uses the official MCP Apps transport through the
packaged `brainstrike-mcp-app:` shell protocol, and verifies the production
Apps host: `blob:` frames blocked by the host CSP, shell load + handshake, the
`will-frame-navigate` fence, and a 404 shell URL after release.
`scripts/__tests__/mcp-apps-packaged-ci-contract.test.mjs` pins those
assertions. Production renderer registration remains a separate
release gate. The ordinary unpackaged full-regression lane excludes `@packaged`;
there is no second or advisory path that can make this artifact-dependent proof
appear green.
