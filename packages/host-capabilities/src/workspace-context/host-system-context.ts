import type { AgentMessage, RuntimeData, ScannedWorkspaceSkills } from '@brainstrike/agent';
import {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildDefaultInstructions,
  type DelegationPersonaSummary,
  filterToolsForPlanMode,
  formatSkillsCatalog,
  injectWorkspaceRootManifestContext,
} from '@brainstrike/agent/tool-runtime';
import { type HostRunIntentRequest, hostToolDiscoveryEnabled } from '@brainstrike/agent-host';
import {
  isSupportedProvider,
  type ReferencedFileFailure,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/ports';
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import { readWorkspaceTextFile } from '../native-tools/workspace-text-file-reader.ts';
import {
  type AttachedMentionFolders,
  readReferencedFilesContext,
} from './referenced-files-context.ts';
import { injectActivatedSkillsContext } from './skills-activation-context.ts';
import { injectWorkspaceInstructionsContext } from './workspace-instructions-context.ts';

const planModeLogger = createLogger('HostPlanMode');

/** Plan mode keeps what reads (and MCP), the shipped plan-mode gate's rule. */
export function hostPlanModeTools<
  T extends { readonly permissionToolId?: string; readonly risk: ToolRiskCategory },
>(tools: Readonly<Record<string, T>>): Record<string, T> {
  const entries = Object.entries(tools);
  return filterToolsForPlanMode(
    { ...tools },
    new Map(entries.map(([name, tool]) => [name, tool.permissionToolId ?? name])),
    Object.fromEntries(entries.map(([name, tool]) => [tool.permissionToolId ?? name, tool.risk])),
    planModeLogger
  );
}

/** The root run's system text, and the host context a delegated child receives. */
export interface HostSystemContext {
  /** BST-1932: date, skills and injected workspace context, never the root's supervisor text. */
  readonly childSystem?: string | undefined;
  readonly referencedFileFailures?: readonly ReferencedFileFailure[];
  readonly system?: string | undefined;
}

function joinedSections(sections: readonly (string | null | undefined)[]): string | undefined {
  const text = sections.filter((section): section is string => Boolean(section)).join('\n\n');
  return text || undefined;
}

/** Existing readers and public vendor formatting; this creates no transcript or loop. */
export async function readHostSystemContext(options: {
  /** BST-2018: mentioned files in live folders outside the thread, attached for this run. */
  readonly attachedMentions?: AttachedMentionFolders;
  /** ADR-0032: the run's roots the person trusted, the only ones whose instructions load. */
  readonly configurationRoots: NonNullable<RuntimeData['workspaceRoots']>;
  readonly inputTokenLimit: number;
  /** BST-1932: the personas the run may delegate to, named in the supervisor instructions. */
  readonly personas?: readonly DelegationPersonaSummary[];
  /** Plan mode: the instructions say the run may only read and propose a plan. */
  readonly planMode: boolean;
  /** ADR-0040: the run's project memory, whose section ends the instructions. */
  readonly projectMemory?: { readonly childSection: string; readonly section: string };
  readonly readWorkspaceFile?: WorkspaceFileReader;
  readonly request: HostRunIntentRequest;
  readonly runtime: RuntimeData;
  /** The admitted tools by provider name; the instructions name each by its catalog id. */
  readonly tools: Readonly<
    Record<string, { readonly description: string; readonly permissionToolId?: string }>
  >;
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}): Promise<HostSystemContext> {
  if (options.request.snapshot) {
    // Recovery (and a wake) consumes the already committed text, without re-reading files.
    const committed = options.request.snapshot.configuration;
    const system = wireDecoder(Schema.optional(Schema.String), {
      errors: 'all',
      onExcessProperty: 'error',
    })(committed['system']);
    const childSystem = wireDecoder(Schema.optional(Schema.String), {
      errors: 'all',
      onExcessProperty: 'error',
    })(committed['childSystem']);
    return {
      ...(childSystem === undefined ? {} : { childSystem }),
      ...(system === undefined ? {} : { system }),
    };
  }
  const names = new Map(
    Object.entries(options.tools).map(([name, tool]) => [name, tool.permissionToolId ?? name])
  );
  const date = buildCurrentDateNote(new Date());
  const sections: (string | null)[] = [
    buildDefaultInstructions(names, {
      planMode: options.planMode,
      // The same gate the admission uses to defer these tools behind discovery.
      toolDiscoveryEnabled:
        isSupportedProvider(options.runtime.provider) &&
        hostToolDiscoveryEnabled({
          modelId: options.request.modelId,
          provider: options.runtime.provider,
          tools: options.tools,
        }),
      ...(options.personas?.length
        ? { backgroundDelegation: true, personas: options.personas }
        : {}),
    }),
    date,
    buildContextBudgetNote(options.inputTokenLimit),
  ];
  const shared: (string | null)[] = [date];
  const workspace = await readHostWorkspaceContext({
    ...(options.attachedMentions ? { attachedMentions: options.attachedMentions } : {}),
    configurationRoots: options.configurationRoots,
    prompt: options.request.prompt ?? '',
    ...(options.readWorkspaceFile ? { readWorkspaceFile: options.readWorkspaceFile } : {}),
    runtime: options.runtime,
    ...(options.workspaceSkills ? { workspaceSkills: options.workspaceSkills } : {}),
  });
  if (workspace.skillsCatalog) {
    sections.push(workspace.skillsCatalog);
    shared.push(workspace.skillsCatalog);
  }
  const { injected, referencedFileFailures } = workspace;
  options.request.signal.throwIfAborted();
  // ADR-0040: the project's memory index follows the stable instructions.
  const system = joinedSections([...sections, ...injected, options.projectMemory?.section]);
  const childSystem = options.personas?.length
    ? joinedSections([...shared, ...injected, options.projectMemory?.childSection])
    : undefined;
  return {
    ...(referencedFileFailures.length ? { referencedFileFailures } : {}),
    ...(childSystem === undefined ? {} : { childSystem }),
    ...(system === undefined ? {} : { system }),
  };
}

/**
 * ADR-0028 step 3b: the context a person's message read mid-run calls for, as
 * a run's admission reads it for its own prompt: the files it mentions and the
 * skills it activates. The run's instructions already carry the rest.
 */
export async function readHostPromptContext(options: {
  readonly attachedMentions?: AttachedMentionFolders;
  readonly prompt: string;
  readonly readWorkspaceFile?: WorkspaceFileReader;
  readonly runtime: RuntimeData;
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}): Promise<{
  readonly context?: string;
  readonly referencedFileFailures: readonly ReferencedFileFailure[];
}> {
  const referenced = await readReferencedFilesContext(
    options.prompt,
    options.runtime,
    options.readWorkspaceFile ?? readWorkspaceTextFile,
    options.attachedMentions
  );
  const input: AgentMessage = {
    id: 'context-input',
    parts: [{ text: options.prompt, type: 'text' }],
    role: 'user',
  };
  const messages = await injectActivatedSkillsContext(
    [...(referenced.message ? [referenced.message] : []), input],
    options.workspaceSkills
  );
  const context = joinedSections(
    messages
      .filter((message) => message.role === 'system')
      .map((message) =>
        message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
      )
  );
  return {
    ...(context === undefined ? {} : { context }),
    referencedFileFailures: referenced.failures,
  };
}

/** The repo-supplied context a run's instructions carry, read by every host. */
export interface HostWorkspaceContext {
  /** Each injected context message's text: referenced files, activated skills, instructions, roots. */
  readonly injected: readonly string[];
  readonly referencedFileFailures: readonly ReferencedFileFailure[];
  /** The admitted skills' catalog, when the run has any. */
  readonly skillsCatalog?: string;
}

/**
 * The prompt's referenced files and activated skills, the trusted roots'
 * workspace instructions and the root topology, read through the shared
 * contained readers, plus the admitted skills' catalog.
 */
export async function readHostWorkspaceContext(options: {
  /** BST-2018: mentioned files in live folders outside the thread, attached for this run. */
  readonly attachedMentions?: AttachedMentionFolders;
  /** ADR-0032: the run's roots the person trusted, the only ones whose instructions load. */
  readonly configurationRoots: NonNullable<RuntimeData['workspaceRoots']>;
  readonly prompt: string;
  readonly readWorkspaceFile?: WorkspaceFileReader;
  readonly runtime: RuntimeData;
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}): Promise<HostWorkspaceContext> {
  let skillsCatalog: string | undefined;
  const skills = options.workspaceSkills;
  if (skills) {
    const entries = await Promise.all(
      (await skills.list()).map(async (metadata) => {
        const skill = await skills.get(metadata.path);
        if (!skill) {
          throw new Error('An admitted skill no longer resolves to its captured catalog');
        }
        return {
          description: skill.description,
          location: `${skill.path}/SKILL.md`,
          name: skill.name,
          source: skill.source.type,
        };
      })
    );
    if (entries.length > 0) {
      skillsCatalog = formatSkillsCatalog(entries);
    }
  }
  let messages: AgentMessage[] = [
    {
      // This temporary input is used only by the existing context readers. Its
      // ID is never persisted; HostCore retains the real command/message identity.
      id: 'context-input',
      parts: [{ text: options.prompt, type: 'text' }],
      role: 'user',
    },
  ];
  const readFile = options.readWorkspaceFile ?? readWorkspaceTextFile;
  const referenced = await readReferencedFilesContext(
    options.prompt,
    options.runtime,
    readFile,
    options.attachedMentions
  );
  if (referenced.message) {
    messages = [referenced.message, ...messages];
  }
  messages = await injectActivatedSkillsContext(messages, skills);
  messages = await injectWorkspaceInstructionsContext(
    messages,
    options.runtime,
    readFile,
    options.configurationRoots
  );
  // The legacy per-turn workspace topology: root selectors, main root and focused root.
  messages = injectWorkspaceRootManifestContext(messages, options.runtime);
  return {
    injected: messages
      .filter((message) => message.role === 'system')
      .map((message) =>
        message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
      ),
    referencedFileFailures: referenced.failures,
    ...(skillsCatalog === undefined ? {} : { skillsCatalog }),
  };
}
