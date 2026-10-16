/**
 * SecureRoot-backed fs surface for Agent Skills (desktop main process).
 *
 * Skill files are UNTRUSTED repo content, so every operation goes through the
 * native `SecureRoot` capability (POSIX component-wise `openat(O_NOFOLLOW)`,
 * Windows handle-relative `NtCreateFile` — same spine as the slash-commands
 * loader): a symlink under a skills dir cannot escape its containment root,
 * and roots cannot borrow one another's trust. There is no path-based
 * fallback; missing native support fails closed (reads report `unreadable`).
 *
 * Handles are opened per call and closed immediately — skills reads are
 * infrequent (a scan per request plus occasional tool reads), so leak-proof
 * statelessness beats a cached-handle lifecycle. Reads are BYTE-bounded before
 * any untrusted content enters main-process memory:
 * - text reads at 4× {@link MAX_SKILL_CONTENT_FILE_CHARS} (a file at/under the
 *   char cap can never exceed it — see the commands loader's bytes-vs-chars
 *   rationale),
 * - byte reads at {@link MAX_SKILL_ASSET_BYTES}.
 *
 * The workspace credential floor holds here as in every agent tool: a
 * credential file inside a skill is never listed and never opened.
 */

import path from 'node:path';
import type { SkillContentDeps } from '@brainstrike/agent';
import { MAX_SKILL_ASSET_BYTES, MAX_SKILL_CONTENT_FILE_CHARS } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import { SecureRoot } from '@brainstrike/secure-fs-native';
import { isWorkspaceSecretFile } from '@brainstrike/utils';

const logger = createLogger('AssistantSkills');

const MAX_SKILL_TEXT_READ_BYTES = MAX_SKILL_CONTENT_FILE_CHARS * 4;

/** A relative path that stays inside its root (no `..` escape, not absolute). */
function containedRelative(containmentRoot: string, absPath: string): string | null {
  const relative = path.relative(containmentRoot, absPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function withSecureRoot<T>(containmentRoot: string, operate: (root: SecureRoot) => T): T | null {
  let root: SecureRoot | null = null;
  try {
    root = new SecureRoot(containmentRoot);
    return operate(root);
  } catch {
    return null;
  } finally {
    root?.close();
  }
}

/**
 * Build the skills fs surface over a fixed set of candidate containment roots
 * (the mounted workspace roots plus the home dir). Reads resolve their
 * containment root by longest match over the candidates; a path outside every
 * candidate is refused (fail closed).
 */
export function createSecureSkillsFs(candidateRoots: readonly string[]): SkillContentDeps {
  const normalizedRoots = [...new Set(candidateRoots.map((root) => path.normalize(root)))];

  function resolveContainment(absFile: string): { relative: string; root: string } | null {
    let best: { relative: string; root: string } | null = null;
    for (const root of normalizedRoots) {
      const relative = containedRelative(root, absFile);
      if (relative !== null && (best === null || root.length > best.root.length)) {
        best = { relative, root };
      }
    }
    if (!best) {
      logger.warn('Refused skill file read outside every containment root');
      return null;
    }
    if (isWorkspaceSecretFile(best.relative)) {
      logger.warn('Refused skill credential file read');
      return null;
    }
    return best;
  }

  return {
    listDir: (absDir, containmentRoot, maxEntries) => {
      const relative = containedRelative(path.normalize(containmentRoot), path.normalize(absDir));
      if (relative === null) {
        logger.warn('Refused skill directory listing outside its containment root');
        return null;
      }
      const listed = withSecureRoot(path.normalize(containmentRoot), (root) =>
        root.listDir(relative || '.', maxEntries)
      );
      return (
        listed && {
          ...listed,
          entries: listed.entries.filter(
            (entry) => !(entry.isFile && isWorkspaceSecretFile(path.join(relative, entry.name)))
          ),
        }
      );
    },
    readFileBytes: (absFile) => {
      const resolved = resolveContainment(path.normalize(absFile));
      if (!resolved) {
        return { ok: false, reason: 'unreadable' };
      }
      const read = withSecureRoot(resolved.root, (root) =>
        root.readFile(resolved.relative, MAX_SKILL_ASSET_BYTES)
      );
      if (!read) {
        return { ok: false, reason: 'unreadable' };
      }
      if (read.status !== 'ok') {
        return {
          ok: false,
          reason: read.status === 'oversized' ? 'oversized' : 'unreadable',
        };
      }
      return { content: new Uint8Array(read.content), ok: true };
    },
    readFileText: (absFile, maxBytes = MAX_SKILL_TEXT_READ_BYTES) => {
      const resolved = resolveContainment(path.normalize(absFile));
      if (!resolved) {
        return { ok: false, reason: 'unreadable' };
      }
      const read = withSecureRoot(resolved.root, (root) =>
        root.readFile(resolved.relative, Math.min(maxBytes, MAX_SKILL_TEXT_READ_BYTES))
      );
      if (!read) {
        return { ok: false, reason: 'unreadable' };
      }
      if (read.status !== 'ok') {
        return {
          ok: false,
          reason: read.status === 'oversized' ? 'oversized' : 'unreadable',
        };
      }
      return { content: read.content.toString('utf8'), ok: true };
    },
  };
}
