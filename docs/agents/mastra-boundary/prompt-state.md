# R10 prompt state and Mastra Editor — evidence

Supports `docs/agents/mastra-boundary.md` § "R10 PROMPT STATE AND EDITOR". Read
this before re-arguing Mastra Editor on cloud-lock-in grounds, which is the wrong
objection.


**Prompt Workbench owns user prompt and version state.** PGlite is the only prompt
store; see `docs/agents/workspace-context.md`, `## PROMPT WORKBENCH`. Mastra Editor
is not adopted.

Two corrections to the rationale the tickets carried:

- Mastra Editor is **types only** in core 1.51 — `dist/editor/index.d.ts` exports no
  runtime values. Adoption requires `@mastra/editor`, not installed.
- Editor does **not** imply Mastra Cloud. `source: 'code'` writes versioned JSON
  under `./mastra/editor/`, using git as version history. The "cloud lock-in"
  objection is wrong; rejection rests on Prompt Workbench already owning this
  state, not on hosting.

Scope note: the recorded Prompt Workbench ruling covers the **prompt library's own
records**. Assistant system prompts and workspace instructions are a separate
feature whose source of truth is on-disk `AGENTS.md`/`CLAUDE.md`
(`docs/agents/workspace-context.md`, `## WORKSPACE INSTRUCTIONS CONTEXT`). Do not
conflate them.

