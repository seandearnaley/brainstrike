# Desktop-only native tools — evidence

Supports `docs/agents/assistant-providers.md` § "Context-window-scaled default budgets". Canvas, diagnostics and worktree tools, and the canvas storage ceiling.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4830-4957); append rather than
rewrite.

---

Adding or renaming a native tool is one `defineNativeTool` file (listed once
in `native-tools/index.ts`) plus one entry in the desktop executor map
(`apps/desktop/src/assistant-server/native-tool-executors-*.ts`, assembled
into the exhaustive `NATIVE_TOOL_EXECUTORS` — a definition with no entry, or
an entry for no definition, is a compile error) and, when the tool needs
prompt guidance, an `instruction` hook on the definition.
`buildDesktopAssistantTools` is a fold of `DESKTOP_NATIVE_TOOL_IDS` through
that map; an entry returns `undefined` when its capability is absent for the
request (built-in local provider, no artifact reader, no skill resolver). The catalog's
inline snapshot (`native-tools.test.ts`) is the only hand-listed id set; every
other registry derives, so there is no stale, missing, or extra key to drift —
and no fallback alias or partially registered tool.

`brainstrike.manageCanvas` is desktop-only because its source of truth is the
client-local `brainstrike_canvas_versions` ledger. It is a deferred workspace
tool with an `action` discriminated union (`create`, `update`, `rewrite`,
`list`) and explicit `edit` risk (PR #2294: create/update/rewrite persist durable
state, so `read`'s plan-mode/default-allow posture would let the model write
canvases while "only planning"; its completions ride the edit-activity stream,
where `use-wrapper-rewind-wiring.ts` turns them into a Canvas panel re-query).
Web has no remote fallback. Conditional instructions advertise
the verbs only when the tool is registered. Settled ruling (2026-08-07, live
gpt-5.6 failure — do not relitigate): the union branches TOLERATE cross-action
extras among the six declared envelope keys (`action` fully determines
semantics; real models bundle fields, and rejecting them broke the feature and
burned retry tokens). Only genuinely unknown keys fail, at the strict provider
envelope.
SETTLED 2026-09-15, CREATE REQUIRES CONTENT (live-app verifier runs 6 and 7,
do not relitigate): the root created an empty titled shell "ready to receive
the report" 25 s into the turn and wrote the report behind a SECOND approval,
breaking the user's reading of card → approve → document appears. `create`
now refuses a document that `isEmptyCanvasDocument` (leading head and comments
stripped, the head ending at `</head>`, at the first non-head token — both head
tags are optional — or at end of input for a raw-text element the document
never closes; svg/canvas/img/script count as content, a template or noscript
outside an explicit `<head>` stays in the body, so its contents count, and
`style` is head content with or without a `<head>`, so a style-only document is
empty — the template/noscript bias deliberately over-accepts rather than claim
what renders) judges empty, BEFORE any DB call and at no approval cost, with
the structured
`empty_document` failure and `EMPTY_CANVAS_DOCUMENT_HINT` ("create the canvas
when the content is ready — there is nothing to prepare"). `update`/`rewrite`/
`list` are unchanged: an empty `newString` still deletes the match and a
rewrite to empty still versions, because both act on a document the user
already has.
The description and the conditional instruction both say the write IS the
deliverable and never an empty placeholder — the guard closes the literal
shell, the prose closes the stub, and the verifier measures the live model.
A settled create/update/rewrite card carries a `canvas://<canvasId>` chip
(`canvas-link-chip.tsx`, shape read by `canvas-result-model.ts`, gated on the
manageCanvas tool name in both wire forms); it goes through the assistant
link seam, where the app-shell host routes `canvas:` to
`useChangesNavigationStore.openCanvas` + the explorer route instead of
`shell.openExternal`. Paired: `canvas-document-content.test.ts`,
`manage-canvas-tool.test.ts` (refusal + unchanged update/rewrite),
`tool-descriptions.test.ts` and `default-instructions.spec.ts` (prose pins),
`canvas-link.test.ts`, `canvas-link-chip.test.tsx`,
`use-assistant-link-capabilities.test.ts`, `canvas-panel.test.tsx`.

**The canvas storage ceiling is `CANVAS_HTML_MAX_BYTES` (8 MB), and it is
counted in UTF-8 BYTES.** Two places enforce it, in different packages, from one
constant in `mastra-memory-schema.ts` beside `CANVAS_VERSIONS_TABLE`:

- the `manageCanvas` input schema bounds each incoming HTML **field**, which is
  also what puts `maxLength` in front of the model;
- `insertVersion` in the desktop canvas repository bounds what actually reaches
  the text column, and returns `too_large`. It sits at the choke point on
  purpose: `create` and `rewrite` would otherwise be bounded by the schema
  alone, and `update` composes a document larger than either field it was handed
  — a near-limit document plus an individually valid replacement, repeated.
  `applyUpdate` additionally rejects an over-ceiling composition before
  materialising it, which is an allocation guard rather than a second authority.

Both halves are load-bearing and neither is redundant. `too_large` is the one
failure a model cannot retry its way out of, so `manage-canvas-tool.ts` attaches
a hint naming the limit and telling it to shrink the replacement or start a new
canvas; the descriptions carry `(max 8 MB of UTF-8)` for the same reason, since
the emitted `maxLength` is a character count and would otherwise advertise a
ceiling about four times looser than the enforced one.

One consequence on existing data, stated because neither the schema nor the
hint implies it: a row written before this ceiling existed can sit above it —
the old `.max(8_000_000)` counted UTF-16 units and admitted well over 8 MB of
UTF-8 for BMP-heavy content. Such a row is update-locked except for an update
that brings it under the ceiling in one shot, and `rewrite` is the deterministic
way out, which is why the hint names it. `manage-canvas-tool.ts`
has no size enforcement of its own, so unlike the workspace-file content fields
— which sit above an authoritative ~2 MB byte cap in the desktop tool and
therefore use `.max()` only as a loose outer guard — canvas has nothing
underneath these two checks.

`.max()` alone is not a byte bound: Zod counts code points (4.5; UTF-16 code
units before that), so `.max(8_000_000)` admits eight million astral characters,
31 MB of UTF-8. The `minLength` on `oldString` is applied to the string BEFORE
the byte refinement, because a refinement is not representable in JSON Schema
and expressing it as one silently drops `minLength: 1` from what the model is
told. Paired tests: `canvas-html-byte-ceiling.test.ts` (field) and
`canvas-repository.test.ts` (composed). Both use astral input deliberately —
an ASCII case passes with or without the enforcement.

`brainstrike.queryDiagnostics` is a desktop-only, explicit `read`-risk native
tool over `brainstrike_diagnostic_events`. Its `mode` is required:
`events` returns newest matching rows and `fingerprints` groups recurring
failures with count/first-seen/last-seen plus the latest representative
metadata. Both modes accept exact severity/fingerprint/run/thread filters and
inclusive ISO-8601 `since`/`until` bounds. The schema hard-caps `limit` at 200;
the repository applies the same bound, and the producer additionally
self-bounds through `fitItemsToCharBudget`. Hitting either cap is reported in
`truncated` plus an actionable `hint` — never presented as a complete result.
Web omits the tool because its assistant server has no capability to read the
client-local PGlite database; there is no remote fallback.

`brainstrike.listWorktrees` and `brainstrike.manageWorktree` (BST-1392) are
desktop-only for the same reason as `manageCanvas`: their source of truth —
the git worktree inventory and the `brainstrike_worktrees` ledger — lives on
the client, and web's assistant server has no bridge to either. Spec §6.4
named three tool names (`createWorktree`, `listWorktrees`, `archiveWorktree`);
they collapsed to two ids on the risk split, not on merged capability:
`listWorktrees` is deliberately `read`-risk with no approval, so plan-mode
orientation (an agent listing worktrees before proposing a plan) still works
without interrupting the user, while `manageWorktree` is `execute`-risk with
`requiresApproval: true` and an `action: 'create' | 'archive'` discriminated
union — every mutation still gates through the permission engine exactly as
three separate ids would have, since `create`/`archive` are the only actions
that write. Both tools share ONE `workspace` discovery namespace entry (the
same namespace `manageCanvas`/`manageTaskList` register under), not two,
because they operate on the same client-local capability surface a model
should discover together.
