/**
 * Shared user-facing copy for Conversation Rewind (BST-1115).
 *
 * THE CAPTURE-SCOPE QUALIFIER (2026-08-05 smoke round 2, defect 3). The edit
 * journal records ONLY mutations made through the assistant's own file tools.
 * A file a shell command produced — `npm install` writing `package-lock.json`,
 * a build emitting `dist/` — has no journal row, so a rewind cannot and does
 * not restore it. The user who hit this had every scaffolded source file come
 * back and `package-lock.json` silently stay gone.
 *
 * Expanding capture to cover shell side effects is a real, separate piece of
 * work. Until it exists the honest fix is to SAY SO — permanently, in both the
 * confirmation (before the user decides) and the outcome summary (after a
 * rewind actually restored something) — rather than let the omission read as a
 * bug. NO SILENT DEGRADATION: an unstated limit is a lie about what "restore"
 * means.
 *
 * ONE constant, deliberately: the pre-apply promise and the post-apply
 * qualifier must be the SAME sentence, or the second one reads as new news.
 * Both renderers are pinned to this literal by test.
 */
export const REWIND_SHELL_CAPTURE_QUALIFIER =
  "Restores files edited by the assistant's tools. Files created by shell commands (installs, builds) aren't tracked and won't be restored.";
