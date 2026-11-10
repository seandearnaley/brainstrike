/**
 * ADR-0032 workspace trust, as the composer's chip and Settings show it. A
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
  /**
   * The folder whose answer this one shares, when it is not its own: a managed
   * worktree's repository (ADR-0034 decision 6). `path` is that folder's listed
   * `path` when it is open too.
   */
  readonly answeredBy?: { readonly displayName: string; readonly path: string } | undefined;
  readonly displayName: string;
  /** The folder's absolute path; the host resolves the answer it shares from it. */
  readonly path: string;
  readonly rootId: string;
  readonly trust: WorkspaceTrustDecision | 'undecided';
}

/** One answer the person gives: the folder it is recorded for and the open folders it covers. */
export interface WorkspaceTrustAnswer {
  readonly displayName: string;
  /** The answering folder's absolute path; an answer is set through it. */
  readonly path: string;
  /** The open folders this answer covers, in the host's order. */
  readonly roots: readonly WorkspaceTrustRoot[];
  /** A repository's answer, which a managed worktree among `roots` shares. */
  readonly sharedWithWorktrees: boolean;
  readonly trust: WorkspaceTrustRoot['trust'];
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

/** How many instructions files, skills, slash commands and subagents a folder holds. */
export function countWorkspaceAgentConfiguration(
  configuration: WorkspaceAgentConfiguration
): number {
  return (
    (configuration.instructions === null ? 0 : 1) +
    configuration.skills +
    configuration.commands +
    configuration.personas
  );
}

/**
 * The answers behind `roots`, in the order their first folder is listed. A
 * managed worktree and its repository share one, so they are asked about and
 * shown once, under the repository's name.
 */
export function workspaceTrustAnswers(
  roots: readonly WorkspaceTrustRoot[]
): readonly WorkspaceTrustAnswer[] {
  const byPath = new Map<string, WorkspaceTrustRoot[]>();
  for (const root of roots) {
    const path = root.answeredBy?.path ?? root.path;
    byPath.set(path, [...(byPath.get(path) ?? []), root]);
  }
  return [...byPath].map(([path, covered]) => {
    const first = covered[0] as WorkspaceTrustRoot;
    return {
      displayName: first.answeredBy?.displayName ?? first.displayName,
      path,
      roots: covered,
      sharedWithWorktrees: covered.some((root) => root.answeredBy !== undefined),
      trust: first.trust,
    };
  });
}

/** "AGENTS.md, 2 skills, and 1 slash command"; empty when the folder holds none. */
export function describeWorkspaceAgentConfiguration(
  configuration: WorkspaceAgentConfiguration
): string {
  return LIST.format(workspaceAgentConfigurationParts(configuration));
}
