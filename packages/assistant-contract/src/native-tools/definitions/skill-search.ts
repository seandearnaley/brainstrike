import { Schema } from 'effect';
import { defineNativeTool } from '../define.js';
import { standardInputSchema } from '../schemas/standard-input-schema.js';

// Agent Skills tool (https://agentskills.io) — see `skill.ts` for the shared
// rationale: Mastra's own canonical id, folded into the runtime tool map
// before the pipeline, READ-ONLY, explicit 'read' risk. Its output is a
// disposable search-result list (like grepSearch), so it is recency-prunable.
export const skillSearch = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 110,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Search across installed skill instructions and reference files by keyword; returns matching skills, sources, and line-scoped snippets. Read-only',
  discovery: { namespace: 'skills' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    query: 'The search query.',
    skillNames: 'Optional list of skill names to search within.',
    topK: 'Maximum number of results to return (default 5).',
  },
  history: { recencyPrunable: true },
  id: 'skill_search',
  // Mastra's prior skill inputs advertised closed objects while stripping extras.
  // Preserve both policies; execution stays with Mastra.
  inputSchema: standardInputSchema(
    Schema.Struct({
      query: Schema.String,
      skillNames: Schema.optionalKey(Schema.Array(Schema.String)),
      topK: Schema.optionalKey(Schema.Finite),
    }),
    { jsonSchemaOnExcessProperty: 'error', onExcessProperty: 'ignore' }
  ),
  kind: 'skill',
  providerDescription: 'Search skill content.',
  returns:
    'Matching snippets labeled with their skill, source file, line range, and relevance score.',
});
