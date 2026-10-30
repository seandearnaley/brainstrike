import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { BrowserTypeInputSchema } from '../schemas/schemas-browser.ts';

// BST-2324: fills a field the way Playwright's `fill` does. Credential and
// payment fields are refused (BST-2209).
export const browserType = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 140,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    "Replace a text field's value on your own browser page; submit presses Enter. Passwords, one-time codes, card details and CAPTCHAs fail as blocked_action: those are for the user",
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserType',
  inputSchema: effectToolInputSchema(BrowserTypeInputSchema),
  kind: 'desktop',
  returns: 'The page url and title once any navigation the input started settles',
  surfaces: ['desktop'],
});
