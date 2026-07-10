/**
 * Pure handler logic for the hooks review IPC (dependency-injected fs for
 * testability). The renderer's Hooks settings panel calls this to display a
 * project root's `.brainstrike/hooks.json` for review before approval; the
 * server remains the trust authority (it re-hashes disk on every request).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { getProjectHooksPath } from './assistant-server/hooks/config';

export interface ProjectHooksReview {
  readonly content?: string;
  readonly error?: string;
  readonly exists: boolean;
  readonly parseError?: string;
  readonly path: string;
  readonly rootId: string;
  readonly sha256?: string;
}

export interface HooksReviewDeps {
  readonly readFile?: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getProjectHooksForReview(
  rootId: unknown,
  absPath: unknown,
  deps: HooksReviewDeps = {}
): ProjectHooksReview {
  const read = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  if (typeof rootId !== 'string' || rootId.length === 0) {
    return { error: 'rootId must be a non-empty string', exists: false, path: '', rootId: '' };
  }
  if (typeof absPath !== 'string' || absPath.trim().length === 0 || !isAbsolute(absPath.trim())) {
    return {
      error: 'root path must be a non-empty absolute path',
      exists: false,
      path: '',
      rootId,
    };
  }

  const path = getProjectHooksPath(absPath.trim());
  let content: string;
  try {
    content = read(path);
  } catch {
    return { exists: false, path, rootId };
  }

  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  let parseError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      parseError = 'root of hooks.json must be a JSON object';
    }
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  return {
    content,
    exists: true,
    path,
    rootId,
    sha256,
    ...(parseError ? { parseError } : {}),
  };
}
