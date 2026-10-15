import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { BrowserGetPageTextInputSchema } from '../schemas/schemas-browser.js';

// Browser pane read tools (BST-1176 PR2): riskCategory 'read' like
// webExtract — they fetch/observe web content without mutating workspace
// state. Navigation goes through the pane's scheme gate (isNavigableUrl),
// so file:/devtools:/chrome: can never be reached. Write-actions
// (click/type/form_input) arrive in PR3 as gated 'edit' tools.
export const browserGetPageText = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 100,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    "Read the visible text of the browser pane's current page (active tab), truncated to maxChars",
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserGetPageText',
  inputSchema: effectToolInputSchema(BrowserGetPageTextInputSchema),
  kind: 'desktop',
  localProvider: 'unregistered',
  returns: 'The page body text with a truncated flag',
  surfaces: ['desktop'],
});
