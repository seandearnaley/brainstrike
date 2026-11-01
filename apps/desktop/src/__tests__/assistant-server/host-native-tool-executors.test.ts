import type { RuntimeData } from '@brainstrike/agent';
import { DESKTOP_NATIVE_TOOL_IDS, SKILL_NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract';
import { SHARED_NATIVE_TOOL_EXECUTORS } from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';
import {
  desktopHostToolExecutors,
  type HostAppPaths,
  isHostExecutedNativeToolId,
} from '../../agent-host-platform/host-executed-tools';
import { nativeRuntimeFor, unexpectedMainRequest } from './_host-native-tools';

const runtime: RuntimeData = {};
/** A launching desktop's facts: with them the host builds run_python and runSkillScript. */
const APP_PATHS: HostAppPaths = {
  isPackaged: true,
  resourcesPath: '/resources',
  userDataPath: '/user-data',
};
/** Main admitted skills for the run: with them the host builds runSkillScript. */
const NATIVE_WITH_SKILLS = nativeRuntimeFor(runtime, { skills: [] });

/**
 * The host's executor fold is the adapter half of the native-tool contract:
 * every `brainstrike.*` definition a desktop run can admit is executed by the
 * agent host and has exactly one executor there (shared or Desktop's own), so
 * no admitted descriptor can reach a host without a way to run it.
 */
describe('host-executed native tools', () => {
  it('has exactly one host executor per desktop catalog id, beside the skill tools', () => {
    const executors = {
      ...SHARED_NATIVE_TOOL_EXECUTORS,
      ...desktopHostToolExecutors(
        unexpectedMainRequest,
        {},
        'host-thread',
        NATIVE_WITH_SKILLS,
        APP_PATHS
      ),
    };
    expect(Object.keys(executors).sort()).toEqual(
      [...DESKTOP_NATIVE_TOOL_IDS, ...SKILL_NATIVE_TOOL_IDS].sort()
    );
    for (const toolId of DESKTOP_NATIVE_TOOL_IDS) {
      expect(isHostExecutedNativeToolId(toolId), toolId).toBe(true);
      expect(typeof (executors as Record<string, unknown>)[toolId], toolId).toBe('function');
    }
  });
});
