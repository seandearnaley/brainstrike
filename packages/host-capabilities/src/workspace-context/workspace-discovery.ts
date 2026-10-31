/**
 * ADR-0029 stage 2: the host's skills, user slash command, persona and
 * workspace instructions discovery for Settings and the composer's "/" menu
 * (`workspace/skills`, `workspace/commands`, `workspace/personas`,
 * `workspace/context-files`).
 *
 * Skills use the same bounded scan as a run's admission (one parser, so the
 * Settings status and a run's skills cannot diverge). Every discovered entry
 * (ok / invalid / shadowed) is reported; invalid skills carry their exact
 * validation errors so authors see why a skill did not load.
 *
 * A root read failure rejects discovery. An empty root list still scans the
 * home directory's global skills and commands.
 *
 * ADR-0032: the project tiers come only from roots the person trusted, and
 * `workspace/trust/list` counts what each live root would contribute once
 * trusted, with the same scans.
 */

import { homedir } from 'node:os';
import type { SkillContentDeps, SkillScanEntry } from '@brainstrike/agent';
import { MAX_SKILL_FILE_BYTES, scanSkills } from '@brainstrike/agent';
import type { HostWorkspaceDiscovery, HostWorkspaceTrustRoot } from '@brainstrike/agent-host';
import {
  type HostWorkspaceTrustStore,
  readHostWorkspaceTrust,
  trustedHostWorkspaceRoots,
} from '@brainstrike/agent-host/workspace-trust';
import type {
  AssistantPersonasListResult,
  ProviderCredential,
  RuntimeWorkspaceRoot,
  SkillScanEntrySummary,
  SkillsScanResultSummary,
  UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import {
  createNodeFsScanDeps,
  scanUserPersonas,
  scanUserSlashCommands,
  type UserSlashCommandScanDeps,
  type UserSlashCommandScanRoot,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/ports';
import { readWorkspaceTextFile } from '../native-tools/workspace-text-file-reader.ts';
import {
  inspectPersonaAvailability,
  type PersonaAvailabilityInputs,
} from './persona-availability.ts';
import { listUserPersonas } from './personas-list.ts';
import { createSecureSkillsFs } from './skills-fs.ts';
import { findRootContextFile } from './workspace-instructions-context.ts';
import { scanWorkspaceContextFiles } from './workspace-instructions-scan.ts';

/** The live roots, read as a run's admission reads them. */
export type DiscoveryRoots = (signal: AbortSignal) => Promise<readonly RuntimeWorkspaceRoot[]>;

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

export interface SkillsDiscoveryDeps {
  /** SecureRoot-backed in production, in-memory in tests. */
  readonly fs: (containmentRoots: readonly string[]) => SkillContentDeps;
  /** The user's home directory (for `~/.brainstrike` / `~/.claude`). */
  readonly homedir: () => string;
  readonly roots: DiscoveryRoots;
}

export async function discoverSkills(
  deps: SkillsDiscoveryDeps,
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

export interface CommandsDiscoveryDeps {
  /** Real disk in production (closed after the scan), in-memory in tests. */
  readonly fs: () => UserSlashCommandScanDeps & { dispose(): void };
  readonly homedir: () => string;
  readonly roots: DiscoveryRoots;
}

export async function discoverCommands(
  deps: CommandsDiscoveryDeps,
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

export interface WorkspaceTrustDeps {
  readonly commands: CommandsDiscoveryDeps['fs'];
  readonly homedir: () => string;
  readonly readFile: WorkspaceFileReader;
  readonly roots: DiscoveryRoots;
  readonly skills: SkillsDiscoveryDeps['fs'];
  readonly trust: HostWorkspaceTrustStore;
}

/** How many of `entries` a root contributes, by the owning root each scan records. */
function countByRoot(
  entries: readonly { readonly sourceRootId?: string | undefined }[]
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { sourceRootId } of entries) {
    if (sourceRootId !== undefined) {
      counts.set(sourceRootId, (counts.get(sourceRootId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Each live root's trust and what trusting it would load. Counting reads a
 * restricted root's files with the scans' own bounded readers, but nothing
 * read here reaches a prompt or a tool.
 */
export async function discoverWorkspaceTrust(
  deps: WorkspaceTrustDeps,
  signal: AbortSignal
): Promise<{ readonly roots: HostWorkspaceTrustRoot[] }> {
  const live = await deps.roots(signal);
  const roots = async (): Promise<readonly RuntimeWorkspaceRoot[]> => live;
  const skills = await discoverSkills({ fs: deps.skills, homedir: deps.homedir, roots }, signal);
  // The command scan keeps only the first root's copy of an id, so each root is
  // scanned alone: another folder's command must not hide this one's.
  const commandCounts = new Map(
    await Promise.all(
      live.map(async (root) => {
        const { commands } = await discoverCommands(
          { fs: deps.commands, homedir: deps.homedir, roots: async () => [root] },
          signal
        );
        return [root.rootId, countByRoot(commands).get(root.rootId) ?? 0] as const;
      })
    )
  );
  const filesystem = deps.commands();
  let personas: ReturnType<typeof scanUserPersonas>;
  try {
    personas = scanUserPersonas({ homeDir: deps.homedir(), roots: scanRoots(live) }, filesystem);
  } finally {
    filesystem.dispose();
  }
  const skillCounts = countByRoot(skills.entries.filter((entry) => entry.status !== 'invalid'));
  const personaCounts = countByRoot(personas.entries.filter((entry) => entry.status !== 'invalid'));
  return {
    roots: await Promise.all(
      live.map(async (root): Promise<HostWorkspaceTrustRoot> => {
        const instructions = await findRootContextFile(root, deps.readFile);
        signal.throwIfAborted();
        return {
          agentConfiguration: {
            commands: commandCounts.get(root.rootId) ?? 0,
            // A present but unreadable file is still the folder's, and is named.
            instructions:
              instructions.kind === 'found'
                ? instructions.file.path
                : instructions.kind === 'error'
                  ? instructions.fileName
                  : null,
            personas: personaCounts.get(root.rootId) ?? 0,
            skills: skillCounts.get(root.rootId) ?? 0,
          },
          displayName: root.displayName,
          path: root.path,
          rootId: root.rootId,
          trust: await readHostWorkspaceTrust(deps.trust, root.path),
        };
      })
    ),
  };
}

/** The facts persona availability reads: the host's model catalog, MCP tools and credentials. */
export interface PersonaAvailabilityReads {
  catalogModel(
    target: { readonly model: string; readonly provider: string },
    signal: AbortSignal
  ): Promise<{ readonly type: string | null } | null>;
  /** Each discovered MCP tool id and whether it is enabled. */
  mcpTools(): Promise<ReadonlyMap<string, boolean>>;
  readCredential(provider: string): Promise<ProviderCredential | undefined>;
}

export interface PersonasDiscoveryDeps {
  readonly availability: PersonaAvailabilityReads;
  readonly fs: CommandsDiscoveryDeps['fs'];
  readonly homedir: () => string;
  readonly roots: DiscoveryRoots;
}

/** Every persona with the host's preflight facts; each provider's credential is read once. */
export async function discoverPersonas(
  deps: PersonasDiscoveryDeps,
  signal: AbortSignal
): Promise<AssistantPersonasListResult> {
  const roots = await deps.roots(signal);
  const mcpTools = await deps.availability.mcpTools();
  const credentials = new Map<string, Promise<ProviderCredential | undefined>>();
  const inputs: PersonaAvailabilityInputs = {
    catalogModel: (target) => deps.availability.catalogModel(target, signal),
    mcpTools,
    readCredential: (provider) => {
      let credential = credentials.get(provider);
      if (!credential) {
        credential = deps.availability.readCredential(provider);
        credentials.set(provider, credential);
      }
      return credential;
    },
  };
  const filesystem = deps.fs();
  try {
    return await listUserPersonas({
      fs: filesystem,
      homedir: deps.homedir,
      inspectAvailability: (persona) => inspectPersonaAvailability(persona, inputs),
      roots,
    });
  } finally {
    filesystem.dispose();
  }
}

export interface HostWorkspaceDiscoveryOptions {
  /** The facts Settings › Subagents checks each persona against. */
  readonly personaAvailability: PersonaAvailabilityReads;
  /** The live roots, read as a run's admission reads them. */
  readonly roots: DiscoveryRoots;
  readonly trust: HostWorkspaceTrustStore;
}

export function hostWorkspaceDiscovery(
  options: HostWorkspaceDiscoveryOptions
): HostWorkspaceDiscovery {
  const { roots, trust } = options;
  // ADR-0032: the home tiers always; a root's project tiers once the person trusts it.
  const trusted: DiscoveryRoots = async (signal) =>
    await trustedHostWorkspaceRoots(trust, await roots(signal));
  return {
    commands: (signal) =>
      discoverCommands({ fs: createNodeFsScanDeps, homedir, roots: trusted }, signal),
    contextFiles: async (signal) => ({
      files: await scanWorkspaceContextFiles(await trusted(signal), readWorkspaceTextFile),
    }),
    personas: (signal) =>
      discoverPersonas(
        {
          availability: options.personaAvailability,
          fs: createNodeFsScanDeps,
          homedir,
          roots: trusted,
        },
        signal
      ),
    skills: (signal) =>
      discoverSkills({ fs: createSecureSkillsFs, homedir, roots: trusted }, signal),
    trust: (signal) =>
      discoverWorkspaceTrust(
        {
          commands: createNodeFsScanDeps,
          homedir,
          readFile: readWorkspaceTextFile,
          roots,
          skills: createSecureSkillsFs,
          trust,
        },
        signal
      ),
  };
}
