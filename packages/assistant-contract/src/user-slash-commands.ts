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
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== FRONTMATTER_FENCE) {
    return { ok: true, template: content };
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
    if (line.trim().length === 0) {
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
 * composer text (the documented assistant-ui "Commands with Arguments" pattern:
 * `execute` runs before the trigger text is removed, so the args are still
 * present). Returns `''` when the command was selected with no arguments, and
 * `null` when the composer does not invoke the command at all.
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

const ARGUMENTS_TOKEN = /\$ARGUMENTS\b/g;
const POSITIONAL_TOKEN = /\$(\d+)/g;
// A path mention: `@` at the start or after whitespace, then a non-space run.
const MENTION_TOKEN = /(^|\s)@(\S+)/g;

function basename(pathValue: string): string {
  const segments = pathValue.split('/');
  return segments.at(-1) || pathValue;
}

/**
 * Expand a command template with the user's arguments. Three deterministic,
 * renderer-safe passes (NO filesystem, NO shell):
 *
 * 1. `@path` tokens IN THE TEMPLATE become `:file[basename]{name=rootId::path}`
 *    directives when `mentionRootId` is bound; otherwise they stay literal text
 *    (the caller decides binding — a global command in a multi-root workspace has
 *    no unambiguous root, so it leaves the token for the user's `@` popover).
 *    Only template `@paths` are converted — user-supplied argument text is
 *    inserted verbatim in pass 3, so a `@` typed as an argument is never
 *    silently promoted to a file reference.
 * 2. `$ARGUMENTS` → the full argument string.
 * 3. `$1..$N` → positional arguments (missing positions expand to empty).
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

  const withMentions = template.replace(MENTION_TOKEN, (whole, lead: string, path: string) => {
    if (!mentionRootId) {
      return whole;
    }
    const directive = serializeFileMentionDirective({
      id: encodeFileMentionId(mentionRootId, path),
      label: basename(path),
    });
    return `${lead}${directive}`;
  });

  const positional = argString.trim().length > 0 ? argString.trim().split(/\s+/) : [];

  return withMentions
    .replace(ARGUMENTS_TOKEN, () => argString.trim())
    .replace(POSITIONAL_TOKEN, (_whole, digits: string) => {
      const index = Number.parseInt(digits, 10) - 1;
      return positional[index] ?? '';
    });
}
