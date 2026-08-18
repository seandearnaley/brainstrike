# BST-1363 Env bootstrap visibility — live CDT verification

Captured 2026-08-18 from the desktop app running under
`pnpm --filter @brainstrike/desktop dev:agent-debug` (CDP port 9222), driven
over CDP with Playwright. Fresh agent-devtools profile per session. Every
state comes from the REAL `secrets:envBootstrap` channel reading the REAL
recorded bootstrap of real `apps/desktop/.env` / `.env.local` files — nothing
is mocked or seeded through a test hook.

The env files used for capture contained only obviously fake placeholder
values (each ending in `fake-bst1363`, matching no real credential) and are
gitignored; they were removed after capture.

Re-captured after code review, so every frame shows SHIPPED copy.

| File | State |
| --- | --- |
| `01-env-loaded-chips.png` | Both dev files applied: `Environment: .env.local + .env loaded, 4 variables applied`; amber rename guidance for the retired `AI_OPENAI_API_KEY` naming the VENDOR replacement plus the file-provenance clause; effective-variable chips with credential names (`BRAINSTRIKE_OPENAI_API_KEY`, `TAVILY_API_KEY`) visually distinct from the non-credential config name (`AWS_REGION`); the explicit `Changes to environment files apply after restart.` note. The inventory above shows the same env resolution landing as read-only `Env (…)` rows. |
| `02-chip-crosslink-highlight.png` | After clicking the `BRAINSTRIKE_OPENAI_API_KEY` chip: the OpenAI inventory row is scrolled to and ringed (`data-highlighted="true"` on `credential-row-openai` only). This frame is also the proof for the review blocker — the row and the Environment section now advise the SAME rename target (`OPENAI_API_KEY`), where they previously contradicted each other in this exact view. |
| `03-invalid-line-failure.png` | THE FAILURE CLASS THIS TICKET EXISTS FOR. `.env.local` line 3 was changed to an unsupported name and the app restarted: the section states `Environment: no .env file loaded` and the banner reproduces the parser's line-precise message verbatim — `Desktop environment file ".env.local" is invalid at line 3: unsupported variable name.` — plus `No environment file was applied — one invalid file discards them all.` The chips are gone because rejection is all-or-nothing, which is exactly what that sentence now says. No internal file id (`dev` / `dev-local`) appears anywhere. |

## Payload verified value-free against the live bridge

`window.envBootstrap.read()` was called in the running renderer with all four
variables set. The returned payload listed the NAMES
(`AI_OPENAI_API_KEY`, `BRAINSTRIKE_OPENAI_API_KEY`, `TAVILY_API_KEY`,
`AWS_REGION`) and the two file paths, and a substring check for each of the
four seeded VALUES — including the `AWS_REGION` value `us-east-1` — found none
of them anywhere in the serialized payload.

## Not covered by a screenshot

`Open folder` renders only for a packaged `user-data` `.env`, which an
unpackaged `dev:agent-debug` run has no candidate for (`openFolder: false` was
asserted in both dev captures, which is the correct dev behaviour). Its
behaviour is covered by unit tests for both the loaded and the
failed-to-parse user-data cases.
