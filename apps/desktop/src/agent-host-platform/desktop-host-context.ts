import type { AgentMessage, RuntimeData, ScannedWorkspaceSkills } from '@brainstrike/agent';
import {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
  formatSkillsCatalog,
} from '@brainstrike/agent/tool-runtime';
import type { HostRunAdmissionRequest, HostTool } from '@brainstrike/agent-host';
import { z } from 'zod';
import { injectReferencedFilesContext } from '../assistant-server/referenced-files-context';
import { injectActivatedSkillsContext } from '../assistant-server/skills-activation-context';
import { injectWorkspaceInstructionsContext } from '../assistant-server/workspace-instructions-context';
import { readWorkspaceTextFile } from '../assistant-server/workspace-text-file-reader';

/** Existing readers and public vendor formatting; this creates no transcript or loop. */
export async function readDesktopHostSystemContext(options: {
  readonly inputTokenLimit: number;
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
      : buildDefaultInstructions(names),
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
  messages = await injectReferencedFilesContext(messages, options.runtime, readWorkspaceTextFile);
  messages = await injectActivatedSkillsContext(messages, skills);
  messages = await injectWorkspaceInstructionsContext(
    messages,
    options.runtime,
    readWorkspaceTextFile
  );
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
