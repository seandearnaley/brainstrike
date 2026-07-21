# Project-scope Brainstrike automation skills

## Goal

Move Brainstrike-only automation guidance and collectors out of the global Codex
skill namespace and into the repository so every checkout receives the same
versioned workflow.

## Scope

- Add the eleven Night Shift `*-automation` skills under
  `.agents/skills/<name>/`.
- Add `brainstrike-pr-loop` beside them because Bolt invokes it directly and it
  is also repository-specific.
- Replace global `$CODEX_HOME/skills/...` command paths with repository-relative
  `.agents/skills/...` paths.
- Preserve the current skill instructions, collectors, tests, and UI metadata.
- Keep the global copies installed until this PR is merged and the scheduled
  task checkout contains the repository copies.

## Proof

1. Compare every migrated file against its global source, allowing only the
   intentional command-path changes.
2. Validate every skill with `quick_validate.py` and validate every
   `agents/openai.yaml` against its `SKILL.md`.
3. Run every bundled Node syntax check and collector unit test.
4. Run the repository lint, type-check, build, and unit-test gate together.

## Scheduled tasks

Codex scheduled-task records remain user-level configuration, but each active
Night Shift task is already bound to the Brainstrike project directory. The
committed charter files and project-scoped skills remain the repository-owned
sources of truth; schedule provisioning is intentionally outside this PR.
