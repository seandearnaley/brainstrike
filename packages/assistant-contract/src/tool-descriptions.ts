import { isNativeToolId, type NativeToolId } from './native-tool-catalog.js';
import { NATIVE_TOOL_REGISTRIES } from './native-tools/index.js';

/**
 * Model-facing description per native tool, DERIVED from each tool's
 * `defineNativeTool` declaration — the ONE prose source for the provider
 * payload and the settings inspector alike.
 */
export const TOOL_DESCRIPTIONS: Record<NativeToolId, string> = NATIVE_TOOL_REGISTRIES.descriptions;

export function getNativeToolDescription(toolId: string): string | undefined {
  return isNativeToolId(toolId) ? TOOL_DESCRIPTIONS[toolId] : undefined;
}
