# Hook run-verdict protocol — evidence

Supports `docs/agents/assistant-runtime.md` § "TOOL-LIFECYCLE HOOKS (Claude-Code-style)".
Read before changing `hooks/run-verdict.ts`, the `assistant_message` stdin tail, or run-outcome precedence. BST-1251.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4014-4059), extracted verbatim.

**Run-verdict protocol (Task Ledger source 'hook').** A **Stop** hook (e.g. one
that runs the test suite after the agent finishes) may label the run's outcome
by printing ONE JSON line to stdout:
`{"brainstrikeRunVerdict":{"verdict":"succeeded"|"failed"|"mixed","detail":"…"}}`.
Rules (`hooks/run-verdict.ts`, strict — hook stdout is UNTRUSTED repo data):
- **Stop-only by construction**: `captureRunVerdict` is set solely by
  `HookManager.runStop` — a Pre/PostToolUse hook printing the line is ignored
  (a post-tool hook on the last tool is NOT run-completion semantics).
- **`assistant_message` stdin (BST-1251)**: `withStopHook` accumulates the
  RUN's assistant text — every generation step's `text-delta` chunks, with a
  `\n` inserted at step boundaries (any non-text chunk) so line-anchored
  graders never see step N's tail glued onto step N+1 — and hands Stop hooks
  a 64 KiB TAIL (`ASSISTANT_MESSAGE_TAIL_CHARS`; an acceptance hook grades
  the END of the final answer). The trim is amortized (only past 2× the
  bound; exact tail cut once at Stop), omitted entirely when the stream
  produced no text, and never grows unbounded with the stream.
- **Bounded scan**: only the trailing `RUN_VERDICT_STDOUT_SCAN_CHARS` (64 KiB)
  of raw stdout are scanned; a window that slices mid-line drops the partial
  first line. Candidate lines = lines containing the marker key. The LAST valid
  line wins within a hook, and the LAST hook with a valid verdict wins across
  the phase (mirrors the ledger's later-write-upserts rule).
- **Strict or ignored, never coerced**: malformed JSON, unknown verdict values,
  a non-string/oversized `detail` (> 2000 chars — the repository bound), or any
  extra key ⇒ that line is ignored with a CONTENT-FREE warning (no stdout
  excerpt leaks into logs/run events) surfaced as a `hook.notice` via
  `surfaceOutcome`. A bad line never fails the hook flow or the run. This scan
  is separate from the decision protocol (`{decision, reason,
  additionalContext}` parses the WHOLE trimmed stdout as one JSON object).
- **Persistence (main-process, path A)**: `withStopHook` awaits the threaded
  `onRunVerdict` IN FRONT of the `message-finish` yield, so the label lands
  before the post-stream `thread_runs` status write — a finishing run cannot
  lose it to teardown. `recordDesktopAssistantHookRunOutcome`
  (assistant-server/run-persistence.ts) upserts `brainstrike_assistant_run_outcomes` via the
  desktop DB handle, deriving thread/resource ids from the runs row (mirrors
  the run-event insert); a missing runs row THROWS (never a silent no-op).
  The upsert is byte-consistent with the app-shell repository's
  `recordRunOutcome` (documented duplication, like the bootstrap-SQL precedent)
  PLUS the SQL precedence guard `source <> 'user'`: a hook label NEVER
  overwrites an explicit user verdict (skip, logged), while a later user
  verdict still replaces a hook label; the repository applies the SAME guard
  for `source: 'hook'` writes. Allow-on-fault: a failed verdict write is a
  loudly logged lost label, never a lost finish. No runId ⇒ no recorder is
  threaded (hooks still run). See assistant-persistence.md § TASK LEDGER.

**Run-event kinds:** `hook.blocked`, `hook.notice` (in `ASSISTANT_RUN_EVENT_KINDS`).

