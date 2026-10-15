import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { BrowserReadPageInputSchema } from '../schemas/schemas-browser.js';

export const browserReadPage = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 140,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    "Read the browser pane's current page as a compact accessibility tree. Interactive elements carry [ref=eN] handles for later actions; filter 'interactive' returns only actionable elements",
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserReadPage',
  inputSchema: effectToolInputSchema(BrowserReadPageInputSchema),
  kind: 'desktop',
  localProvider: 'unregistered',
  returns: 'Indented role "name" [ref=eN] tree text with a truncated flag',
  surfaces: ['desktop'],
});
