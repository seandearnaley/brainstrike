# Provider citation marker normalization — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change where or how provider citation markers are stripped.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

   **Provider citation markers are normalized at this same durable boundary.**
   OpenAI models running native web search emit citation bookkeeping inline in
   the text stream, wrapped in private-use codepoints
   (`U+E200 <type> U+E202 <payload> U+E201`, plus `U+E203..U+E204` hidden spans).
   `projectMessageContentForTranscript` in
   `packages/agent/src/pglite-mastra-memory/transcript-projection.ts` strips them
   from BOTH `parts[].text` and
   the flattened `content` string — the latter is the search extractor's
   fallback for rows with no text parts (see the `CONTENT_TEXT_SQL` contract in
   `packages/db/src/repositories/thread-search-repository.ts`). The rule itself
   is `stripProviderCitationMarkers` in
   `@brainstrike/assistant-contract/citation-markers`, shared with the render
   seam so the two cannot diverge. Three constraints are load-bearing and must
   survive any future writer:
   - **ASSISTANT ROWS ONLY.** Providers emit these markers on assistant text.
     Rewriting a user row is irreversible, makes a reloaded prompt differ from
     what the user typed, and alters the history replayed to the model; it also
     contradicts the renderer, where `UserMarkdownText` renders user-authored
     text verbatim.
   - **Settled-text mode.** Durable writers pass `{ unterminated: 'keep' }`.
     The unterminated-span heuristic exists for half-arrived markers mid-stream
     and is only safe where a later render can undo a false positive; these
     codepoints are also Nerd Fonts glyphs, so at a write-once seam an
     unterminated opener is treated as content, not as a truncated marker.
   - **`text` PARTS ONLY.** `reasoning` parts are persisted verbatim and keep
     any markers in the row. Nothing downstream reads them as prose (search
     filters `type = 'text'`; `getCopyText()` does not join reasoning), and the
     one consumer that renders them, `assistant-reasoning-part.tsx`, strips at
     read. The projection is not "everything downstream is clean" — it is these
     parts, for these readers.
   - **WRITE-TIME ONLY.** Rows persisted before this shipped keep their markers
     and stay that way in search until rewritten. Do not assume stored text is
     clean; backfilling is an unperformed data migration.

   Test seam: `packages/agent/src/pglite-mastra-memory/__tests__/pglite-memory-store.save-messages.spec.ts`
   (assistant rows stripped, user rows verbatim, trailing glyph preserved).

