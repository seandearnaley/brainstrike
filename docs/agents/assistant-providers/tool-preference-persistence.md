# MCP tool-preference persistence — evidence

Supports `docs/agents/assistant-providers.md` § "MCP tool-preference persistence". The two writers and the data loss each one caused.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5096-5110); append rather than
rewrite.

---

`mcp/tool-preferences.json` under `userData` is the user's only copy of which
MCP tools they turned off. It has TWO writers, and every rule below exists
because one of them destroyed data.

**Absence is not failure, and neither is evidence of staleness.** Both write
paths conflated "this id was not in this run's discovery" with "this id is
gone". MCP discovery loses its race routinely (BST-1603: an `npx`-launched
server exceeds the 5s budget on 100% of samples under load), so those are
ordinary runs, not edge cases.

- The LOAD path (`loadToolPreferencesForProjection`) pruned any stored id
  absent from `registeredIds` and rewrote the file (BST-1621).
- The SAVE path (`applyToolPreferenceMutation`) serialised
  `mcpToolRegistry.getAllTools()` — also only this run's tools — as the whole
  file, so one toggle dropped every failed server's choices (BST-1623).
