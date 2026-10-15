import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { parseFileMentionDirectives } from '@brainstrike/agent';
import { toBoundaryFailure } from '@brainstrike/agent-host/boundary-wire';
import {
  describeBoundaryFailure,
  type ReferencedFileFailure,
  refusal,
} from '@brainstrike/assistant-contract';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/ports';
import { createLogger } from '@brainstrike/logging';
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
// The canonical shape is the service's capability contract (BST-972 B4b);
// re-exported so this module's existing consumers keep their import site.
export type { WorkspaceFileReader };

type RuntimeWorkspaceRoot = ReturnType<typeof getWorkspaceRoots>[number];

/**
 * BST-2018: mentioned files in live workspace folders outside the thread,
 * attached for this run only, and the reader admitted to read exactly those.
 */
export interface AttachedMentionFolders {
  readonly read: WorkspaceFileReader;
  readonly roots: readonly RuntimeWorkspaceRoot[];
}

/** Where an attached file comes from, as the model reads it. */
function outsideThreadNote(rootName: string): string {
  return `(from ${rootName}, not one of this thread's folders; attached for this run only)`;
}

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

type ParsedMention = ReturnType<typeof parseFileMentionDirectives>[number];

type MentionRead =
  | { readonly chars: number; readonly section: string }
  | { readonly failure: ReferencedFileFailure; readonly section: string };

function unreadable(
  mention: ParsedMention,
  failure: ReferencedFileFailure['failure']
): MentionRead {
  return {
    failure: { failure, path: mention.path, rootId: mention.rootId },
    section: `### ${mention.path}\n[Could not read: ${describeBoundaryFailure(failure)}]`,
  };
}

function unavailableRoot(mention: ParsedMention): MentionRead {
  logger.warn('Referenced file root is not an open workspace root', {
    path: mention.path,
    rootId: mention.rootId,
  });
  return unreadable(
    mention,
    refusal({
      category: 'availability',
      code: 'workspace.root-unavailable',
      message: "The file's workspace folder is no longer open.",
      remedy: 'Re-add the folder and send the message again.',
    })
  );
}

async function readMention(
  mention: ParsedMention,
  root: RuntimeWorkspaceRoot,
  read: WorkspaceFileReader,
  options: { readonly outsideThread: boolean }
): Promise<MentionRead> {
  try {
    const file = await read({ requestedPath: mention.path, rootPath: root.path });
    const { text: body, truncated } = truncateForContext(file.content);
    const suffix = truncated
      ? `\n[Truncated to the first ${MAX_REFERENCED_FILE_CHARS} characters.]`
      : '';
    // Qualify the heading with the root so two roots that share a relative path
    // (e.g. both have `src/index.ts`) produce DISTINCT headings, not ambiguous
    // identical ones.
    const heading = options.outsideThread
      ? `${root.displayName}/${file.path} ${outsideThreadNote(root.displayName)}`
      : `${root.displayName}/${file.path}`;
    return { chars: body.length, section: `### ${heading}\n${fenceContent(body)}${suffix}` };
  } catch (error) {
    logger.warn('Referenced file could not be read', {
      error,
      path: mention.path,
      rootId: mention.rootId,
    });
    return unreadable(
      mention,
      toBoundaryFailure(error, (message, fields) => logger.warn(message, fields))
    );
  }
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
/**
 * BST-2007: only a typed refusal's text reaches the model. Anything else (an
 * fs error naming a host path, a driver message) is logged above and becomes
 * a fixed sentence.
 */
export async function readReferencedFilesContext(
  text: string,
  runtimeData: RuntimeData | undefined,
  readFile: WorkspaceFileReader,
  attached?: AttachedMentionFolders
): Promise<{ message: AgentMessage | null; failures: ReferencedFileFailure[] }> {
  const mentions = parseFileMentionDirectives(text);
  if (mentions.length === 0) {
    return { failures: [], message: null };
  }

  const roots = getWorkspaceRoots(runtimeData);
  const rootById = new Map(roots.map((root) => [root.rootId, root]));

  const failures: ReferencedFileFailure[] = [];
  const sections: string[] = [
    'The user referenced the following workspace files with @file mentions. Their current content is provided below for this turn.',
  ];

  let injectedChars = 0;
  let omittedForBudget = 0;
  for (const mention of mentions) {
    const attachedRoot = rootById.has(mention.rootId)
      ? undefined
      : attached?.roots.find((candidate) => candidate.rootId === mention.rootId);
    const root = rootById.get(mention.rootId) ?? attachedRoot;
    // Stop reading once the aggregate budget is spent — count the rest as omitted
    // rather than reading (and discarding) files we can't inject.
    if (root && injectedChars >= MAX_REFERENCED_FILES_TOTAL_CHARS) {
      omittedForBudget += 1;
      continue;
    }
    const result = root
      ? await readMention(mention, root, attachedRoot && attached ? attached.read : readFile, {
          outsideThread: attachedRoot !== undefined,
        })
      : unavailableRoot(mention);
    sections.push(result.section);
    if ('failure' in result) {
      failures.push(result.failure);
    } else {
      injectedChars += result.chars;
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
    failures,
    message: {
      id: `referenced-files-${Date.now()}`,
      parts: [{ text: sections.join('\n\n'), type: 'text' }],
      role: 'system',
    },
  };
}

export async function buildReferencedFilesContextMessage(
  text: string,
  runtimeData: RuntimeData | undefined,
  readFile: WorkspaceFileReader
): Promise<AgentMessage | null> {
  return (await readReferencedFilesContext(text, runtimeData, readFile)).message;
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
