/**
 * The Agent Skills tools over a caller-supplied engine: activation and reads
 * (`skill`, `skill_read`, `skill_search`) and `runSkillScript`. Main binds its
 * request scan; the desktop agent host binds the skills Main admitted for the
 * run and reads their files itself. This module must not import Electron: the
 * host bundle loads it.
 */
import {
  createAssistantSkillTools,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RunSkillScriptInput,
  resolveGuardedToolSignal,
  type ScannedWorkspaceSkills,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  type NativeToolExecutor,
  parseToolExecuteInput,
  resolveShellOutputStreamer,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { runSkillScript } from './run-skill-script-tool';

/** `skill`, `skill_read` and `skill_search` over one engine. */
export function skillToolExecutors(
  skills: ScannedWorkspaceSkills
): Readonly<Record<'skill' | 'skill_read' | 'skill_search', NativeToolExecutor>> {
  const tools = createAssistantSkillTools(skills);
  return {
    skill: () => tools.skill,
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_read: () => tools.skill_read,
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_search: () => tools.skill_search,
  };
}

export function runSkillScriptExecutor(
  skillScriptResolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> | undefined,
  resolvePythonExecutable: (signal?: AbortSignal) => Promise<string>
): NativeToolExecutor {
  // Skill execution is capability-gated by the trusted per-request scan
  // engine: no resolver, no tool (the enabled-id filter in assistant-tools.ts
  // treats that omission as the explicit capability result).
  return ({ runtimeData }) => {
    if (!skillScriptResolver) {
      return;
    }
    return {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.runSkillScript],
      execute: async (
        input: ToolExecuteInput<RunSkillScriptInput>,
        options?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
          input
        );
        const stream = resolveShellOutputStreamer(options, (error) => {
          logToolFailure('runSkillScript output streaming failed', error, resolvedInput);
        });
        try {
          return await runSkillScript(resolvedInput, runtimeData, skillScriptResolver, {
            resolvePythonExecutable,
            signal: resolveGuardedToolSignal(options),
            ...(stream ? { stream } : {}),
          });
        } catch (error) {
          logToolFailure('runSkillScript failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.runSkillScript,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
    };
  };
}
