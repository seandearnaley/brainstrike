/**
 * Pure path/name policy for managed worktrees (spec §6.1 [D3], §6.2).
 *
 * Deliberately free of git/database/Electron dependencies so the whole policy
 * — including the BST-1342 containment refusal — is unit-testable.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorktreeExternalTool } from '@brainstrike/types';
import { UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES } from '@brainstrike/utils';

/**
 * In-root locations that are HARD-EXCLUDED from indexing and watching, so a
 * worktree may legitimately live there. Derived from the same shared policy
 * the indexer, native watcher, and live-grep prefilter consume, so an exemption
 * here cannot silently diverge from the exclusion floor.
 */
const EXCLUDED_IN_ROOT_PREFIXES = UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES;

const EXTERNAL_TOOL_DIRECTORIES: readonly (readonly [string, WorktreeExternalTool])[] = [
  ['.claude/worktrees', 'claude-code'],
  ['.codex/worktrees', 'codex'],
  ['.cursor/worktrees', 'cursor'],
];

const ADJECTIVES = [
  'amber',
  'bold',
  'brave',
  'bright',
  'calm',
  'clever',
  'crisp',
  'eager',
  'fleet',
  'gentle',
  'glad',
  'keen',
  'lucid',
  'merry',
  'nimble',
  'quiet',
  'rapid',
  'sharp',
  'solid',
  'spry',
  'steady',
  'sunny',
  'swift',
  'vivid',
] as const;

const NOUNS = [
  'anchor',
  'badger',
  'beacon',
  'cedar',
  'comet',
  'delta',
  'ember',
  'falcon',
  'fox',
  'harbor',
  'heron',
  'ivy',
  'lantern',
  'lynx',
  'maple',
  'meadow',
  'orbit',
  'otter',
  'pine',
  'quartz',
  'raven',
  'river',
  'summit',
  'willow',
] as const;

const NAME_ATTEMPTS = 64;

function normalize(candidate: string): string {
  return path.normalize(candidate).replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * True when `candidate` IS `container` or sits below it. NOTE: the sibling
 * `isWithinRoot(root, target)` in `workspace-path.ts` takes its arguments in
 * the OPPOSITE order — check which one you are calling.
 */
export function isPathWithin(candidate: string, container: string): boolean {
  const normalizedCandidate = normalize(candidate);
  const normalizedContainer = normalize(container);
  return (
    normalizedCandidate === normalizedContainer ||
    normalizedCandidate.startsWith(`${normalizedContainer}/`)
  );
}

/**
 * `<sanitized basename>-<8 hex of the common dir>`. The hash is what keeps two
 * checkouts named `app` from sharing one managed directory; the basename is
 * what makes the directory readable in Finder.
 */
export function repositorySlug(repositoryRoot: string, commonDir: string): string {
  const base = path
    .basename(normalize(repositoryRoot))
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const hash = createHash('sha256').update(normalize(commonDir)).digest('hex').slice(0, 8);
  return `${base || 'repo'}-${hash}`;
}

/**
 * An unused `adjective-noun` name. THROWS when the space is exhausted rather
 * than appending a numeric suffix: a silent `-2` is a fallback, and the caller
 * (the create sheet) can offer the user an explicit name instead.
 */
export function generateWorktreeName(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const bytes = new Uint32Array(2);
    crypto.getRandomValues(bytes);
    const adjective = ADJECTIVES[(bytes[0] ?? 0) % ADJECTIVES.length] as string;
    const noun = NOUNS[(bytes[1] ?? 0) % NOUNS.length] as string;
    const candidate = `${adjective}-${noun}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not generate an unused worktree name after ${NAME_ATTEMPTS} attempts.`);
}

/** `<managedDirectory>/<slug>/<name>`, with `name` pinned to one segment. */
export function resolveWorktreeTargetPath(
  managedDirectory: string,
  slug: string,
  name: string
): string {
  // Segment-based, never a `..` substring check (BST-1255): a name containing
  // any separator — or resolving to anything but itself — is rejected.
  if (name.length === 0 || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('Worktree name must be a single path segment.');
  }
  return path.join(managedDirectory, slug, name);
}

/**
 * BST-1342's lesson, enforced: a managed worktree inside a granted root would
 * be auto-validated, indexed and watched, and worktree churn flooding FSEvents
 * is what killed runs in the 2026-08-17 saturation failure. An in-root target
 * is REFUSED with the root named — never silently relocated — unless it sits
 * under a hard-excluded prefix, which is exactly the case the exclusion exists
 * for.
 */
export function assertWorktreeTargetOutsideRoots(
  target: string,
  rootPaths: readonly string[]
): void {
  for (const rootPath of rootPaths) {
    if (!isPathWithin(target, rootPath)) {
      continue;
    }
    const relative = normalize(target).slice(normalize(rootPath).length + 1);
    if (
      EXCLUDED_IN_ROOT_PREFIXES.some(
        (prefix) => relative === prefix || relative.startsWith(`${prefix}/`)
      )
    ) {
      continue;
    }
    throw new Error(
      `Managed worktrees must not live inside the granted folder "${rootPath}" — change the location in Settings → Workspace.`
    );
  }
}

/**
 * The LABEL spec §5.3 asks for — "Claude Code worktree", "Codex worktree" —
 * derived from the path. It is not provenance: an externally created worktree
 * is still `provenance: 'scanned'`.
 */
export function externalToolForPath(worktreePath: string): WorktreeExternalTool | null {
  const normalized = normalize(worktreePath);
  for (const [directory, tool] of EXTERNAL_TOOL_DIRECTORIES) {
    if (normalized.includes(`/${directory}/`)) {
      return tool;
    }
  }
  return null;
}
