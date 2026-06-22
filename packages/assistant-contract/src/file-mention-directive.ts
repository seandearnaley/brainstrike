/**
 * Shared `@file` mention directive contract.
 *
 * The composer's `@file` picker (packages/ui) SERIALIZES a chosen file into a
 * directive embedded in the message text; the desktop assistant server PARSES
 * that directive back out when the turn is sent, so it can inject the referenced
 * file's content into the model's context. Both sides import this single module
 * so the serialized form and the parsed form can never drift.
 *
 * The directive syntax MIRRORS assistant-ui's `unstable_defaultDirectiveFormatter`
 * (`@assistant-ui/core`): `:type[label]{name=id}`, where the `{name=…}` attribute
 * is omitted when `id === label`. We re-implement the format here (rather than
 * depend on `@assistant-ui/core`) because the agent/server packages must not pull
 * in the renderer library; the format is locked by `serialize -> parse`
 * round-trip tests on both the contract regex and (in the UI package) the real
 * assistant-ui formatter.
 *
 * The mention `id` encodes the file's identity as `rootId::path`, where `rootId`
 * is the DB `roots.id` (the same id `file_records.root_id` references and the
 * desktop tools resolve against) and `path` is the workspace-relative path. We
 * split on the FIRST `::` only, so a path that itself contains `:` or `::`
 * survives the round-trip.
 */

/** The mention `type` for a file reference directive (`:file[…]{…}`). */
export const FILE_MENTION_DIRECTIVE_TYPE = 'file' as const;

/** Separator between the root id and the workspace path inside a mention id. */
const FILE_MENTION_ID_SEPARATOR = '::';

/**
 * Mirrors assistant-ui's `unstable_defaultDirectiveFormatter` directive regex:
 * `:type[label]{name=id}` with an optional `{name=…}` attribute. `type` is a
 * word/hyphen run, `label` is anything up to the closing `]`, and `id` is
 * anything up to the closing `}`.
 */
const DIRECTIVE_RE = /:([\w-]+)\[([^\]]+)\](?:\{name=([^}]+)\})?/g;

/** A file mention as the composer knows it (before/after the directive encoding). */
export interface FileMentionDirective {
  /** Encoded identity: `rootId::path` (see {@link encodeFileMentionId}). */
  readonly id: string;
  /** Display label shown in the composer (the file's basename). */
  readonly label: string;
}

/** A parsed file directive with its decoded root id and workspace path. */
export interface ParsedFileMention extends FileMentionDirective {
  /** Workspace-relative path of the referenced file. */
  readonly path: string;
  /** DB `roots.id` the referenced file belongs to. */
  readonly rootId: string;
}

/**
 * Encode a `(rootId, path)` pair into the directive id `rootId::path`. Throws on
 * an empty root id or path — a directive with a missing identity is a bug, never
 * silently coerced.
 */
export function encodeFileMentionId(rootId: string, path: string): string {
  if (!rootId) {
    throw new Error('encodeFileMentionId requires a non-empty rootId.');
  }
  if (!path) {
    throw new Error('encodeFileMentionId requires a non-empty path.');
  }
  return `${rootId}${FILE_MENTION_ID_SEPARATOR}${path}`;
}

/**
 * Decode a directive id `rootId::path` back into its parts. Splits on the FIRST
 * `::` only so a path containing `:`/`::` survives. Returns `null` when the id is
 * not a valid `rootId::path` (no separator, or an empty side) — the caller must
 * skip such a malformed reference rather than guess.
 */
export function decodeFileMentionId(id: string): { rootId: string; path: string } | null {
  const separatorIndex = id.indexOf(FILE_MENTION_ID_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const rootId = id.slice(0, separatorIndex);
  const path = id.slice(separatorIndex + FILE_MENTION_ID_SEPARATOR.length);
  if (!(rootId && path)) {
    return null;
  }
  return { rootId, path };
}

/**
 * Serialize a file mention into its directive string. Mirrors
 * `unstable_defaultDirectiveFormatter.serialize`: the `{name=id}` attribute is
 * omitted only when `id === label` (never the case for files, whose id always
 * encodes the root + path), but we keep the parity so the round-trip matches the
 * library exactly.
 */
export function serializeFileMentionDirective(mention: FileMentionDirective): string {
  const attrs = mention.id === mention.label ? '' : `{name=${mention.id}}`;
  return `:${FILE_MENTION_DIRECTIVE_TYPE}[${mention.label}]${attrs}`;
}

/**
 * Parse every `:file[…]{name=…}` directive out of a message's text, decoding each
 * id into its `rootId` + `path`. Non-`file` directive types are ignored. A file
 * directive whose id is not a valid `rootId::path` is skipped (logged by the
 * caller as an unresolvable reference, never silently injected). Duplicate ids
 * are deduped — the first occurrence wins — so referencing the same file twice
 * doesn't read it twice. Results preserve first-seen document order.
 */
export function parseFileMentionDirectives(text: string): ParsedFileMention[] {
  const seen = new Set<string>();
  const mentions: ParsedFileMention[] = [];
  // Reset lastIndex defensively: the regex is module-level + /g (stateful).
  DIRECTIVE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = DIRECTIVE_RE.exec(text);
  while (match !== null) {
    const type = match[1];
    const label = match[2] ?? '';
    const id = match[3] ?? label;
    if (type === FILE_MENTION_DIRECTIVE_TYPE && !seen.has(id)) {
      const decoded = decodeFileMentionId(id);
      if (decoded) {
        seen.add(id);
        mentions.push({ label, id, rootId: decoded.rootId, path: decoded.path });
      }
    }
    match = DIRECTIVE_RE.exec(text);
  }
  return mentions;
}
