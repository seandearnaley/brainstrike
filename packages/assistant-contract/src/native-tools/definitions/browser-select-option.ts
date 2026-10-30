import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { BrowserSelectOptionInputSchema } from '../schemas/schemas-browser.ts';

// BST-2324: picks options of a <select>, matching Playwright's selectOption.
export const browserSelectOption = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 110,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description: 'Select dropdown options on your own browser page, matching each by value or label',
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserSelectOption',
  inputSchema: effectToolInputSchema(BrowserSelectOptionInputSchema),
  kind: 'desktop',
  returns: 'The selected option values, and the page url and title',
  surfaces: ['desktop'],
});
