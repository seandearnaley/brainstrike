import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { parseFileMentionDirectives } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { getWorkspaceRoots } from './workspace-roots';

const logger = createLogger('AssistantReferencedFiles');

/**
 * Max characters of a single referenced file injected into context. Mirrors the
 * read-tool default so a `@file` reference and a model-issued read tool surface a
 * comparable slice; oversized files are truncated with a visible note (never
 * silently dropped).
 */
const MAX_REFERENCED_FILE_CHARS = 12_000;

/**
 * Aggregate ceiling on the TOTAL file content injected for a single turn, across
 * ALL `@file` references. The per-file cap alone (12K) does not bound the total:
 * mentioning 20 files would inject ~240K chars and blow the model's input budget
 * (and contradict the tool-output budget discipline in CLAUDE.md). Once this
 * budget is exhausted, the remaining files are NOT injected — an honest "N
 * omitted to stay within the context budget" note is appended instead (never a
 * silent drop). ~4 files of full-size content, or more partial ones.
 */
export const MAX_REFERENCED_FILES_TOTAL_CHARS = 48_000;

/**
 * Reads a workspace text file (containment + size + binary guarded). Injected so
 * the context builder is unit-testable without disk; the live wiring passes the
 * real `readWorkspaceTextFile` from assistant-tools.
 */
export type WorkspaceFileReader = (args: {
  rootPath: string;
  requestedPath: string;
}) => Promise<{ content: string; path: string; size: number }>;

function extractText(message: AgentMessage): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function truncateForContext(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_REFERENCED_FILE_CHARS) {
    return { text: content, truncated: false };
  }
  return { text: content.slice(0, MAX_REFERENCED_FILE_CHARS), truncated: true };
}

/**
 * Wrap file content in a code fence that CANNOT be broken by backticks inside
 * the body. CommonMark lets a fence be closed only by a backtick run at least as
 * long as the opening run, so we open with one MORE backtick than the longest
 * run found in the body (min 3). Mirrors the edit tool's fence-escape rigor: a
 * referenced markdown/doc file that itself contains ``` no longer terminates the
 * wrapper early (which would make the model read the tail as prose, not content).
 */
function fenceContent(body: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (const char of body) {
    if (char === '`') {
      currentRun += 1;
      if (currentRun > longestRun) {
        longestRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${body}\n${fence}`;
}

/**
 * Build a single `system`-role context message carrying the content of every
 * file referenced (via `:file[…]{name=…}` directives) in the current turn's
 * text, or `null` when none are referenced.
 *
 * Honesty contract (no silent fallbacks): a reference whose root id is not an
 * open workspace root, or whose file fails to read (missing, binary, too large,
 * outside the root), is surfaced as an explicit "could not read" note INSIDE the
 * context block — the model is told the reference was unresolvable rather than
 * the file being silently omitted.
 *
 * Aggregate budget: each injected file keeps its per-file 12K cap, AND the TOTAL
 * injected content is bounded by {@link MAX_REFERENCED_FILES_TOTAL_CHARS}. When
 * the budget is exhausted, the remaining files are NOT read/injected — an honest
 * "N more referenced file(s) omitted to stay within the context budget" note is
 * appended instead. (Unresolvable-reference notes are tiny and always emitted.)
 *
 * NOTE: a directive id whose workspace path contains `}` is truncated by the
 * `{name=…}` directive regex; such an exotic path simply fails containment and
 * surfaces the honest "could not read" note rather than reading the wrong file.
 */
export async function buildReferencedFilesContextMessage(
  text: string,
  runtimeData: RuntimeData | undefined,
  readFile: WorkspaceFileReader
): Promise<AgentMessage | null> {
  const mentions = parseFileMentionDirectives(text);
  if (mentions.length === 0) {
    return null;
  }

  const roots = getWorkspaceRoots(runtimeData);
  const rootById = new Map(roots.map((root) => [root.rootId, root]));

  const sections: string[] = [
    'The user referenced the following workspace files with @file mentions. Their current content is provided below for this turn.',
  ];

  let injectedChars = 0;
  let omittedForBudget = 0;
  for (const mention of mentions) {
    const root = rootById.get(mention.rootId);
    if (!root) {
      logger.warn('Referenced file root is not an open workspace root', {
        rootId: mention.rootId,
        path: mention.path,
      });
      sections.push(
        `### ${mention.path}\n[Could not read: the file's workspace folder is no longer open.]`
      );
      continue;
    }
    // Stop reading once the aggregate budget is spent — count the rest as omitted
    // rather than reading (and discarding) files we can't inject.
    if (injectedChars >= MAX_REFERENCED_FILES_TOTAL_CHARS) {
      omittedForBudget += 1;
      continue;
    }
    try {
      const file = await readFile({ rootPath: root.path, requestedPath: mention.path });
      const { text: body, truncated } = truncateForContext(file.content);
      const suffix = truncated
        ? `\n[Truncated to the first ${MAX_REFERENCED_FILE_CHARS} characters.]`
        : '';
      injectedChars += body.length;
      sections.push(`### ${file.path}\n${fenceContent(body)}${suffix}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      logger.warn('Referenced file could not be read', {
        rootId: mention.rootId,
        path: mention.path,
        error: detail,
      });
      sections.push(`### ${mention.path}\n[Could not read: ${detail}]`);
    }
  }

  if (omittedForBudget > 0) {
    logger.warn('Referenced files omitted to stay within the context budget', {
      omitted: omittedForBudget,
      totalChars: injectedChars,
    });
    const plural = omittedForBudget === 1 ? 'file' : 'files';
    sections.push(
      `[${omittedForBudget} more referenced ${plural} omitted to stay within the context budget.]`
    );
  }

  return {
    id: `referenced-files-${Date.now()}`,
    role: 'system',
    parts: [{ type: 'text', text: sections.join('\n\n') }],
  };
}

function findLastUserMessageIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

/**
 * If the current turn's user message references any workspace files via `@file`
 * directives, read them and PREPEND a `system` context message carrying their
 * content. Only the LAST user message (the turn being sent) is scanned — prior
 * turns already had their references resolved when they were sent.
 *
 * Returns the original array (same identity) when nothing is referenced, so the
 * caller can pass it straight through with zero overhead on the common path.
 */
export async function injectReferencedFilesContext(
  messages: AgentMessage[],
  runtimeData: RuntimeData | undefined,
  readFile: WorkspaceFileReader
): Promise<AgentMessage[]> {
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex < 0) {
    return messages;
  }
  const lastUser = messages[lastUserIndex];
  if (!lastUser) {
    return messages;
  }
  const contextMessage = await buildReferencedFilesContextMessage(
    extractText(lastUser),
    runtimeData,
    readFile
  );
  if (!contextMessage) {
    return messages;
  }
  return [contextMessage, ...messages];
}
