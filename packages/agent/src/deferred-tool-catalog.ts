import { HOST_META_TOOL_ID } from '@brainstrike/assistant-contract';
import { standardInputSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import { Schema } from 'effect';
import type { HostToolDefinition } from './host-tool-definition';
import { createMastraAgentError } from './mastra-boundary/mastra-agent-error';

export const LIST_AVAILABLE_TOOLS_ID = HOST_META_TOOL_ID.listAvailableTools;
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

const catalogInputSchema = Schema.Struct({
  offset: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
    )
  ).annotate({
    description: 'Start at 0; use nextOffset for subsequent pages with the same prefix.',
  }),
  prefix: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(128))
  ).annotate({ description: 'Case-insensitive tool name prefix.' }),
});

const catalogOutputSchema = Schema.Struct({
  catalogTotal: Schema.Finite,
  nextOffset: Schema.NullOr(Schema.Finite),
  tools: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        description: Schema.String,
        descriptionTruncated: Schema.Boolean,
        name: Schema.String,
      })
    )
  ),
  total: Schema.Finite,
});

/** A per-runtime view of the post-gate catalog, never a second eligibility source. */
export function createDeferredToolCatalog(
  tools: Readonly<Record<string, object>>,
  toolNameMap: ReadonlyMap<string, string>
) {
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
        ...summarizeDescription(
          'description' in tool && typeof tool.description === 'string' ? tool.description : ''
        ),
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

  return {
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
    inputSchema: standardInputSchema(catalogInputSchema, {
      jsonSchemaOnExcessProperty: 'error',
      onExcessProperty: 'ignore',
    }),
  } satisfies HostToolDefinition<
    (typeof catalogInputSchema)['Type'],
    (typeof catalogOutputSchema)['Type']
  >;
}
