/**
 * The browser-pane read tools (BST-1176 PR2) over a caller-supplied runner:
 * Main drives its active pane, the desktop agent host asks Main to, since the
 * pane is window-bound. This module must not import Electron: the host bundle
 * loads it.
 */
import {
  type BrowserGetPageTextInput,
  type BrowserNavigateInput,
  type BrowserReadPageInput,
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
  BrowserGetPageTextResult,
  BrowserNavigateResult,
  BrowserReadPageResult,
} from './browser-agent-tools';

/** The active pane's three reads; every result is structured, never a throw. */
export interface BrowserToolRunner {
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
}

/**
 * Omitted for the built-in local provider (same WebGPU-prefill reasoning as
 * the task-list tool and the plan-mode gate).
 */
export function browserToolExecutors(runner: BrowserToolRunner): {
  readonly [NATIVE_TOOL_ID.browserGetPageText]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.browserNavigate]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.browserReadPage]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.browserGetPageText]: ({ isLocalProvider }) =>
      isLocalProvider
        ? undefined
        : {
            description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserGetPageText],
            execute: (
              input: ToolExecuteInput<BrowserGetPageTextInput>,
              options?: ToolExecuteContext
            ) =>
              runner.getPageText(
                parseToolExecuteInput(
                  NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserGetPageText],
                  input
                ),
                resolveGuardedToolSignal(options)
              ),
            id: NATIVE_TOOL_ID.browserGetPageText,
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserGetPageText],
          },
    [NATIVE_TOOL_ID.browserNavigate]: ({ isLocalProvider }) =>
      isLocalProvider
        ? undefined
        : {
            description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserNavigate],
            execute: (
              input: ToolExecuteInput<BrowserNavigateInput>,
              options?: ToolExecuteContext
            ) =>
              runner.navigate(
                parseToolExecuteInput(
                  NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserNavigate],
                  input
                ),
                resolveGuardedToolSignal(options)
              ),
            id: NATIVE_TOOL_ID.browserNavigate,
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserNavigate],
          },
    [NATIVE_TOOL_ID.browserReadPage]: ({ isLocalProvider }) =>
      isLocalProvider
        ? undefined
        : {
            description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserReadPage],
            execute: (
              input: ToolExecuteInput<BrowserReadPageInput>,
              options?: ToolExecuteContext
            ) =>
              runner.readPage(
                parseToolExecuteInput(
                  NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserReadPage],
                  input
                ),
                resolveGuardedToolSignal(options)
              ),
            id: NATIVE_TOOL_ID.browserReadPage,
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserReadPage],
          },
  };
}
