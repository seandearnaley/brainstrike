import type { AgentMessage, RuntimeData, ScannedWorkspaceSkills } from '@brainstrike/agent';
import {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
  type DelegationPersonaSummary,
  filterToolsForPlanMode,
  formatSkillsCatalog,
} from '@brainstrike/agent/tool-runtime';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import type { ToolRiskCategory } from '@brainstrike/assistant-contract';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/stream-init';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { injectReferencedFilesContext } from '../assistant-server/referenced-files-context';
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
  readonly system?: string | undefined;
}

function joinedSections(sections: readonly (string | null | undefined)[]): string | undefined {
  const text = sections.filter((section): section is string => Boolean(section)).join('\n\n');
  return text || undefined;
}

/** Existing readers and public vendor formatting; this creates no transcript or loop. */
export async function readDesktopHostSystemContext(options: {
  readonly inputTokenLimit: number;
  /** BST-1932: the personas the run may delegate to, named in the supervisor instructions. */
  readonly personas?: readonly DelegationPersonaSummary[];
  /** Plan mode: the instructions say the run may only read and propose a plan. */
  readonly planMode: boolean;
  readonly readWorkspaceFile?: WorkspaceFileReader;
  readonly request: HostRunAdmissionRequest;
  readonly runtime: RuntimeData;
  /** The admitted tools by provider name; the instructions name each by its catalog id. */
  readonly tools: Readonly<Record<string, { readonly permissionToolId?: string }>>;
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}): Promise<DesktopHostSystemContext> {
  if (options.request.snapshot) {
    // Recovery (and a wake) consumes the already committed text, without re-reading files.
    const committed = options.request.snapshot.configuration;
    const system = z.string().optional().parse(committed['system']);
    const childSystem = z.string().optional().parse(committed['childSystem']);
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
    options.runtime.provider === 'local'
      ? buildLocalDefaultInstructions(names)
      : buildDefaultInstructions(names, {
          planMode: options.planMode,
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
  messages = await injectReferencedFilesContext(messages, options.runtime, readFile);
  messages = await injectActivatedSkillsContext(messages, skills);
  messages = await injectWorkspaceInstructionsContext(messages, options.runtime, readFile);
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
    ...(childSystem === undefined ? {} : { childSystem }),
    ...(system === undefined ? {} : { system }),
  };
}
