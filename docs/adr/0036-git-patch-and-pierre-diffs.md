# ADR-0036: Git's patch is the diff; @pierre/diffs draws it

- **Status:** Accepted (Sean, 2026-11-04: "proceed with all the recommendations" of
  the diff overhaul report, including its five decisions)
- **Date:** 2026-11-04

## Context

Git computed each changed file's numstat and patch, then the host threw the patch away
and sent hunk headers next to the two full sides. The renderer, CodeMirror Merge,
diffed the sides again in the browser, sliced the documents back down to the hunks git
had named, and drew one 420px editor per file. Two diff engines could disagree with
each other and with the counts in the file list. Each file was a separate editor and a
separate request, line comments were a custom gutter extension, and approvals ran a
third path through the same editor.

In 2026 the coding-agent review surfaces (Codex, Cursor, Claude Code desktop) draw one
scrolling, virtualized view of git's own patch, with sticky file headers, expandable
context, word-level highlights and comments anchored to lines. Codex draws it with
@pierre/diffs (Apache-2.0).

## Decision

1. **Git is the only diff engine for changes git has.** Every file diff the host sends
   carries git's unified patch for that one file, produced with pinned output flags so
   no user config can change or break it. A view entry carries the same patch while the
   view's patches stay under one bound; a file past the bound, or too large for its own
   bound, loads on demand. The renderer parses the patch and never diffs it again, so
   the drawn lines are the lines numstat counted.
2. **@pierre/diffs is the only diff renderer.** The Changes surface is one `CodeView`
   over every file in the view. Full sides, when git sent them, only expand unchanged
   context (`loadDiffFiles`). The version is pinned exactly in the catalog.
   `@codemirror/merge`, the hunk slicer and the comment gutter extensions are removed;
   CodeMirror stays the file editor.
3. **A proposed edit is diffed by the renderer.** An approval preview shows text that
   is not in git yet. The card reads it with `interaction/preview`: the host runs the
   call's own tool resolution and matcher without writing, and returns the file's text
   now and after the call. Nothing durable holds it. @pierre/diffs diffs the two texts.
   This is the one place the renderer computes a diff.
4. **Comments are drafts until added to a message.** A line comment stays on the diff
   in session state, per changeset, until the person adds the drafts to the active
   thread's message. Nothing new is durable.
5. **The host stays the only writer.** Hunk and file actions (stage, unstage, revert)
   are one host method, `changes/apply`, that applies git's own patch or path-level
   git and refuses a stale target or a conflict; the renderer never writes a file.
   A settled turn's view reverts whole files only, each while it is exactly as the
   turn left it, back to the turn's start (Sean, 2026-11-05); hunks revert from
   Unstaged.

## Consequences

- A view draws every file from one request, and the file list, the header counts and
  the drawn lines always agree.
- The tree is navigation: choosing a file scrolls the diff to it. The selection filter
  is gone.
- A turn's changes show in the chat under its reply, drawn by the same renderer from
  the same view as Changes.
- @pierre/diffs is a large dependency that loads only with a diff surface. Its themes
  are the user's code theme pair, on the app's background and fonts.
- The library's gutter + has no accessible name and shows on hover, as the removed
  CodeMirror gutter did; keyboard comments remain a follow-up.
- A patch that does not parse is a host bug and fails visibly instead of being redrawn
  from the sides.
