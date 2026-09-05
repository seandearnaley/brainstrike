import {
  DESKTOP_NATIVE_TOOLS,
  type DesktopNativeTool,
  isDesktopNativeToolId,
} from '@brainstrike/assistant-contract/tool-metadata';
import type { z } from 'zod';

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
 * parses with them; every one is wrapped once in `providerCompatibleInputSchema`
 * at its declaration.
 */
export const NATIVE_TOOL_INPUT_SCHEMAS = Object.freeze(
  Object.fromEntries(DESKTOP_NATIVE_TOOLS.map((tool) => [tool.id, tool.inputSchema]))
) as { readonly [Tool in DesktopNativeTool as Tool['id']]: Tool['inputSchema'] };

function formatZodIssue(issue: z.ZodIssue): string {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path);
  const prefix = path.length > 0 ? `${path} ` : '';
  return `${prefix}${issue.message}`;
}

function parseWithSchema(
  schema: z.ZodSchema,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const res = schema.safeParse(params ?? {});
  if (!res.success) {
    return {
      issues: res.error.issues.map((issue) => formatZodIssue(issue)),
      ok: false,
    };
  }
  return { data: res.data, ok: true };
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
