/**
 * ADR-0029 stage 2: the host's skills and user slash command discovery for the
 * Settings → Skills panel and the composer's "/" menu (`workspace/skills`,
 * `workspace/commands`).
 *
 * Skills use the same bounded scan as a run's admission (one parser, so the
 * Settings status and a run's skills cannot diverge). Every discovered entry
 * (ok / invalid / shadowed) is reported; invalid skills carry their exact
 * validation errors so authors see why a skill did not load.
 *
 * A root read failure rejects discovery. An empty root list still scans the
 * home directory's global skills and commands.
 */

import { homedir } from 'node:os';
import type { SkillContentDeps, SkillScanEntry } from '@brainstrike/agent';
import { MAX_SKILL_FILE_BYTES, scanSkills } from '@brainstrike/agent';
import type { HostWorkspaceDiscovery } from '@brainstrike/agent-host';
import type {
  RuntimeWorkspaceRoot,
  SkillScanEntrySummary,
  SkillsScanResultSummary,
  UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import { createNodeFsScanDeps } from '../assistant-server/node-fs-scan-deps';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';
import {
  scanUserSlashCommands,
  type UserSlashCommandScanDeps,
  type UserSlashCommandScanRoot,
} from '../assistant-server/user-slash-commands-loader';

/** The live roots, read as a run's admission reads them. */
export type DesktopDiscoveryRoots = (
  signal: AbortSignal
) => Promise<readonly RuntimeWorkspaceRoot[]>;

function scanRoots(roots: readonly RuntimeWorkspaceRoot[]): UserSlashCommandScanRoot[] {
  return roots.map((root) => ({
    absPath: root.path,
    displayName: root.displayName,
    id: root.rootId,
  }));
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

export interface DesktopSkillsDiscoveryDeps {
  /** SecureRoot-backed in production, in-memory in tests. */
  readonly fs: (containmentRoots: readonly string[]) => SkillContentDeps;
  /** The user's home directory (for `~/.brainstrike` / `~/.claude`). */
  readonly homedir: () => string;
  readonly roots: DesktopDiscoveryRoots;
}

export async function discoverDesktopSkills(
  deps: DesktopSkillsDiscoveryDeps,
  signal: AbortSignal
): Promise<SkillsScanResultSummary> {
  const roots = scanRoots(await deps.roots(signal));
  const home = deps.homedir();
  const filesystem = deps.fs([...roots.map((root) => root.absPath), home]);
  const result = scanSkills(
    { homeDir: home, roots },
    {
      listDir: filesystem.listDir,
      readFile: (absFile) => filesystem.readFileText(absFile, MAX_SKILL_FILE_BYTES),
    }
  );
  return { entries: result.entries.map(toSummary) };
}

export interface DesktopCommandsDiscoveryDeps {
  /** Real disk in production (closed after the scan), in-memory in tests. */
  readonly fs: () => UserSlashCommandScanDeps & { dispose(): void };
  readonly homedir: () => string;
  readonly roots: DesktopDiscoveryRoots;
}

export async function discoverDesktopCommands(
  deps: DesktopCommandsDiscoveryDeps,
  signal: AbortSignal
): Promise<UserSlashCommandsListResult> {
  const roots = scanRoots(await deps.roots(signal));
  const filesystem = deps.fs();
  try {
    return {
      commands: scanUserSlashCommands({ homeDir: deps.homedir(), roots }, filesystem),
      roots: roots.map((root) => ({ displayName: root.displayName, id: root.id })),
    };
  } finally {
    filesystem.dispose();
  }
}

export function desktopWorkspaceDiscovery(roots: DesktopDiscoveryRoots): HostWorkspaceDiscovery {
  return {
    commands: (signal) =>
      discoverDesktopCommands({ fs: createNodeFsScanDeps, homedir, roots }, signal),
    skills: (signal) => discoverDesktopSkills({ fs: createSecureSkillsFs, homedir, roots }, signal),
  };
}
