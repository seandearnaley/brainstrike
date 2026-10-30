/**
 * The browser-pane tools (BST-1176 PR2, BST-2324) over a caller-supplied runner:
 * Main drives its active pane, the desktop agent host asks Main to, since the
 * pane is window-bound. This module must not import Electron: the host bundle
 * loads it.
 */
import {
  type BrowserClickInput,
  type BrowserGetPageTextInput,
  type BrowserNavigateInput,
  type BrowserReadPageInput,
  type BrowserSelectOptionInput,
  type BrowserTypeInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  resolveGuardedToolSignal,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  type NativeToolExecutor,
  parseToolExecuteInput,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import type {
  BrowserActionResult,
  BrowserGetPageTextResult,
  BrowserNavigateResult,
  BrowserReadPageResult,
  BrowserSelectOptionResult,
} from './browser-agent-tools';

/** The active pane's reads and actions; every result is structured, never a throw. */
export interface BrowserToolRunner {
  readonly click: (input: BrowserClickInput, signal?: AbortSignal) => Promise<BrowserActionResult>;
  readonly getPageText: (
    input: BrowserGetPageTextInput,
    signal?: AbortSignal
  ) => Promise<BrowserGetPageTextResult>;
  readonly navigate: (
    input: BrowserNavigateInput,
    signal?: AbortSignal
  ) => Promise<BrowserNavigateResult>;
  readonly readPage: (
    input: BrowserReadPageInput,
    signal?: AbortSignal
  ) => Promise<BrowserReadPageResult>;
  readonly selectOption: (
    input: BrowserSelectOptionInput,
    signal?: AbortSignal
  ) => Promise<BrowserSelectOptionResult>;
  readonly type: (input: BrowserTypeInput, signal?: AbortSignal) => Promise<BrowserActionResult>;
}

export function browserToolExecutors(runner: BrowserToolRunner): {
  readonly [NATIVE_TOOL_ID.browserClick]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.browserGetPageText]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.browserNavigate]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.browserReadPage]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.browserSelectOption]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.browserType]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.browserClick]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserClick],
      execute: (input: ToolExecuteInput<BrowserClickInput>, options?: ToolExecuteContext) =>
        runner.click(
          parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserClick], input),
          resolveGuardedToolSignal(options)
        ),
      id: NATIVE_TOOL_ID.browserClick,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserClick],
    }),
    [NATIVE_TOOL_ID.browserGetPageText]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserGetPageText],
      execute: (input: ToolExecuteInput<BrowserGetPageTextInput>, options?: ToolExecuteContext) =>
        runner.getPageText(
          parseToolExecuteInput(
            NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserGetPageText],
            input
          ),
          resolveGuardedToolSignal(options)
        ),
      id: NATIVE_TOOL_ID.browserGetPageText,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserGetPageText],
    }),
    [NATIVE_TOOL_ID.browserNavigate]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserNavigate],
      execute: (input: ToolExecuteInput<BrowserNavigateInput>, options?: ToolExecuteContext) =>
        runner.navigate(
          parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserNavigate], input),
          resolveGuardedToolSignal(options)
        ),
      id: NATIVE_TOOL_ID.browserNavigate,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserNavigate],
    }),
    [NATIVE_TOOL_ID.browserReadPage]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserReadPage],
      execute: (input: ToolExecuteInput<BrowserReadPageInput>, options?: ToolExecuteContext) =>
        runner.readPage(
          parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserReadPage], input),
          resolveGuardedToolSignal(options)
        ),
      id: NATIVE_TOOL_ID.browserReadPage,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserReadPage],
    }),
    [NATIVE_TOOL_ID.browserSelectOption]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserSelectOption],
      execute: (input: ToolExecuteInput<BrowserSelectOptionInput>, options?: ToolExecuteContext) =>
        runner.selectOption(
          parseToolExecuteInput(
            NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserSelectOption],
            input
          ),
          resolveGuardedToolSignal(options)
        ),
      id: NATIVE_TOOL_ID.browserSelectOption,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserSelectOption],
    }),
    [NATIVE_TOOL_ID.browserType]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserType],
      execute: (input: ToolExecuteInput<BrowserTypeInput>, options?: ToolExecuteContext) =>
        runner.type(
          parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserType], input),
          resolveGuardedToolSignal(options)
        ),
      id: NATIVE_TOOL_ID.browserType,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserType],
    }),
  };
}
