import type { RuntimeData } from '@brainstrike/agent';
import {
  DESKTOP_NATIVE_TOOL_IDS,
  LOCAL_DESKTOP_NATIVE_TOOL_IDS,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import {
  addLogListener,
  configureLogger,
  LogLevel,
  type LogRecord,
  resetLogger,
} from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDesktopAssistantTools,
  type DesktopAssistantToolDependencies,
} from '../../assistant-server/assistant-tools';
import { NATIVE_TOOL_EXECUTORS } from '../../assistant-server/native-tool-executors';

vi.mock('../../db-main', () => ({ getDatabase: vi.fn() }));

const unavailableMessage = 'Enabled native tool ids unavailable in the current runtime';
let records: LogRecord[];
let stop: () => void;

beforeEach(() => {
  // The production default is INFO: a debug-only diagnostic is invisible here.
  configureLogger({ console: false, level: LogLevel.INFO });
  records = [];
  stop = addLogListener((record) => {
    if (record.scope === 'DesktopAssistantTools') {
      records.push(record);
    }
  });
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
  resetLogger();
});

function expectUnavailable(toolIds: readonly string[]): void {
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    level: LogLevel.WARN,
    message: unavailableMessage,
  });
  expect(records[0]?.args).toEqual([
    unavailableMessage,
    { code: 'enabled_native_tools_unavailable', toolIds },
  ]);
}

describe('desktop enabled native-tool availability diagnostics', () => {
  it.each(['openai', 'local'])(
    'warns at default logging level when a %s runtime unexpectedly omits an enabled tool',
    (provider) => {
      expect(LOCAL_DESKTOP_NATIVE_TOOL_IDS).toContain(NATIVE_TOOL_ID.readWorkspaceFile);
      vi.spyOn(NATIVE_TOOL_EXECUTORS, NATIVE_TOOL_ID.readWorkspaceFile).mockReturnValue(undefined);
      const tools = buildDesktopAssistantTools({
        enabledNativeToolIds: [
          NATIVE_TOOL_ID.executeCommand,
          NATIVE_TOOL_ID.readWorkspaceFile,
          NATIVE_TOOL_ID.readWorkspaceFile,
          NATIVE_TOOL_ID.runSkillScript,
          NATIVE_TOOL_ID.readToolOutputArtifact,
        ],
        provider,
        providerOptions: { openai: { apiKey: 'private-runtime-fixture' } },
        workspaceRoots: [{ displayName: 'Private fixture', path: '/private/path', rootId: 'root' }],
      } as RuntimeData);

      expect(Object.keys(tools)).toEqual([NATIVE_TOOL_ID.executeCommand]);
      expectUnavailable([NATIVE_TOOL_ID.readWorkspaceFile]);
      expect(JSON.stringify(records)).not.toContain('private-runtime-fixture');
      expect(JSON.stringify(records)).not.toContain('/private/path');
    }
  );

  it('does not warn for available enabled tools or intentionally disabled tools', () => {
    vi.spyOn(NATIVE_TOOL_EXECUTORS, NATIVE_TOOL_ID.readWorkspaceFile).mockReturnValue(undefined);
    const tools = buildDesktopAssistantTools({
      enabledNativeToolIds: [NATIVE_TOOL_ID.executeCommand],
      provider: 'openai',
    } as RuntimeData);

    expect(Object.keys(tools)).toEqual([NATIVE_TOOL_ID.executeCommand]);
    expect(records).toEqual([]);
  });

  it('does not flood diagnostics when optional skill and artifact capabilities are absent', () => {
    const tools = buildDesktopAssistantTools({
      enabledNativeToolIds: DESKTOP_NATIVE_TOOL_IDS,
      provider: 'openai',
    } as RuntimeData);

    expect(tools[NATIVE_TOOL_ID.runSkillScript]).toBeUndefined();
    expect(tools[NATIVE_TOOL_ID.readToolOutputArtifact]).toBeUndefined();
    expect(tools[NATIVE_TOOL_ID.runPython]).toBeDefined();
    expect(records).toEqual([]);
  });

  it.each([
    { enabledNativeToolIds: DESKTOP_NATIVE_TOOL_IDS, source: 'raw desktop preferences' },
    { enabledNativeToolIds: LOCAL_DESKTOP_NATIVE_TOOL_IDS, source: 'advertised local catalog' },
  ])(
    'keeps expected local-provider capability filtering silent for $source',
    ({ enabledNativeToolIds }) => {
      // The UI already sends the local catalog. A raw client's broader
      // preference list must not turn its expected capability gates into faults.
      const tools = buildDesktopAssistantTools({
        enabledNativeToolIds,
        provider: 'local',
      } as RuntimeData);

      expect(tools[NATIVE_TOOL_ID.executeCommand]).toBeDefined();
      expect(tools[NATIVE_TOOL_ID.askUser]).toBeUndefined();
      expect(tools[NATIVE_TOOL_ID.runPython]).toBeUndefined();
      expect(records).toEqual([]);
    }
  );

  it('still warns for missing skill and artifact tools when their capabilities are present', () => {
    const dependencies: DesktopAssistantToolDependencies = {
      skillScriptResolver: {
        resolveScriptExecution: vi.fn(() => {
          throw new Error('Not executed while building tools');
        }),
      },
      toolOutputArtifactReader: {
        readRange: vi.fn(() => {
          throw new Error('Not executed while building tools');
        }),
      },
    };
    const enabledNativeToolIds = [
      NATIVE_TOOL_ID.runSkillScript,
      NATIVE_TOOL_ID.readToolOutputArtifact,
    ];
    const runtimeData = { enabledNativeToolIds, provider: 'openai' } as RuntimeData;
    const available = buildDesktopAssistantTools(runtimeData, dependencies);
    expect(Object.keys(available).sort()).toEqual([...enabledNativeToolIds].sort());
    expect(records).toEqual([]);

    for (const toolId of enabledNativeToolIds) {
      vi.spyOn(NATIVE_TOOL_EXECUTORS, toolId).mockReturnValue(undefined);
    }
    expect(buildDesktopAssistantTools(runtimeData, dependencies)).toEqual({});
    expectUnavailable(enabledNativeToolIds);
    expect(dependencies.skillScriptResolver?.resolveScriptExecution).not.toHaveBeenCalled();
    expect(dependencies.toolOutputArtifactReader?.readRange).not.toHaveBeenCalled();
  });

  it('does not mask a missing hosted Python registration as a sandbox configuration issue', () => {
    vi.spyOn(NATIVE_TOOL_EXECUTORS, NATIVE_TOOL_ID.runPython).mockReturnValue(undefined);
    buildDesktopAssistantTools({
      enabledNativeToolIds: [NATIVE_TOOL_ID.runPython],
      provider: 'openai',
    } as RuntimeData);
    expectUnavailable([NATIVE_TOOL_ID.runPython]);
  });

  it('rejects unknown IDs without putting untrusted values into availability diagnostics', () => {
    expect(() =>
      buildDesktopAssistantTools({
        enabledNativeToolIds: [NATIVE_TOOL_ID.executeCommand, 'private-unknown-fixture'],
        provider: 'openai',
      } as RuntimeData)
    ).toThrow('Enabled native tool preferences contain unknown tool IDs.');
    expect(records).toEqual([]);
  });
});
