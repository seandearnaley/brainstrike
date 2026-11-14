/**
 * ADR-0040: the memory tool's paths. Every path names `/memories` or a path
 * under it, as Anthropic's memory tool does; the folder behind it is the
 * project's, so the tool never reaches anything else. These checks say why a
 * path is refused; the workspace path resolver then keeps every read and
 * write inside the folder through symlinks.
 */
import { ToolInputError } from '@brainstrike/assistant-contract';

/** The root every memory path names, as the vendor's tool does. */
export const MEMORY_ROOT = '/memories';
/** The index the host keeps from the notes; the model only reads it. */
export const MEMORY_INDEX_FILE = 'MEMORY.md';

function outside(raw: string): ToolInputError {
  return new ToolInputError(`Error: The path ${raw} is outside ${MEMORY_ROOT}.`);
}

/**
 * The path under the memory folder that a tool path names (`''` is the folder
 * itself). Refused: anything not under `/memories`, a `.` or `..` segment, a
 * percent-encoded path (an encoded `..` would be one), and a hidden name or
 * `node_modules`, which the vendor's listing leaves out.
 */
export function memoryRelativePath(raw: string): string {
  const forward = raw.trim().replace(/\\/gu, '/');
  if (forward.includes('%')) {
    throw outside(raw);
  }
  if (!(forward === MEMORY_ROOT || forward.startsWith(`${MEMORY_ROOT}/`))) {
    throw outside(raw);
  }
  const segments = forward
    .slice(MEMORY_ROOT.length)
    .split('/')
    .filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw outside(raw);
    }
    if (segment.startsWith('.') || segment.toLowerCase() === 'node_modules') {
      throw new ToolInputError(
        `Error: The path ${raw} names a hidden item, which memory keeps none of.`
      );
    }
  }
  return segments.join('/');
}

/**
 * Whether a path under the memory folder names the index: a segment that is
 * `MEMORY.md` in any case, which a case-insensitive volume writes as the index.
 */
export function namesMemoryIndex(relative: string): boolean {
  const index = MEMORY_INDEX_FILE.toLowerCase();
  return relative.split('/').some((segment) => segment.toLowerCase() === index);
}

/** The tool's spelling of a path under the memory folder. */
export function memoryToolPath(relative: string): string {
  return relative === '' ? MEMORY_ROOT : `${MEMORY_ROOT}/${relative}`;
}
