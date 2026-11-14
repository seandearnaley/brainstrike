/**
 * ADR-0040: the index of a project's notes, which the host writes from the
 * note files after every change, and the part of it a run loads.
 */
import path from 'node:path';

/** How much of the index a run loads, as Claude Code loads its auto memory index. */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_CHARS = 25_000;
const HOOK_MAX_CHARS = 150;

/** A note's title: its first `# ` heading, else its file name. */
export function memoryNoteTitle(relative: string, text: string): string {
  for (const line of text.split('\n')) {
    const heading = /^#\s+(.+)$/u.exec(line.trim());
    if (heading?.[1]) {
      return heading[1].trim();
    }
    if (line.trim() !== '' && !line.startsWith('---')) {
      break;
    }
  }
  return path.posix.basename(relative).replace(/\.[^.]+$/u, '') || relative;
}

/** A note's hook: its first line of text that is not a heading, cut to one short line. */
function memoryNoteHook(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '' && !candidate.startsWith('#') && candidate !== '---');
  if (line === undefined) {
    return '';
  }
  return line.length > HOOK_MAX_CHARS ? `${line.slice(0, HOOK_MAX_CHARS - 1)}…` : line;
}

/** One note's index line: title, path and hook, marked when untrusted context wrote it. */
export function memoryIndexLine(relative: string, text: string, untrusted: boolean): string {
  const title = memoryNoteTitle(relative, text).replace(/[[\]]/gu, '');
  const hook = memoryNoteHook(text);
  return `- [${title}](${relative})${hook ? ` — ${hook}` : ''}${untrusted ? ' (untrusted)' : ''}`;
}

/**
 * The part of the index a run loads: its first 200 lines or 25,000
 * characters, whichever comes first, cut at a line, with a marker that says
 * how much is left out.
 */
export function loadedMemoryIndex(index: string): string {
  const lines = index.replace(/\n+$/u, '').split('\n');
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (
      kept.length === MEMORY_INDEX_MAX_LINES ||
      chars + line.length + 1 > MEMORY_INDEX_MAX_CHARS
    ) {
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }
  if (kept.length === lines.length) {
    return kept.join('\n');
  }
  return [
    ...kept,
    `[Index cut: ${lines.length - kept.length} of ${lines.length} lines not loaded. view /memories lists every note.]`,
  ].join('\n');
}
