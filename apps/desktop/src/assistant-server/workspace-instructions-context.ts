import type { AgentMessage, RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { getWorkspaceRoots } from './workspace-roots';

const logger = createLogger('AssistantWorkspaceInstructions');

/**
 * Max characters of a single workspace instructions file injected into context.
 * Mirrors `MAX_REFERENCED_FILE_CHARS` (referenced-files-context.ts) so a
 * `@file` reference and an auto-injected instructions file surface a comparable
 * slice. A file at/under this size is injected WHOLE by default; a file over it
 * is OVERSIZED (see the threshold-hybrid policy below).
 */
export const MAX_CONTEXT_FILE_CHARS = 12_000;

/**
 * Aggregate ceiling on the TOTAL instructions content injected for a single
 * turn, across ALL mounted roots. Mirrors `MAX_REFERENCED_FILES_TOTAL_CHARS`.
 * Once exhausted, the remaining roots' files are NOT injected — an honest "N
 * omitted to stay within the context budget" note is appended (never a silent
 * drop).
 */
export const MAX_CONTEXT_FILES_TOTAL_CHARS = 48_000;

/**
 * Candidate instructions file names per root, in first-match-wins priority.
 * `AGENTS.md` is brainstrike's own convention (plural — the file this repo uses);
 * `AGENT.md`/`CLAUDE.md` follow for zero-migration adoption.
 */
export const WORKSPACE_INSTRUCTIONS_FILE_NAMES = ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'] as const;

/**
 * Reads a workspace text file (containment + size + binary guarded). Injected so
 * the context builder is unit-testable without disk; the live wiring passes the
 * real `readWorkspaceTextFile` from assistant-tools. Identical shape to the
 * referenced-files reader.
 */
export type WorkspaceFileReader = (args: {
  rootPath: string;
  requestedPath: string;
}) => Promise<{ content: string; path: string; size: number }>;

/**
 * Wrap file content in a code fence that CANNOT be broken by backticks inside
 * the body (CommonMark: a fence closes only on a run at least as long as the
 * opener). Mirrors referenced-files-context.ts so an instructions file that
 * itself contains ``` no longer terminates the wrapper early.
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

function isLocalProvider(runtimeData: RuntimeData | undefined): boolean {
  const provider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  return provider.toLowerCase() === 'local';
}

export interface FoundContextFile {
  content: string;
  path: string;
  size: number;
}

/**
 * Decide the injectable body + honest suffix for a found file under the
 * threshold-hybrid policy: a fits-the-budget file injects whole; an oversized
 * file injects TRUNCATED only when its root is opted in, else `null` (detected
 * but not injected — surfaced in Settings, no prompt note).
 */
function resolveInjectableBody(
  found: FoundContextFile,
  rootId: string,
  optIns: Record<string, boolean>
): { body: string; suffix: string } | null {
  if (found.content.length <= MAX_CONTEXT_FILE_CHARS) {
    return { body: found.content, suffix: '' };
  }
  if (optIns[rootId] !== true) {
    return null;
  }
  return {
    body: found.content.slice(0, MAX_CONTEXT_FILE_CHARS),
    suffix: `\n[Truncated to the first ${MAX_CONTEXT_FILE_CHARS} characters — this file exceeds the per-file budget and was injected because you opted this workspace in.]`,
  };
}

/**
 * Find the first-existing instructions file at a root's top level, in
 * {@link WORKSPACE_INSTRUCTIONS_FILE_NAMES} priority. A read failure (missing,
 * binary, or over the reader's hard byte cap) advances to the next candidate;
 * an all-miss root yields `null` (a root with no instructions file is normal —
 * never a note). Exported so the Settings scan reuses the exact same
 * first-match-wins resolution as the injection path.
 */
export async function findRootContextFile(
  root: RuntimeWorkspaceRoot,
  readFile: WorkspaceFileReader
): Promise<FoundContextFile | null> {
  for (const name of WORKSPACE_INSTRUCTIONS_FILE_NAMES) {
    try {
      const file = await readFile({ requestedPath: name, rootPath: root.path });
      return { content: file.content, path: file.path, size: file.size };
    } catch {
      // Not this candidate (missing/binary/too-large) — try the next name.
    }
  }
  return null;
}

/**
 * Build a single `system`-role context message carrying each mounted root's
 * workspace instructions file (`AGENTS.md`/`AGENT.md`/`CLAUDE.md`, first match
 * per root), or `null` when nothing is injected.
 *
 * Threshold-hybrid policy (product ruling — no silent drops):
 * - master toggle OFF (`workspaceInstructionsPreference.masterEnabled === false`)
 *   => nothing injected.
 * - built-in local provider => nothing injected (the on-device model's whole
 *   context budget is tiny; mirrors the personas/plan-mode local exclusions).
 * - a file that FITS the per-file budget => injected WHOLE, no note.
 * - an OVERSIZED file => injected TRUNCATED (with an honest note) ONLY when its
 *   root is opted in via `oversizedOptInByRootId[rootId]`; otherwise it is NOT
 *   injected and NO skip-note is placed in the prompt — the file is surfaced in
 *   the Settings UI as "detected but not injected (too large)" instead.
 *
 * Aggregate budget: each injected file keeps its per-file cap AND the total is
 * bounded by {@link MAX_CONTEXT_FILES_TOTAL_CHARS}; roots beyond it are counted
 * and reported as omitted, never silently dropped.
 */
export async function buildWorkspaceInstructionsContextMessage(
  runtimeData: RuntimeData | undefined,
  readFile: WorkspaceFileReader
): Promise<AgentMessage | null> {
  if (runtimeData?.workspaceInstructionsPreference?.masterEnabled === false) {
    return null;
  }
  if (isLocalProvider(runtimeData)) {
    return null;
  }

  const roots = getWorkspaceRoots(runtimeData);
  if (roots.length === 0) {
    return null;
  }

  const optIns = runtimeData?.workspaceInstructionsPreference?.oversizedOptInByRootId ?? {};

  const sections: string[] = [
    'The following workspace instruction files define the conventions and constraints for the open workspace folder(s). Follow them for this and every turn.',
  ];

  let injectedChars = 0;
  let omittedForBudget = 0;
  let anyInjected = false;

  for (const root of roots) {
    const found = await findRootContextFile(root, readFile);
    if (!found) {
      continue;
    }

    const injectable = resolveInjectableBody(found, root.rootId, optIns);
    if (!injectable) {
      // Oversized + not opted in: deliberately NOT injected. Visible in the
      // Settings UI as "detected but not injected (too large)"; no prompt note.
      logger.debug('Oversized workspace instructions file not injected (no per-root opt-in)', {
        chars: found.content.length,
        path: found.path,
        rootId: root.rootId,
      });
      continue;
    }

    if (injectedChars >= MAX_CONTEXT_FILES_TOTAL_CHARS) {
      omittedForBudget += 1;
      continue;
    }

    injectedChars += injectable.body.length;
    // Qualify the heading with the root so two roots that both ship an
    // `AGENTS.md` produce DISTINCT headings, not ambiguous identical ones.
    sections.push(
      `### ${root.displayName}/${found.path}\n${fenceContent(injectable.body)}${injectable.suffix}`
    );
    anyInjected = true;
  }

  if (!anyInjected && omittedForBudget === 0) {
    return null;
  }

  if (omittedForBudget > 0) {
    logger.warn('Workspace instruction files omitted to stay within the context budget', {
      omitted: omittedForBudget,
      totalChars: injectedChars,
    });
    const plural = omittedForBudget === 1 ? 'file' : 'files';
    sections.push(
      `[${omittedForBudget} more workspace instruction ${plural} omitted to stay within the context budget.]`
    );
  }

  return {
    id: `workspace-instructions-${Date.now()}`,
    parts: [{ text: sections.join('\n\n'), type: 'text' }],
    role: 'system',
  };
}

/**
 * PREPEND a `system` context message carrying the mounted roots' workspace
 * instructions files, when the feature is enabled and at least one file is
 * injectable. Returns the original array (same identity) when nothing is
 * injected, so the caller can pass it through with zero overhead.
 */
export async function injectWorkspaceInstructionsContext(
  messages: AgentMessage[],
  runtimeData: RuntimeData | undefined,
  readFile: WorkspaceFileReader
): Promise<AgentMessage[]> {
  const contextMessage = await buildWorkspaceInstructionsContextMessage(runtimeData, readFile);
  if (!contextMessage) {
    return messages;
  }
  return [contextMessage, ...messages];
}
