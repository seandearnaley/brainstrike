/**
 * Semantic code-navigation native tools (BST-743): findWorkspaceSymbol (textual
 * symbol scan) and lspInspect (language-server hover/definition/implementation +
 * line diagnostics). Both read the target file through the shared checked reader
 * so containment/size/binary guards apply, and resolve the model's cursor
 * `match` to a column with the same validate-before-position discipline as
 * stringReplace. Extracted from `assistant-tools.ts`.
 */
import type { FindWorkspaceSymbolInput, LspInspectInput, RuntimeData } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import { findSymbolMatches } from './find-workspace-symbol';
import { getLspInspection, type LspInspectionResult } from './lsp-diagnostics';
import { resolveWorkspaceRoot } from './workspace-roots';

export async function runFindWorkspaceSymbol(
  input: FindWorkspaceSymbolInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  rootName: string;
  path: string;
  totalMatches: number;
  truncated: boolean;
  matches: ReturnType<typeof findSymbolMatches>['matches'];
}> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Route through the checked reader so the same guards apply (isFile, 2 MB size
  // cap, NUL-byte binary probe). Symbol scanning returns only a tiny bounded
  // result, so a multi-MB bundle or binary file must error cleanly rather than
  // be loaded and scanned in full on the main process.
  const file = await readWorkspaceTextFile({ requestedPath: input.path, rootPath: root.path });
  const { matches, totalMatches, truncated } = findSymbolMatches(file.content, input.query, {
    contextLines: input.contextLines ?? 2,
    maxMatches: input.maxMatches ?? 5,
  });
  return { matches, path: file.path, rootName: root.displayName, totalMatches, truncated };
}

/** The cursor marker the model inserts into `match` to point at a symbol. */
const LSP_CURSOR_MARKER = '<<<';
const LSP_MARKERLESS_IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;
const LSP_IDENTIFIER_CONTINUE_CHARACTER = /^[\p{ID_Continue}$\u200C\u200D]$/u;
const MAX_LSP_MATCH_CANDIDATE_LINES = 5;

function findMarkerlessIdentifierOffsets(line: string, identifier: string): number[] {
  const offsets: number[] = [];
  let offset = line.indexOf(identifier);
  while (offset !== -1) {
    const precedingCharacter = Array.from(line.slice(0, offset)).at(-1);
    const followingCharacter = Array.from(line.slice(offset + identifier.length)).at(0);
    const hasIdentifierBoundary = !(
      (precedingCharacter && LSP_IDENTIFIER_CONTINUE_CHARACTER.test(precedingCharacter)) ||
      (followingCharacter && LSP_IDENTIFIER_CONTINUE_CHARACTER.test(followingCharacter))
    );
    if (hasIdentifierBoundary) {
      offsets.push(offset);
    }
    offset = line.indexOf(identifier, offset + identifier.length);
  }
  return offsets;
}

function findLspMatchCandidateLines(lines: readonly string[], match: string): number[] {
  const candidates: number[] = [];
  for (const [index, rawLine] of lines.entries()) {
    if (findMarkerlessIdentifierOffsets(rawLine.replace(/\r$/, ''), match).length > 0) {
      candidates.push(index + 1);
      if (candidates.length === MAX_LSP_MATCH_CANDIDATE_LINES) {
        break;
      }
    }
  }
  return candidates;
}

function formatLspCandidateRetryHint(candidateLines: readonly number[]): string {
  if (candidateLines.length === 0) {
    return '';
  }
  if (candidateLines.length === 1) {
    return ` The identifier occurs on line ${candidateLines[0]}; retry with line ${candidateLines[0]}.`;
  }
  return ` The identifier occurs on candidate lines ${candidateLines.join(', ')}; retry with the intended line.`;
}

/**
 * Semantic code inspection (report R2 Phase B). Reads the file through the same
 * checked reader as the read tools (containment/size/binary guards), resolves
 * a markerless identifier or `<<<` cursor from `match` to a column on the
 * 1-based `line`, and asks the language server for
 * hover/definition/implementation + line diagnostics. Never spawns for an
 * out-of-range line or malformed target — those are actionable input errors
 * thrown for the model to correct.
 */
export async function runLspInspect(
  input: LspInspectInput,
  runtimeData: RuntimeData | undefined
): Promise<LspInspectionResult & { rootName: string; path: string }> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const markerCount = input.match.split(LSP_CURSOR_MARKER).length - 1;
  if (markerCount > 1) {
    throw new ToolInputError(
      `The "match" field must be a unique identifier without a marker or contain exactly one "${LSP_CURSOR_MARKER}" cursor marker (found ${markerCount}).`
    );
  }
  const isMarkerlessIdentifier = markerCount === 0;
  if (isMarkerlessIdentifier && !LSP_MARKERLESS_IDENTIFIER.test(input.match)) {
    throw new ToolInputError(
      `A "match" without "${LSP_CURSOR_MARKER}" must be one JavaScript/TypeScript identifier. For a line fragment, insert exactly one "${LSP_CURSOR_MARKER}" immediately before the intended symbol.`
    );
  }
  const file = await readWorkspaceTextFile({ requestedPath: input.path, rootPath: root.path });
  const lines = file.content.split('\n');
  if (input.line > lines.length) {
    throw new ToolInputError(
      `Line ${input.line} is past the end of "${input.path}" (${lines.length} lines).`
    );
  }
  const markerOffset = isMarkerlessIdentifier ? 0 : input.match.indexOf(LSP_CURSOR_MARKER);
  const strippedMatch = isMarkerlessIdentifier
    ? input.match
    : input.match.replace(LSP_CURSOR_MARKER, '');
  if (strippedMatch.trim().length === 0) {
    throw new ToolInputError(
      `The "match" field must include the line's text around the "${LSP_CURSOR_MARKER}" marker, not the marker alone.`
    );
  }
  // Anchor the match against the REAL line so a partial or stale quote can
  // never silently inspect the wrong column (mirrors stringReplace's
  // validate-before-position convention). CRLF: the split leaves a trailing
  // \r; it can't precede the marker, so ignoring it never shifts the column.
  const lineText = (lines[input.line - 1] ?? '').replace(/\r$/, '');
  const markerlessOffsets = isMarkerlessIdentifier
    ? findMarkerlessIdentifierOffsets(lineText, strippedMatch)
    : [];
  const fragmentStart = isMarkerlessIdentifier
    ? (markerlessOffsets[0] ?? -1)
    : lineText.indexOf(strippedMatch);
  if (fragmentStart === -1) {
    const candidateLines = isMarkerlessIdentifier
      ? findLspMatchCandidateLines(lines, strippedMatch)
      : [];
    const retryHint = formatLspCandidateRetryHint(candidateLines);
    throw new ToolInputError(
      `The "match" text was not found on line ${input.line} of "${input.path}". That line is: ${JSON.stringify(lineText)}.${retryHint}`
    );
  }
  const isAmbiguous = isMarkerlessIdentifier
    ? markerlessOffsets.length > 1
    : lineText.indexOf(strippedMatch, fragmentStart + 1) !== -1;
  if (isAmbiguous) {
    if (isMarkerlessIdentifier) {
      throw new ToolInputError(
        `The identifier occurs more than once on line ${input.line} of "${input.path}" — pass a unique line fragment with exactly one "${LSP_CURSOR_MARKER}" immediately before the intended occurrence.`
      );
    }
    throw new ToolInputError(
      `The "match" text (marker removed) occurs more than once on line ${input.line} of "${input.path}" — include more surrounding text so the cursor position is unambiguous.`
    );
  }
  const character = fragmentStart + markerOffset;
  const result = await getLspInspection({
    absolutePath: file.absolutePath,
    content: file.content,
    // LSP positions are 0-based; the tool takes a 1-based line + the cursor col.
    position: { character, line: input.line - 1 },
    rootId: root.rootId,
    rootPath: root.path,
  });
  return { ...result, path: file.path, rootName: root.displayName };
}
