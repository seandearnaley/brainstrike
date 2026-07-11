/**
 * User-defined slash command contract (shared between the desktop main process,
 * which SCANS `.md` command files off disk and PARSES their frontmatter, and the
 * renderer, which EXPANDS a selected command's template into the composer).
 *
 * Both sides import this single module so the parse form and the expand form can
 * never drift, and so the security posture (NO shell `!`command`` expansion,
 * ever) is enforced in one place. The `@path` half reuses the `@file` mention
 * directive contract ({@link serializeFileMentionDirective}), so a command's
 * `@src/foo.ts` becomes the exact directive the desktop assistant server already
 * resolves for `@file` mentions — no new file-reading code.
 */

import { encodeFileMentionId, serializeFileMentionDirective } from './file-mention-directive.js';

/** A user-defined slash command as returned over the discovery IPC. */
export interface UserSlashCommandDescriptor {
  /** Optional one-line description shown in the popover / used as a tooltip. */
  readonly description?: string;
  /** Namespaced, stable id (e.g. `git:commit`); the `/id` the user invokes. */
  readonly id: string;
  /** Display label shown in the popover (frontmatter `name` or the id). */
  readonly label: string;
  /**
   * The DB `roots.id` of the root that owns this command file, for project-scoped
   * commands (tiers 1 & 3). Absent for global commands (`~/.brainstrike`,
   * `~/.claude`). Drives `@path` root binding at expansion time.
   */
  readonly sourceRootId?: string;
  /** The raw template body (everything after the frontmatter, if any). */
  readonly template: string;
}

/** A mounted workspace root as the discovery IPC reports it (DB identity). */
export interface UserSlashCommandRoot {
  /** The root's display name. */
  readonly displayName: string;
  /** The DB `roots.id` — the identity `@file` directives + tools resolve against. */
  readonly id: string;
}

/** The discovery IPC payload: the commands plus the roots used to scan them. */
export interface UserSlashCommandsListResult {
  readonly commands: readonly UserSlashCommandDescriptor[];
  readonly roots: readonly UserSlashCommandRoot[];
}

/** Result of parsing one command `.md` file. Fails closed on malformed frontmatter. */
export type ParsedUserCommandFile =
  | {
      readonly description?: string;
      readonly name?: string;
      readonly ok: true;
      readonly template: string;
    }
  | { readonly error: string; readonly ok: false };

const FRONTMATTER_FENCE = '---';

/**
 * Parse a command file into `{ name?, description?, template }`. A file that does
 * not open with a `---` fence is a whole-file template (no frontmatter). A file
 * that opens a fence it never closes, or carries a non-`key: value` line inside
 * the fence, FAILS CLOSED with a structured error (no silent half-parse) — the
 * loader skips it and logs the error. Only `name`/`description` are recognized;
 * other keys (Claude Code's `allowed-tools`, `argument-hint`, …) are ignored so
 * existing `.claude/commands` files load without modification.
 */
export function parseUserCommandFile(content: string): ParsedUserCommandFile {
  // Strip a leading UTF-8 BOM so a BOM-prefixed `---` still opens frontmatter
  // (otherwise the whole file — fences included — leaks into the template).
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== FRONTMATTER_FENCE) {
    return { ok: true, template: normalized };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === FRONTMATTER_FENCE) {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return { error: 'unterminated frontmatter: no closing --- fence', ok: false };
  }

  let name: string | undefined;
  let description: string | undefined;
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    // Tolerate (ignore) Claude Code multiline-YAML continuation lines: list
    // items (`- Read`) and comments (`# note`). Only `name`/`description` are
    // recognized, so their VALUES never span lines; a bare list/comment line is
    // legal frontmatter we skip rather than fail closed on.
    if (trimmed.startsWith('-') || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      return { error: `malformed frontmatter line: ${line}`, ok: false };
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === 'name') {
      name = value;
    } else if (key === 'description') {
      description = value;
    }
  }

  // Body is everything after the closing fence; drop the single separating newline.
  const template = lines
    .slice(closingIndex + 1)
    .join('\n')
    .replace(/^\n/, '');
  return {
    ok: true,
    template,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Derive a command id from a directory-relative POSIX path: strip the `.md`
 * extension and join directory segments with `:` (so `git/commit.md` →
 * `git:commit`). Directory namespacing is the same convention Claude Code uses.
 */
export function deriveUserCommandId(relativePosixPath: string): string {
  const withoutExtension = relativePosixPath.replace(/\.(md|markdown|mdown|mkd)$/i, '');
  return withoutExtension
    .split('/')
    .filter((segment) => segment.length > 0)
    .join(':');
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * Read the raw argument string the user typed after `/commandId` in the LIVE
 * composer text. NOTE (F1): the pinned `@assistant-ui/react` trigger popover
 * closes at the FIRST whitespace after `/id`, so in the normal selection flow
 * this returns `''` (no inline args are reachable). Arguments are only present
 * via the cursor-before-args edge flow; when empty, {@link
 * expandUserCommandTemplate} leaves the `$ARGUMENTS`/`$N` tokens visible for the
 * user to fill in the composer. Returns `null` when the composer does not invoke
 * the command at all.
 */
export function extractUserCommandArgString(
  composerText: string,
  commandId: string
): string | null {
  const pattern = new RegExp(`/${escapeRegExp(commandId)}(?:\\s+([\\s\\S]*))?$`);
  const match = pattern.exec(composerText);
  if (!match) {
    return null;
  }
  return (match[1] ?? '').trim();
}

// Combined token scanner: a `@path` mention (`@` at start/after whitespace, then
// a non-space run) OR a `$ARGUMENTS` / `$<digits>` argument token. A SINGLE pass
// with a function replacement guarantees substituted text is never re-scanned
// (F2): `$100` inside an inserted arg stays literal, and a user-typed `@` in an
// arg is never promoted to a file directive.
const TEMPLATE_TOKEN = /(^|\s)@(\S+)|\$ARGUMENTS\b|\$(\d+)/g;
// The same argument tokens, for substituting args WITHIN a template @path.
const ARG_TOKEN = /\$ARGUMENTS\b|\$(\d+)/g;

function basename(pathValue: string): string {
  const segments = pathValue.split('/');
  return segments.at(-1) || pathValue;
}

/**
 * Substitute one `$ARGUMENTS` / `$<digits>` token. A FILLED token expands to its
 * value; an ABSENT token (empty arg string, or a positional past the end) is
 * left LITERAL (`whole`) so it stays a visible placeholder the user can fill —
 * never a silent empty blank (F1).
 */
function substituteArgToken(
  whole: string,
  digits: string | undefined,
  argString: string,
  positional: readonly string[]
): string {
  if (digits === undefined) {
    return argString.length > 0 ? argString : whole;
  }
  const value = positional[Number.parseInt(digits, 10) - 1];
  return value ?? whole;
}

function substituteArgsInText(
  text: string,
  argString: string,
  positional: readonly string[]
): string {
  return text.replace(ARG_TOKEN, (whole, digits: string | undefined) =>
    substituteArgToken(whole, digits, argString, positional)
  );
}

/**
 * True when `text` still carries an UNFILLED `$ARGUMENTS` / `$<digits>` token
 * after argument substitution — i.e. a placeholder the user never provided a
 * value for. A fresh (non-global) regex avoids the shared `ARG_TOKEN`'s stateful
 * `lastIndex`.
 */
function hasUnfilledArgPlaceholder(text: string): boolean {
  return /\$ARGUMENTS\b|\$\d+/.test(text);
}

/**
 * Expand a command template with the user's arguments in ONE deterministic,
 * renderer-safe pass (NO filesystem, NO shell):
 *
 * - `@path` tokens IN THE TEMPLATE become `:file[basename]{name=rootId::path}`
 *   directives when `mentionRootId` is bound; otherwise they stay literal text
 *   (the caller decides binding — a global command in a multi-root workspace has
 *   no unambiguous root, so it leaves the token for the user's `@` popover).
 *   Argument tokens INSIDE a template `@path` (e.g. `@src/$1`) are substituted
 *   BEFORE the directive is serialized, so a `}` in the arg is properly
 *   percent-encoded by {@link encodeFileMentionId} and cannot truncate the
 *   `{name=…}` attribute into a different file (F2). Only template `@paths`
 *   convert — user-supplied argument text is inserted verbatim, so a `@` typed
 *   as an argument is never silently promoted to a file reference.
 * - `$ARGUMENTS` → the full argument string (or a visible placeholder when no
 *   args were provided — the normal live flow, see {@link
 *   extractUserCommandArgString}).
 * - `$1..$N` → positional arguments (absent positions stay visible placeholders).
 *
 * Single-pass by construction: because the whole template is scanned once with a
 * function replacement, inserted argument text is NEVER re-scanned — a `$100` or
 * `$1` the user types as an argument survives verbatim (F2).
 *
 * There is deliberately NO handling of `!`command`` shell syntax — it is passed
 * through as inert text. Adding shell expansion (gated or not) is out of scope
 * and a security non-goal (see AGENTS.md USER-DEFINED SLASH COMMANDS).
 */
export function expandUserCommandTemplate(input: {
  readonly argString: string;
  readonly mentionRootId?: string | undefined;
  readonly template: string;
}): string {
  const { argString, mentionRootId, template } = input;
  const trimmedArgs = argString.trim();
  const positional = trimmedArgs.length > 0 ? trimmedArgs.split(/\s+/) : [];

  return template.replace(
    TEMPLATE_TOKEN,
    (
      whole: string,
      lead: string | undefined,
      mentionPath: string | undefined,
      digits: string | undefined
    ) => {
      if (mentionPath !== undefined) {
        const resolvedPath = substituteArgsInText(mentionPath, trimmedArgs, positional);
        // Leave the raw `@path` text (never serialize a directive) when the
        // root is unbound OR the path still holds an UNFILLED placeholder (e.g.
        // `@src/$1` invoked with no args). Baking a literal `$1`/`$ARGUMENTS`
        // into a `:file[…]{name=…}` directive would point it at a bogus path
        // `src/$1` that fails to resolve; leaving the raw text lets the user
        // fill it in (the `@` popover then binds it) — no fabricated directive.
        if (!mentionRootId || hasUnfilledArgPlaceholder(resolvedPath)) {
          return `${lead ?? ''}@${resolvedPath}`;
        }
        const directive = serializeFileMentionDirective({
          id: encodeFileMentionId(mentionRootId, resolvedPath),
          // NOTE: the label is `basename(resolvedPath)` inserted raw; the
          // directive grammar's label is `[^\]]+` (see DIRECTIVE_RE), so a
          // basename containing `]` truncates the label at parse time. The id
          // side percent-encodes `{`/`}`/`%`, but label chars are NOT escaped.
          // This fails CLOSED (the mention is skipped, never mis-injected to a
          // wrong file) and `]` in a basename is rare — accepted contract
          // limitation, shared with the `@file` mention pipeline.
          label: basename(resolvedPath),
        });
        return `${lead ?? ''}${directive}`;
      }
      return substituteArgToken(whole, digits, trimmedArgs, positional);
    }
  );
}
