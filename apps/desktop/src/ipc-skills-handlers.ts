/**
 * Agent Skills scan IPC handler (desktop / main-process).
 *
 * Runs the SAME bounded scan the assistant server uses to build the skills
 * engine (one parser — Settings status and live agent behavior can never
 * diverge) and maps every discovered entry (ok / invalid / shadowed) to the
 * serializable `SkillScanEntrySummary` contract for the Settings panel and
 * the composer's "/" menu. Invalid skills travel WITH their exact validation
 * errors so authors see why a skill did not load (fail closed, never silent).
 *
 * A DB failure does NOT abort discovery: global (`~`) skills need no roots, so
 * the failure is logged and the scan continues with an empty root set
 * (mirrors the user-commands handler).
 */

import { homedir } from 'node:os';
import type { SkillContentDeps, SkillScanEntry } from '@brainstrike/agent';
import { MAX_SKILL_FILE_BYTES, scanSkills } from '@brainstrike/agent';
import type {
  SkillScanEntrySummary,
  SkillsScanResultSummary,
} from '@brainstrike/assistant-contract';
import { createSecureSkillsFs } from './assistant-server/skills-fs-deps';
import type { WorkspaceRootsQueryable } from './assistant-server/workspace-roots';
import { resolveScanRoots } from './ipc-user-commands-handlers';

export interface SkillsScanHandlerDeps {
  /** Injected fs surface (SecureRoot-backed in production, in-memory in tests). */
  readonly fs: SkillContentDeps;
  /** Resolve the queryable DB, or null when it is unavailable. */
  readonly getDatabase: () => Promise<WorkspaceRootsQueryable | null>;
  /** The user's home directory (for `~/.brainstrike` / `~/.claude`). */
  readonly homedir: () => string;
}

function toSummary(entry: SkillScanEntry): SkillScanEntrySummary {
  if (entry.status === 'invalid') {
    return {
      absPath: entry.absPath,
      dirName: entry.dirName,
      errors: entry.errors,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.sourceRootDisplayName
        ? { sourceRootDisplayName: entry.sourceRootDisplayName }
        : {}),
      ...(entry.sourceRootId ? { sourceRootId: entry.sourceRootId } : {}),
      status: 'invalid',
      tier: entry.tier,
    };
  }
  const skill = entry.skill;
  return {
    absPath: skill.dirAbsPath,
    description: skill.description,
    dirName: skill.dirName,
    name: skill.name,
    preferenceKey: skill.preferenceKey,
    ...(entry.status === 'shadowed' ? { shadowedBy: entry.shadowedBy } : {}),
    ...(skill.sourceRootDisplayName ? { sourceRootDisplayName: skill.sourceRootDisplayName } : {}),
    ...(skill.sourceRootId ? { sourceRootId: skill.sourceRootId } : {}),
    status: entry.status,
    tier: skill.tier,
    userInvocable: skill.userInvocable,
    ...(skill.warnings.length > 0 ? { warnings: skill.warnings } : {}),
  };
}

export async function scanSkillsForRenderer(
  deps: SkillsScanHandlerDeps
): Promise<SkillsScanResultSummary> {
  const roots = await resolveScanRoots(deps.getDatabase);
  const result = scanSkills(
    { homeDir: deps.homedir(), roots },
    {
      listDir: deps.fs.listDir,
      readFile: (absFile) => deps.fs.readFileText(absFile, MAX_SKILL_FILE_BYTES),
    }
  );
  return { entries: result.entries.map(toSummary) };
}

/**
 * Production entry point: wires the real DB host, home dir, and SecureRoot fs.
 * The DB loader is imported lazily so this module stays cheap to import at
 * main registration time.
 */
export function createSkillsScanHandler(): () => Promise<SkillsScanResultSummary> {
  return async () => {
    const getDatabase = async () => {
      const { getDatabase: resolve } = await import('./db-main');
      return resolve();
    };
    const roots = await resolveScanRoots(getDatabase);
    const filesystem = createSecureSkillsFs([...roots.map((root) => root.absPath), homedir()]);
    const result = scanSkills(
      { homeDir: homedir(), roots },
      {
        listDir: filesystem.listDir,
        readFile: (absFile) => filesystem.readFileText(absFile, MAX_SKILL_FILE_BYTES),
      }
    );
    return { entries: result.entries.map(toSummary) };
  };
}
