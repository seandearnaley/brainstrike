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
 * Build a single `system`-role context message carrying the content of every
 * file referenced (via `:file[…]{name=…}` directives) in the current turn's
 * text, or `null` when none are referenced.
 *
 * Honesty contract (no silent fallbacks): a reference whose root id is not an
 * open workspace root, or whose file fails to read (missing, binary, too large,
 * outside the root), is surfaced as an explicit "could not read" note INSIDE the
 * context block — the model is told the reference was unresolvable rather than
 * the file being silently omitted.
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
    try {
      const file = await readFile({ rootPath: root.path, requestedPath: mention.path });
      const { text: body, truncated } = truncateForContext(file.content);
      const suffix = truncated
        ? `\n[Truncated to the first ${MAX_REFERENCED_FILE_CHARS} characters.]`
        : '';
      sections.push(`### ${file.path}\n\`\`\`\n${body}\n\`\`\`${suffix}`);
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
