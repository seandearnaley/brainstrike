import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import {
  docSummaryExecute,
  docSummaryInputSchema,
  searchDocsExecute,
  searchDocsInputSchema,
} from '../tools/docs-search';

const baseWebTools = {
  // Removed web.echo - was causing agent to unnecessarily route simple responses through a tool
  'web.searchDocs': createTool({
    id: 'web.searchDocs',
    description: 'Searches Brainstrike documentation entries.',
    inputSchema: searchDocsInputSchema,
    execute: async (inputData) => searchDocsExecute(inputData),
  }),
  'web.docSummary': createTool({
    id: 'web.docSummary',
    description: 'Returns a structured summary of a documentation entry.',
    inputSchema: docSummaryInputSchema,
    execute: async (inputData) => docSummaryExecute(inputData),
  }),
};

export const webTools = baseWebTools as ToolsInput;
