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
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/workspace-text-file-reader';
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import {
  type AttachedMentionFolders,
  readReferencedFilesContext,
} from '../assistant-server/referenced-files-context';
import { injectActivatedSkillsContext } from '../assistant-server/skills-activation-context';
import { injectWorkspaceInstructionsContext } from '../assistant-server/workspace-instructions-context';

const planModeLogger = createLogger('DesktopHostPlanMode');

/** Plan mode keeps what reads (and MCP), the shipped plan-mode gate's rule. */
export function desktopPlanModeTools<
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
export interface DesktopHostSystemContext {
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
export async function readDesktopHostSystemContext(options: {
  /** BST-2018: mentioned files in live folders outside the thread, attached for this run. */
  readonly attachedMentions?: AttachedMentionFolders;
  readonly inputTokenLimit: number;
  /** BST-1932: the personas the run may delegate to, named in the supervisor instructions. */
  readonly personas?: readonly DelegationPersonaSummary[];
  /** Plan mode: the instructions say the run may only read and propose a plan. */
  readonly planMode: boolean;
  readonly readWorkspaceFile?: WorkspaceFileReader;
  readonly request: HostRunIntentRequest;
  readonly runtime: RuntimeData;
  /** The admitted tools by provider name; the instructions name each by its catalog id. */
  readonly tools: Readonly<
    Record<string, { readonly description: string; readonly permissionToolId?: string }>
  >;
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}): Promise<DesktopHostSystemContext> {
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
      sections.push(formatSkillsCatalog(entries));
      shared.push(formatSkillsCatalog(entries));
    }
  }
  let messages: AgentMessage[] = [
    {
      // This temporary input is used only by the existing context readers. Its
      // ID is never persisted; HostCore retains the real command/message identity.
      id: 'context-input',
      parts: [{ text: options.request.prompt ?? '', type: 'text' }],
      role: 'user',
    },
  ];
  const readFile = options.readWorkspaceFile ?? readWorkspaceTextFile;
  const referenced = await readReferencedFilesContext(
    options.request.prompt ?? '',
    options.runtime,
    readFile,
    options.attachedMentions
  );
  if (referenced.message) {
    messages = [referenced.message, ...messages];
  }
  messages = await injectActivatedSkillsContext(messages, skills);
  messages = await injectWorkspaceInstructionsContext(messages, options.runtime, readFile);
  // The legacy per-turn workspace topology: root selectors, main root and focused root.
  messages = injectWorkspaceRootManifestContext(messages, options.runtime);
  const injected = messages
    .filter((message) => message.role === 'system')
    .map((message) =>
      message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
    );
  options.request.signal.throwIfAborted();
  const system = joinedSections([...sections, ...injected]);
  const childSystem = options.personas?.length
    ? joinedSections([...shared, ...injected])
    : undefined;
  return {
    ...(referenced.failures.length ? { referencedFileFailures: referenced.failures } : {}),
    ...(childSystem === undefined ? {} : { childSystem }),
    ...(system === undefined ? {} : { system }),
  };
}
