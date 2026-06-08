# Assistant Context-Tool Enhancements — Design

**Date:** 2026-06-06
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/assistant-context-tools`

## Goal

Make it easier and cheaper for the assistant to curate precise context, based on
learnings from live validation of the assistant-hardening work:

1. **Agent-settable tapestry range colors** (named palette) so the agent can
   visually group related context in the Context Explorer.
2. **A symbol/range lookup tool** so the agent can get a symbol's exact line
   range *without* reading the whole file into its context window — directly
   addressing the friction that made the model fall back to whole-file selection
   and mis-state line ranges.

## Background / why

During live validation:

- The model selected whole files because deriving a symbol's precise line range
  required reading the file and counting lines. `readWorkspaceFile` returns a raw
  content slice **without inline line numbers**, so the model could not reliably
  map a symbol to a 1-based range (it produced off-by-one ranges or gave up and
  selected the whole file while falsely claiming a precise range).
- Tapestry ranges already carry a `color` (hex) in the data model
  (`TapestryRange.color`), but it is auto-assigned (`generateColor(index)` /
  `getAssistantTapestryColor(key)`); there is no way for the agent to choose it.
- Tree-sitter grammars exist in the repo but only run inside the renderer
  chunking worker, not the main-process assistant-server tool path — so an
  AST-exact symbol tool would require heavy new wiring. A pure-text approach is
  preferred for this round.

Out of scope for this round (explicitly deferred): file-discovery glob/pagination
for `readWorkspaceDirectory`, line-numbered `readWorkspaceFile` reads, richer
tool-card debug info, and AST-exact symbol ranges via tree-sitter.

---

## Component 1 — Agent-settable tapestry range colors

### Tool API

Extend the per-range object in `updateWorkspaceTapestrySelections` with an
optional `color`, typed as a **zod enum of named colors** that map to the
existing 8-color theme palette plus `gray`:

| name   | hex       |
|--------|-----------|
| red    | `#ef4444` |
| orange | `#f97316` |
| yellow | `#eab308` |
| green  | `#22c55e` |
| cyan   | `#06b6d4` |
| blue   | `#3b82f6` |
| purple | `#a855f7` |
| pink   | `#ec4899` |
| gray   | `#6b7280` |

- Omitting `color` keeps today's auto-assignment behavior.
- An invalid color name is a **zod validation error** (no silent fallback,
  per project rules).

Source-of-truth split (to keep colors consistent with the existing palette):
- The **`ColorName` zod enum** (just the names) lives with the tool schema in
  `packages/agent/src/tools/schemas.ts` — the agent package only needs the names
  to validate input.
- The **name→hex map** is co-located with the existing `COLORS` palette in
  `packages/file-explorer-ui/src/tapestry/utils.ts` (so the agent palette and the
  auto-assigned palette stay visually consistent) and is consumed by
  `buildAssistantTapestryRange`. A unit test asserts every `ColorName` has a hex
  mapping, so the two never drift.

### Data flow

```
updateWorkspaceTapestrySelections input
  range.color: ColorName?              (apps/desktop/src/assistant-server/assistant-tools.ts + schema)
    → AssistantWorkspaceTapestryRangePayload.color?: ColorName     (packages/types/src/electron-api.ts)
      → preload bridge (unchanged shape, carries color)
        → handleTapestryUpdate (packages/app-shell/src/assistant-ui-panel-wrapper.tsx)
          → buildAssistantTapestryRange({ ..., color })            (assistant-ui-panel-wrapper-runtime.ts)
            → TapestryRange.color = mapNamedColorToHex(color) ?? getAssistantTapestryColor(key)
```

`buildAssistantTapestryRange` gains an optional `color?: ColorName`; when present
it resolves to hex via the shared map, otherwise it uses the existing
deterministic fallback. No renderer rendering changes are needed — the minimap
already renders `range.color`.

### Schema location

The tapestry tool input schema (`UpdateWorkspaceTapestrySelectionsInputSchema`)
is in `packages/agent/src/tools/schemas.ts`. Add `color: ColorNameSchema.optional()`
to the range object. Mirror the optional `color` on the runtime metadata types
used by `runUpdateWorkspaceTapestrySelections` so it flows into the broadcast
payload.

---

## Component 2 — Symbol/range lookup tool (`brainstrike.findWorkspaceSymbol`)

A new, single-purpose native tool that returns a symbol's enclosing line range
(and a tiny preview) without returning whole-file content.

### Tool API

- **id:** `brainstrike.findWorkspaceSymbol`
- **Input** (zod, `.strict()`):
  - `path: string` — workspace-relative file path (required).
  - `query: string` — symbol name or substring to find (required, min length 1).
  - `maxMatches?: number` — default 5, max 20.
  - `contextLines?: number` — default 2, max 10 (preview lines before/after the
    declaration line).
- **Output:**
  ```ts
  {
    path: string;            // normalized "/"-rooted workspace path
    totalMatches: number;    // matches found (before maxMatches cap)
    truncated: boolean;      // totalMatches > returned matches
    matches: Array<{
      startLine: number;     // 1-based, inclusive — best-effort enclosing block start
      endLine: number;       // 1-based, inclusive — best-effort enclosing block end
      declarationLine: number; // 1-based line where the query matched
      name: string;          // trimmed text of the declaration line
      preview: string;       // small numbered snippet around the declaration
    }>;
  }
  ```

### Range heuristic (best-effort, language-agnostic)

From the declaration line, compute the enclosing block end:

1. **Brace languages** (line contains `{` at/after the match, or the next
   non-blank line opens `{`): scan forward tracking `{`/`}` depth (ignoring braces
   inside line/`//` and `/* */` comments and string literals via a light scanner)
   until depth returns to 0 → that line is `endLine`.
2. **Indent fallback** (no brace block, e.g. Python): `endLine` = the last line
   before indentation returns to ≤ the declaration line's indent.
3. **No block** (e.g. a single-line const): `endLine = declarationLine`.

The range is documented to the model as **best-effort**; it may pass it directly
or refine it. Output is bounded by `maxMatches` and a per-match preview cap, and
`truncated` is reported.

### Reuse / safety

- Resolve + containment-check the path via the existing
  `resolveWorkspaceAbsolutePath` (symlink + escape guard).
- File-not-found / path-escape errors propagate and now surface gracefully via
  the Bug A provider-error termination (visible message, no hang).
- "No matches" returns `{ matches: [], totalMatches: 0, truncated: false }` —
  not an error.

### Registration

Register the tool in the desktop assistant tool set
(`buildDesktopAssistantTools`) and add its model-facing name to
`buildDefaultInstructions` tool-name resolution, consistent with the other
`brainstrike.*` tools. The tool is read-only (no confirmation gate).

---

## Cross-cutting — prompt guidance

Extend `buildDefaultInstructions` (`packages/agent/src/mastra/default-instructions.ts`):

- When the user names a symbol/function/type, **use `findWorkspaceSymbol` to get
  its exact range** instead of reading the whole file, then pass that range to
  `updateWorkspaceTapestrySelections`.
- The agent may set a `color` per range (from the named palette) to **group
  related context** — e.g., all DB-schema ranges blue, all API handlers green —
  and should reuse the same color for the same concept.

These additions are gated on the respective tools being registered (same pattern
as existing guidance), so the prompt degrades gracefully when a tool is absent.

---

## Testing

Pure/unit (fast, no temp dir):
- Named color map: every enum member resolves to the expected hex; invalid name
  rejected by the schema.
- `buildAssistantTapestryRange`: uses the provided color when present; falls back
  to the deterministic color when omitted.
- Block-range heuristic: TS/JS brace block (multi-line function), nested braces,
  braces in strings/comments are ignored, single-line const (`endLine ===
  declarationLine`), and a Python-style indent block.

Integration (temp-dir fixture, mirroring `assistant-tools.test.ts`):
- `findWorkspaceSymbol` returns correct `startLine`/`endLine`/`declarationLine`
  for a known function; respects `maxMatches`/`contextLines`; reports `truncated`;
  returns empty for no match; rejects path escapes.

Prompt:
- `default-instructions.spec.ts`: asserts the new `findWorkspaceSymbol` and
  color-grouping guidance appears when the tools are registered and is absent
  when they are not.

Data-flow:
- A test that a `color` on a tapestry tool input reaches
  `AssistantWorkspaceTapestryRangePayload.color` and that
  `buildAssistantTapestryRange` maps it to the expected hex.

Live (manual, after implementation): in the running desktop app, ask the
assistant to "select the X function and color it blue" and confirm a precise,
blue range appears in the Context Explorer.

All work must pass the full gate together (build + lint + type-check + unit) per
AGENTS.md.

---

## Files (anticipated)

Create:
- `apps/desktop/src/assistant-server/find-workspace-symbol.ts` — the symbol
  lookup + block-range heuristic (pure functions + the tool runner), with tests.
- `apps/desktop/src/__tests__/assistant-server/find-workspace-symbol.test.ts`.

Modify:
- `packages/agent/src/tools/schemas.ts` — add the `ColorName` zod enum + `color`
  on the tapestry range; add `FindWorkspaceSymbolInputSchema`.
- `packages/file-explorer-ui/src/tapestry/utils.ts` — add the `ColorName`→hex map
  next to `COLORS`.
- `apps/desktop/src/assistant-server/assistant-tools.ts` — register
  `findWorkspaceSymbol`; thread `color` through `runUpdateWorkspaceTapestrySelections`.
- `packages/types/src/electron-api.ts` — add `color?` to
  `AssistantWorkspaceTapestryRangePayload`.
- `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` +
  `assistant-ui-panel-wrapper-runtime.ts` — thread `color` into
  `buildAssistantTapestryRange`.
- `packages/agent/src/mastra/default-instructions.ts` (+ its spec) — prompt
  guidance.
- Tool-name registries/maps as needed for the new tool id.

## Open questions

None — design approved.
