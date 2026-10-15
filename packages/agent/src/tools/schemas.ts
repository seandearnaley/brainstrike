import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import {
  DESKTOP_NATIVE_TOOLS,
  type DesktopNativeTool,
  isDesktopNativeToolId,
} from '@brainstrike/assistant-contract/tool-metadata';

export * from './provider-compatible-input';
export * from './schemas-artifacts';
export * from './schemas-browser';
export * from './schemas-diagnostics';
export * from './schemas-execution';
export * from './schemas-search';
export * from './schemas-tasks';
export * from './schemas-workspace';
export * from './schemas-worktrees';

/**
 * The exact registered input schema per desktop native tool, DERIVED from the
 * `inputSchema` each `defineNativeTool` declaration carries (BST-1646). The
 * desktop registry hands these very objects to Mastra and `validateToolInput`
 * parses with them. Each carries exactly ONE producer's output — the Effect
 * `effectToolInputSchema` or, for the tools not yet converted, the zod
 * `providerCompatibleInputSchema` (ADR-0004, amended 2026-10-15).
 */
export const NATIVE_TOOL_INPUT_SCHEMAS = Object.freeze(
  Object.fromEntries(DESKTOP_NATIVE_TOOLS.map((tool) => [tool.id, tool.inputSchema]))
) as { readonly [Tool in DesktopNativeTool as Tool['id']]: Tool['inputSchema'] };

function parseWithSchema(
  schema: unknown,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const result = validateToolInputValue(schema, params ?? {});
  if (!result.success) {
    return {
      issues: result.issues.map((issue) => {
        const path = issue.path.map(String).join('.');
        return path.length > 0 ? `${path} ${issue.message}` : issue.message;
      }),
      ok: false,
    };
  }
  return { data: result.value, ok: true };
}

export function validateToolInput(
  name: string,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  try {
    const schema = isDesktopNativeToolId(name) ? NATIVE_TOOL_INPUT_SCHEMAS[name] : undefined;
    if (schema) {
      return parseWithSchema(schema, params);
    }
    // Only canonical BrainStrike-native tool IDs are validated here.
    // Runtime-discovered MCP tools must keep their server-provided names and are
    // forwarded without local aliasing or fallback validation.
    return { data: params ?? {}, ok: true };
  } catch (err) {
    return { issues: [err instanceof Error ? err.message : String(err)], ok: false };
  }
}
