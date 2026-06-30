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
 * survives the round-trip. Paths that contain `{`/`}`/`%` are version-marked and
 * percent-encoded inside the id so a path containing `}` cannot truncate the
 * directive's `{name=…}` attribute at parse time (see
 * {@link encodeFileMentionPathSegment}) while legacy unmarked percent sequences
 * remain raw path text. A short-lived pre-marker encoding existed for these
 * characters; the parser recognizes it only when the directive label proves the
 * decoded basename, never by guessing.
 */

/** The mention `type` for a file reference directive (`:file[…]{…}`). */
export const FILE_MENTION_DIRECTIVE_TYPE = 'file' as const;

/** Separator between the root id and the workspace path inside a mention id. */
const FILE_MENTION_ID_SEPARATOR = '::';

/**
 * Version marker for encoded path segments. It starts with `/`, which is not a
 * valid prefix for workspace-relative paths, so legacy raw ids cannot collide.
 */
const FILE_MENTION_ENCODED_PATH_PREFIX = '/.brainstrike-file-path-v1/';

/** Characters that need an encoded path segment inside the directive id. */
const FILE_MENTION_PATH_ESCAPE_RE = /[{}%]/;

/** Percent sequences emitted by the pre-marker encoder from PR #1303. */
const PRE_MARKER_FILE_MENTION_ESCAPE_RE = /%(?:25|7B|7D)/;

/**
 * Percent-encode the characters that would otherwise corrupt a mention id inside
 * the directive's `{name=…}` attribute. A literal `}` ends the attribute early at
 * parse time ({@link DIRECTIVE_RE}'s `[^}]+`), truncating the id; we also encode
 * `{` so the encoded id is brace-free, and `%` so the encoding is reversible (a
 * path literally containing `%7D` must not decode to `}`). `%` is escaped FIRST
 * so already-present `%` sequences are not conflated with our escapes. The
 * marker gates decoding so legacy unmarked `%7D` remains literal path text.
 */
function encodeFileMentionPathSegment(path: string): string {
  const shouldEncodePath =
    FILE_MENTION_PATH_ESCAPE_RE.test(path) || path.startsWith(FILE_MENTION_ENCODED_PATH_PREFIX);
  if (!shouldEncodePath) {
    return path;
  }
  return `${FILE_MENTION_ENCODED_PATH_PREFIX}${path
    .replaceAll('%', '%25')
    .replaceAll('{', '%7B')
    .replaceAll('}', '%7D')}`;
}

/**
 * Reverse {@link encodeFileMentionPathSegment} only when the encoded-path marker
 * is present. Unmarked ids are legacy raw path text. For marked ids, braces are
 * decoded before `%25` is restored to `%`: because every literal `%` was encoded
 * to `%25`, a bare `%` in the encoded text only ever begins one of our escapes,
 * so the brace passes can never consume an escaped percent and the final
 * `%25`→`%` pass can never forge a new brace escape. The result equals a single
 * left-to-right decode.
 */
function decodeFileMentionPathSegment(encodedPath: string): string {
  if (!encodedPath.startsWith(FILE_MENTION_ENCODED_PATH_PREFIX)) {
    return encodedPath;
  }
  return encodedPath
    .slice(FILE_MENTION_ENCODED_PATH_PREFIX.length)
    .replaceAll('%7B', '{')
    .replaceAll('%7D', '}')
    .replaceAll('%25', '%');
}

/** Decode only the uppercase escapes emitted by the short-lived pre-marker encoder. */
function decodePreMarkerFileMentionPathSegment(encodedPath: string): string {
  return encodedPath.replaceAll('%7B', '{').replaceAll('%7D', '}').replaceAll('%25', '%');
}

function getWorkspacePathBasename(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1 ? path : path.slice(slashIndex + 1);
}

/**
 * Parse-time compatibility for ids produced by the short-lived unmarked encoder.
 *
 * Pre-marker encoded ids and old raw ids are wire-ambiguous: `src/a%7Db.ts`
 * could mean a literal `%7D` filename or an encoded `}`. The directive label is
 * the selected file basename, so use it as proof only when it distinguishes the
 * two forms. If the label does not prove the decoded form, preserve the raw path
 * rather than guessing and risking wrong-file injection.
 */
function decodeFileMentionPathSegmentForLabel(encodedPath: string, label: string): string {
  if (
    encodedPath.startsWith(FILE_MENTION_ENCODED_PATH_PREFIX) ||
    !PRE_MARKER_FILE_MENTION_ESCAPE_RE.test(encodedPath)
  ) {
    return decodeFileMentionPathSegment(encodedPath);
  }
  const rawBasename = getWorkspacePathBasename(encodedPath);
  const preMarkerDecodedPath = decodePreMarkerFileMentionPathSegment(encodedPath);
  const decodedBasename = getWorkspacePathBasename(preMarkerDecodedPath);
  return rawBasename !== label && decodedBasename === label ? preMarkerDecodedPath : encodedPath;
}

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
 * Encode a `(rootId, path)` pair into the directive id `rootId::path`, percent-
 * encoding `{`/`}`/`%` in the path so the id stays brace-free (a raw `}` would
 * truncate the directive's `{name=…}` at parse time). Throws on an empty root id
 * or path — a directive with a missing identity is a bug, never silently coerced.
 */
export function encodeFileMentionId(rootId: string, path: string): string {
  if (!rootId) {
    throw new Error('encodeFileMentionId requires a non-empty rootId.');
  }
  if (!path) {
    throw new Error('encodeFileMentionId requires a non-empty path.');
  }
  return `${rootId}${FILE_MENTION_ID_SEPARATOR}${encodeFileMentionPathSegment(path)}`;
}

/**
 * Decode a directive id `rootId::path` back into its parts. Splits on the FIRST
 * `::` only so a path containing `:`/`::` survives, then reverses the path's
 * `{`/`}`/`%` percent-encoding ({@link decodeFileMentionPathSegment}). Returns
 * `null` when the id is not a valid `rootId::path` (no separator, or an empty
 * side) — the caller must skip such a malformed reference rather than guess.
 */
export function decodeFileMentionId(id: string): { rootId: string; path: string } | null {
  const separatorIndex = id.indexOf(FILE_MENTION_ID_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const rootId = id.slice(0, separatorIndex);
  const encodedPath = id.slice(separatorIndex + FILE_MENTION_ID_SEPARATOR.length);
  if (!(rootId && encodedPath)) {
    return null;
  }
  return { rootId, path: decodeFileMentionPathSegment(encodedPath) };
}

function decodeFileMentionIdForLabel(
  id: string,
  label: string
): { rootId: string; path: string } | null {
  const separatorIndex = id.indexOf(FILE_MENTION_ID_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const rootId = id.slice(0, separatorIndex);
  const encodedPath = id.slice(separatorIndex + FILE_MENTION_ID_SEPARATOR.length);
  if (!(rootId && encodedPath)) {
    return null;
  }
  return { rootId, path: decodeFileMentionPathSegmentForLabel(encodedPath, label) };
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
      const decoded = decodeFileMentionIdForLabel(id, label);
      if (decoded) {
        seen.add(id);
        mentions.push({ label, id, rootId: decoded.rootId, path: decoded.path });
      }
    }
    match = DIRECTIVE_RE.exec(text);
  }
  return mentions;
}
