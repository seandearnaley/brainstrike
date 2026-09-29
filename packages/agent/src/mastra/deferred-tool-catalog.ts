import type { ToolsInput } from '@mastra/core/agent';
import { createTool, type Tool } from '@mastra/core/tools';
import { z } from 'zod';
import { createMastraAgentError } from './mastra-agent-error';

export const LIST_AVAILABLE_TOOLS_ID = 'list_available_tools';
const PAGE_SIZE = 50;
const DESCRIPTION_LIMIT = 160;

function summarizeDescription(text: string): {
  description: string;
  descriptionTruncated: boolean;
} {
  let description = '';
  let length = 0;
  for (const point of text) {
    if (length === DESCRIPTION_LIMIT) {
      return { description, descriptionTruncated: true };
    }
    description += point;
    length += 1;
  }
  return { description, descriptionTruncated: false };
}

const catalogInputSchema = z.object({
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe('Start at 0; use nextOffset for subsequent pages with the same prefix.'),
  prefix: z.string().min(1).max(128).optional().describe('Case-insensitive tool name prefix.'),
});

const catalogOutputSchema = z.object({
  catalogTotal: z.number(),
  nextOffset: z.number().nullable(),
  tools: z.array(
    z.object({
      description: z.string(),
      descriptionTruncated: z.boolean(),
      name: z.string(),
    })
  ),
  total: z.number(),
});

/** A per-runtime view of the post-gate catalog, never a second eligibility source. */
export function createDeferredToolCatalog(
  tools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>
): Tool<z.infer<typeof catalogInputSchema>, z.infer<typeof catalogOutputSchema>> {
  const entries = Object.entries(tools)
    .map(([name, tool]) => {
      const originalName = toolNameMap.get(name);
      if (!originalName) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { phase: 'catalog-construction', sanitizedId: name },
          detail: `eligible tool "${name}" is missing its original-name mapping`,
        });
      }
      return {
        ...summarizeDescription('description' in tool ? (tool.description ?? '') : ''),
        name,
        originalName,
      };
    })
    .sort((left, right) => {
      if (left.name < right.name) {
        return -1;
      }
      return left.name > right.name ? 1 : 0;
    });

  return createTool({
    description:
      'List eligible deferred tools, including MCP tools, without loading their schemas. Use for questions about what tools are available. Filter by name prefix (for example linear). Follow nextOffset until null for the complete inventory. To use a listed tool, call load_tool with its exact name first.',
    execute: async ({ prefix, offset = 0 }) => {
      const normalizedPrefix = prefix?.toLowerCase();
      const matches = normalizedPrefix
        ? entries.filter(
            ({ name, originalName }) =>
              name.toLowerCase().startsWith(normalizedPrefix) ||
              originalName.toLowerCase().startsWith(normalizedPrefix)
          )
        : entries;
      if (offset > matches.length) {
        throw createMastraAgentError('mastra_agent_tool_discovery_failure', {
          context: { matchingTotal: matches.length, offset, phase: 'catalog-pagination' },
          detail: 'Tool catalog offset exceeds the matching catalog size. Restart at offset 0.',
        });
      }
      const page = matches.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + page.length;
      return {
        catalogTotal: entries.length,
        nextOffset: nextOffset < matches.length ? nextOffset : null,
        tools: page.map(({ name, description, descriptionTruncated }) => ({
          description,
          descriptionTruncated,
          name,
        })),
        total: matches.length,
      };
    },
    id: LIST_AVAILABLE_TOOLS_ID,
    inputSchema: catalogInputSchema,
    outputSchema: catalogOutputSchema,
  });
}
