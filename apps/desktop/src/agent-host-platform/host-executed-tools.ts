import {
  isSharedNativeToolId,
  type NativeToolExecutor,
} from '@brainstrike/host-capabilities/native-tools';
import { INSPECTION_TOOL_EXECUTORS } from '../assistant-server/native-tool-executors-inspection';

/**
 * Desktop tools the agent host runs in its own process beside the shared ones.
 * Main admits them but never executes them for a host thread.
 */
export const DESKTOP_HOST_TOOL_EXECUTORS: Readonly<Record<string, NativeToolExecutor>> = {
  ...INSPECTION_TOOL_EXECUTORS,
};

export function isHostExecutedNativeToolId(id: string): boolean {
  return isSharedNativeToolId(id) || Object.hasOwn(DESKTOP_HOST_TOOL_EXECUTORS, id);
}
