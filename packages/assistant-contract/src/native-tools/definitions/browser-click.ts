import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { BrowserClickInputSchema } from '../schemas/schemas-browser.ts';

// BST-2324: the first browser write. `edit` risk, so each click follows the
// access mode; the BST-2209 hard blocks and the BST-2325 origin rule refuse
// before anything reaches the page.
export const browserClick = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 120,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Click an element on your own browser page. Signing in, paying, CAPTCHAs and purchases fail as blocked_action: those are for the user',
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserClick',
  inputSchema: effectToolInputSchema(BrowserClickInputSchema),
  kind: 'desktop',
  returns: 'The page url and title once any navigation the click started settles',
  surfaces: ['desktop'],
});
