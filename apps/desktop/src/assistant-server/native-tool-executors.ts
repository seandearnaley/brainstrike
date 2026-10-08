/**
 * The exhaustive desktop executor map (BST-1646 step c): one entry per
 * `brainstrike.*` definition in `NATIVE_TOOLS`, keyed by id.
 *
 * `NativeToolExecutorMap` is a mapped type over the catalog, so this
 * assembly fails to compile when a definition has no executor entry or an
 * entry names an id no definition declares. `buildDesktopAssistantTools`
 * folds the catalog through this map; nothing else enumerates tools.
 */
import { SHARED_NATIVE_TOOL_EXECUTORS } from '@brainstrike/host-capabilities/native-tools';
import type { NativeToolExecutorMap } from './native-tool-executor-context';
import { EXECUTION_TOOL_EXECUTORS } from './native-tool-executors-execution';
import { SEARCH_TOOL_EXECUTORS } from './native-tool-executors-search';
import { WORKSPACE_TOOL_EXECUTORS } from './native-tool-executors-workspace';

export const NATIVE_TOOL_EXECUTORS: NativeToolExecutorMap = {
  ...EXECUTION_TOOL_EXECUTORS,
  ...SEARCH_TOOL_EXECUTORS,
  ...SHARED_NATIVE_TOOL_EXECUTORS,
  ...WORKSPACE_TOOL_EXECUTORS,
};

export type {
  DesktopToolBuildContext,
  NativeToolExecutor,
  NativeToolExecutorMap,
} from './native-tool-executor-context';
