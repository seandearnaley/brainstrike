/**
 * ADR-0032 workspace trust, as the composer's prompt and Settings show it. A
 * folder's instructions, skills, slash commands and subagent personas load
 * only once the person trusts it; the agent host keeps each answer.
 */

/** The person's answer for a folder. */
export type WorkspaceTrustDecision = 'trusted' | 'restricted';

/** What trusting a folder would load, counted by the agent host's own scans. */
export interface WorkspaceAgentConfiguration {
  readonly commands: number;
  /** The workspace instructions file that would load (`AGENTS.md`, …); null when none. */
  readonly instructions: string | null;
  readonly personas: number;
  readonly skills: number;
}

/** One mounted folder: its trust and what trusting it would load. */
export interface WorkspaceTrustRoot {
  readonly agentConfiguration: WorkspaceAgentConfiguration;
  readonly displayName: string;
  /** The folder's absolute path; the host keys trust by it. */
  readonly path: string;
  readonly rootId: string;
  readonly trust: WorkspaceTrustDecision | 'undecided';
}

/** The agent host's trust reads and its one writer; absent where no host owns folders (web). */
export interface WorkspaceTrustCapability {
  listTrust(): Promise<readonly WorkspaceTrustRoot[]>;
  setTrust(path: string, trust: WorkspaceTrustDecision): Promise<void>;
}

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function counted(count: number, one: string, many: string): readonly string[] {
  if (count === 0) {
    return [];
  }
  return [`${count} ${count === 1 ? one : many}`];
}

/** The parts of a folder's agent configuration, in the order the prompt names them. */
export function workspaceAgentConfigurationParts(
  configuration: WorkspaceAgentConfiguration
): readonly string[] {
  return [
    ...(configuration.instructions === null ? [] : [configuration.instructions]),
    ...counted(configuration.skills, 'skill', 'skills'),
    ...counted(configuration.commands, 'slash command', 'slash commands'),
    ...counted(configuration.personas, 'subagent', 'subagents'),
  ];
}

/** "AGENTS.md, 2 skills, and 1 slash command"; empty when the folder holds none. */
export function describeWorkspaceAgentConfiguration(
  configuration: WorkspaceAgentConfiguration
): string {
  return LIST.format(workspaceAgentConfigurationParts(configuration));
}
