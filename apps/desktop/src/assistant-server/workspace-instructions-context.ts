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

/**
 * Normalized view of the renderer-supplied workspace-instructions preference. A
 * preference — not a security boundary — so a malformed field is NOT a hard 400;
 * it is DROPPED with a warn (never a silent coercion, per the no-silent-fallback
 * rule) and the fail-safe default applies: master ON, no oversized opt-ins.
 */
interface NormalizedWorkspaceInstructionsPreference {
  masterEnabled: boolean;
  oversizedOptInByRootId: Record<string, boolean>;
}

/** Keep only well-typed `true` opt-in entries; a malformed map warns and yields `{}`. */
function normalizeOptIns(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (value === undefined || value === null) {
    return result;
  }
  if (typeof value !== 'object') {
    logger.warn('Ignoring malformed workspaceInstructionsPreference.oversizedOptInByRootId', {
      received: typeof value,
    });
    return result;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === true && key.length > 0) {
      result[key] = true;
    }
  }
  return result;
}

/**
 * Strictly read the wire preference: a non-object preference, a non-boolean
 * `masterEnabled`, or a non-object opt-in map are each DROPPED with a warn rather
 * than silently coerced. Mirrors the permission-policy seam's "surface, never
 * silently repair" stance, but stays fail-safe (this is a preference, not a
 * security decision) — so the feature defaults ON on malformed input.
 */
function readWorkspaceInstructionsPreference(
  runtimeData: RuntimeData | undefined
): NormalizedWorkspaceInstructionsPreference {
  const raw: unknown = runtimeData?.workspaceInstructionsPreference;
  if (raw === undefined || raw === null) {
    return { masterEnabled: true, oversizedOptInByRootId: {} };
  }
  if (typeof raw !== 'object') {
    logger.warn('Ignoring malformed workspaceInstructionsPreference (not an object)', {
      received: typeof raw,
    });
    return { masterEnabled: true, oversizedOptInByRootId: {} };
  }
  const record = raw as Record<string, unknown>;
  let masterEnabled = true;
  const rawMaster = record['masterEnabled'];
  if (rawMaster !== undefined) {
    if (typeof rawMaster === 'boolean') {
      masterEnabled = rawMaster;
    } else {
      logger.warn(
        'Ignoring malformed workspaceInstructionsPreference.masterEnabled; defaulting ON',
        { received: typeof rawMaster }
      );
    }
  }
  return {
    masterEnabled,
    oversizedOptInByRootId: normalizeOptIns(record['oversizedOptInByRootId']),
  };
}

/**
 * Slice `text` to at most `maxChars` UTF-16 code units WITHOUT orphaning a
 * surrogate pair: if the boundary would fall between a high and low surrogate,
 * drop the trailing high surrogate so no lone surrogate (→ U+FFFD after
 * serialization) leaks into the prompt.
 */
function sliceWithoutSplittingSurrogate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const boundaryCode = text.charCodeAt(maxChars - 1);
  const isHighSurrogate = boundaryCode >= 0xd8_00 && boundaryCode <= 0xdb_ff;
  return text.slice(0, isHighSurrogate ? maxChars - 1 : maxChars);
}

export interface FoundContextFile {
  content: string;
  path: string;
  size: number;
}

/**
 * Heading label for a root's instructions block. Normally just the root's
 * `displayName`, but when SEVERAL mounted roots share the same displayName (e.g.
 * `/apps/service` and `/libs/service` both surface `service`), the bare
 * `### service/AGENTS.md` heading is identical for each and the model can't tell
 * them apart. Colliding names are qualified with the durable `(id <rootId>)` —
 * mirroring `resolveWorkspaceRoot`'s collision-resolution convention — while a
 * unique name keeps the simple heading.
 */
function rootHeadingLabel(
  root: RuntimeWorkspaceRoot,
  displayNameCounts: Map<string, number>
): string {
  const shared = (displayNameCounts.get(root.displayName) ?? 0) > 1;
  return shared ? `${root.displayName} (id ${root.rootId})` : root.displayName;
}

/**
 * Decide the injectable body + honest suffix for a found file under the
 * threshold-hybrid policy: a fits-the-budget file injects whole; an oversized
 * file injects TRUNCATED only when its root is opted in, else `null` (detected
 * but not injected — surfaced in Settings, no prompt note).
 *
 * Oversized opt-in is keyed by the durable DB `roots.id`. A DB-less LEGACY root
 * (synthesized from `workspaceRootPath` with `rootId` = the raw path — see
 * `getWorkspaceRoots`) can never appear in the Settings scan (which loads roots
 * from the DB only), so its opt-in is un-settable: `optIns[rawPath]` is never
 * `true` and an oversized file at such a root stays un-injected (fail-closed).
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
    body: sliceWithoutSplittingSurrogate(found.content, MAX_CONTEXT_FILE_CHARS),
    suffix: `\n[Truncated to the first ${MAX_CONTEXT_FILE_CHARS} characters — this file exceeds the per-file budget and was injected because you opted this workspace in.]`,
  };
}

/**
 * The outcome of resolving a root's first-match instructions file. A GENUINELY
 * absent candidate (ENOENT) is a normal try-next; a PRESENT-but-unreadable
 * candidate (binary, over the 2 MB read cap, containment violation, EACCES/EIO,
 * not-a-file) is an `error` — surfaced, NEVER fabricated into absence.
 */
export type RootContextFileResult =
  | { kind: 'found'; file: FoundContextFile }
  | { kind: 'none' }
  | { kind: 'error'; fileName: string; detail: string };

/**
 * Node's "file does not exist" signal — the ONLY reader failure that means
 * "genuinely absent, try the next candidate". The live reader's absent path
 * throws an ENOENT-coded error (from `realpath`); every other throw means the
 * file exists but cannot be read as text.
 */
function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Find the first-existing instructions file at a root's top level, in
 * {@link WORKSPACE_INSTRUCTIONS_FILE_NAMES} priority. A genuinely-absent
 * candidate (ENOENT) advances to the next name; a PRESENT-but-unreadable
 * candidate short-circuits to `{kind:'error'}` (first-match-wins, so the first
 * readable-or-unreadable candidate decides the root); an all-absent root yields
 * `{kind:'none'}`. Exported so the Settings scan reuses the exact same
 * resolution — and the same error surface — as the injection path.
 */
export async function findRootContextFile(
  root: RuntimeWorkspaceRoot,
  readFile: WorkspaceFileReader
): Promise<RootContextFileResult> {
  for (const name of WORKSPACE_INSTRUCTIONS_FILE_NAMES) {
    try {
      const file = await readFile({ requestedPath: name, rootPath: root.path });
      return { file: { content: file.content, path: file.path, size: file.size }, kind: 'found' };
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      const detail = error instanceof Error ? error.message : 'unknown error';
      return { detail, fileName: name, kind: 'error' };
    }
  }
  return { kind: 'none' };
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
  const preference = readWorkspaceInstructionsPreference(runtimeData);
  if (!preference.masterEnabled) {
    return null;
  }
  if (isLocalProvider(runtimeData)) {
    return null;
  }

  const roots = getWorkspaceRoots(runtimeData);
  if (roots.length === 0) {
    return null;
  }

  const optIns = preference.oversizedOptInByRootId;

  // Precompute displayName frequency so a heading is qualified with the root id
  // ONLY when the name collides across roots (see `rootHeadingLabel`).
  const displayNameCounts = new Map<string, number>();
  for (const root of roots) {
    displayNameCounts.set(root.displayName, (displayNameCounts.get(root.displayName) ?? 0) + 1);
  }

  const sections: string[] = [
    'The following workspace instruction files define the conventions and constraints for the open workspace folder(s). Follow them for this and every turn.',
  ];

  let injectedChars = 0;
  let omittedForBudget = 0;
  let anyInjected = false;

  for (const root of roots) {
    const result = await findRootContextFile(root, readFile);
    if (result.kind === 'none') {
      continue;
    }
    if (result.kind === 'error') {
      // Present-but-unreadable (binary, over the 2 MB cap, EACCES, …). Omit it
      // from context and surface the failure in the log — never a prompt note,
      // never fabricated absence. The Settings scan reports it as `error`.
      logger.warn('Workspace instructions file could not be read; omitted from context', {
        detail: result.detail,
        fileName: result.fileName,
        rootId: root.rootId,
      });
      continue;
    }
    const found = result.file;

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

    // Hard aggregate ceiling: count the file as omitted if adding it would
    // OVERSHOOT the budget, so the injected total never exceeds
    // MAX_CONTEXT_FILES_TOTAL_CHARS (a pre-check `>=` would allow one file's
    // worth of overshoot).
    if (injectedChars + injectable.body.length > MAX_CONTEXT_FILES_TOTAL_CHARS) {
      omittedForBudget += 1;
      continue;
    }

    injectedChars += injectable.body.length;
    // Qualify the heading with the root so two roots that both ship an
    // `AGENTS.md` produce DISTINCT headings, not ambiguous identical ones —
    // adding the root id only when the displayName itself collides.
    const headingLabel = rootHeadingLabel(root, displayNameCounts);
    sections.push(
      `### ${headingLabel}/${found.path}\n${fenceContent(injectable.body)}${injectable.suffix}`
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
