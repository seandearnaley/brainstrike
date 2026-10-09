import type { AgentMessage, RuntimeData, ScannedWorkspaceSkills } from '@brainstrike/agent';
import {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
  filterToolsForPlanMode,
  formatSkillsCatalog,
} from '@brainstrike/agent/tool-runtime';
import {
  type HostRunAdmissionRequest,
  type HostTool,
  hostToolDiscoveryEnabled,
} from '@brainstrike/agent-host';
import { isSupportedProvider, type ToolRiskCategory } from '@brainstrike/assistant-contract';
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

/** Existing readers and public vendor formatting; this creates no transcript or loop. */
export async function readDesktopHostSystemContext(options: {
  readonly inputTokenLimit: number;
  /** Plan mode: the instructions say the run may only read and propose a plan. */
  readonly planMode: boolean;
  readonly readWorkspaceFile?: WorkspaceFileReader;
  readonly request: HostRunAdmissionRequest;
  readonly runtime: RuntimeData;
  readonly tools: Readonly<Record<string, HostTool>>;
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}): Promise<string | undefined> {
  if (options.request.snapshot) {
    // Recovery consumes the already committed text, without re-reading files.
    return z.string().optional().parse(options.request.snapshot.configuration['system']);
  }
  const names = new Map(
    Object.entries(options.tools).map(([name, tool]) => [name, tool.permissionToolId ?? name])
  );
  const sections: (string | null)[] = [
    options.runtime.provider === 'local'
      ? buildLocalDefaultInstructions(names)
      : buildDefaultInstructions(names, {
          planMode: options.planMode,
          // The same gate the admission uses to defer these tools behind discovery.
          toolDiscoveryEnabled:
            isSupportedProvider(options.runtime.provider) &&
            hostToolDiscoveryEnabled({
              modelId: options.request.modelId,
              provider: options.runtime.provider,
              tools: options.tools,
            }),
        }),
    buildCurrentDateNote(new Date()),
    buildContextBudgetNote(options.inputTokenLimit),
  ];
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
  sections.push(
    ...messages
      .filter((message) => message.role === 'system')
      .map((message) =>
        message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
      )
  );
  options.request.signal.throwIfAborted();
  return sections.filter((section): section is string => Boolean(section)).join('\n\n');
}
