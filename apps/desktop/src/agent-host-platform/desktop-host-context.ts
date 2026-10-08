import type { AgentMessage, RuntimeData, ScannedWorkspaceSkills } from '@brainstrike/agent';
import {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
  type DelegationPersonaSummary,
  formatSkillsCatalog,
} from '@brainstrike/agent/tool-runtime';
import type { HostRunAdmissionRequest, HostTool } from '@brainstrike/agent-host';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/stream-init';
import { z } from 'zod';
import { injectReferencedFilesContext } from '../assistant-server/referenced-files-context';
import { injectActivatedSkillsContext } from '../assistant-server/skills-activation-context';
import { injectWorkspaceInstructionsContext } from '../assistant-server/workspace-instructions-context';
import { readWorkspaceTextFile } from '../assistant-server/workspace-text-file-reader';

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
  readonly readWorkspaceFile?: WorkspaceFileReader;
  readonly request: HostRunAdmissionRequest;
  readonly runtime: RuntimeData;
  readonly tools: Readonly<Record<string, HostTool>>;
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}): Promise<DesktopHostSystemContext> {
  if (options.request.snapshot) {
    // Recovery consumes the already committed text, without re-reading files.
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
      : buildDefaultInstructions(
          names,
          options.personas?.length ? { backgroundDelegation: true, personas: options.personas } : {}
        ),
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
